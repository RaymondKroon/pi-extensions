import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type AgentSession
} from '@earendil-works/pi-coding-agent';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end tests for the Ralph loop extension against a REAL pi agent
 * session. The LLM endpoint is mocked with a local OpenAI-compatible HTTP
 * server that serves scripted streaming responses, so the full pi pipeline
 * runs for real: prompt delivery, tool execution, agent_settled events,
 * follow-up messages, and context-boundary filtering. The mock endpoint's
 * request log is the source of truth for what the model actually received.
 *
 * Note on trigger semantics: the extension evaluates the context threshold on
 * `message_update` (mid-turn — it steers the checkpoint into the running turn)
 * and on `agent_settled` (end of turn — it queues the checkpoint as a follow-up).
 * Every rotation first runs a dedicated progress-recording turn (context
 * checkpoint or completion record) before the fresh iteration starts. An
 * aborted run (Escape) always pauses the loop immediately — no re-sent
 * recording prompt, no queued rotation, no fresh iteration — until
 * `/ralph resume` continues it.
 */

const RALPH_EXTENSION = resolve(import.meta.dirname, 'index.ts');

const RALPH_V1 = `# ralph v2

T 1 - "Task one"

T 2 - "Task two"

T 3 - "Task three"
`;

const RALPH_V2_TASK_ONE_DONE = `# ralph v2

T 1 - "Task one"
D 1

T 2 - "Task two"

T 3 - "Task three"
`;

const BLOB_MARKER = 'RALPH-E2E-BLOB';

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

interface RecordedRequest {
	url: string;
	body: {
		model?: string;
		messages?: Array<{ role: string; content?: unknown; [key: string]: unknown }>;
		[key: string]: unknown;
	};
}

type ScriptedResponder = (body: RecordedRequest['body']) => string[];

function dataLine(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function textResponder(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): ScriptedResponder {
	const promptTokens = usage?.prompt_tokens ?? 100;
	const completionTokens = usage?.completion_tokens ?? 10;
	return () => [
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [{ index: 0, delta: { role: 'assistant', content: text } }]
		}),
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens
			}
		}),
		'data: [DONE]\n\n'
	];
}

function writeToolCallResponder(todoPath: string, content: string, usage?: { prompt_tokens: number; completion_tokens: number }): ScriptedResponder {
	const promptTokens = usage?.prompt_tokens ?? 100;
	const completionTokens = usage?.completion_tokens ?? 10;
	const argsJson = JSON.stringify({ path: todoPath, content });
	const [first, second] = [argsJson.slice(0, 32), argsJson.slice(32)];
	return () => [
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [
				{
					index: 0,
					delta: {
						role: 'assistant',
						content: null,
						tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'write', arguments: '' } }]
					}
				}
			]
		}),
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: first } }] } }]
		}),
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: second } }] } }]
		}),
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens
			}
		}),
		'data: [DONE]\n\n'
	];
}

function startMockEndpoint(script: ScriptedResponder[], fallback?: ScriptedResponder, fallbackDelayMs = 0) {
	const requests: RecordedRequest[] = [];
	let nextResponder = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const body = (await req.json()) as RecordedRequest['body'];
			requests.push({ url: req.url, body });
			const usesFallback = nextResponder >= script.length;
			const responder = script[nextResponder++] ?? fallback ?? textResponder('Done.');
			const lines = responder(body);
			return new Response(
				(async function* () {
					// Slow fallback responses down so tests can abort mid-stream.
					if (usesFallback && fallbackDelayMs > 0) {
						await new Promise((r) => setTimeout(r, fallbackDelayMs));
					}
					for (const line of lines) yield line;
				})(),
				{ headers: { 'content-type': 'text/event-stream' } }
			);
		}
	});
	return { server, requests, port: server.port };
}

// ---------------------------------------------------------------------------
// Session harness
// ---------------------------------------------------------------------------

let projectDir: string;
let agentDir: string;
let session: AgentSession | undefined;
let endpoint: ReturnType<typeof startMockEndpoint> | undefined;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), 'ralph-e2e-proj-'));
	agentDir = await mkdtemp(join(tmpdir(), 'ralph-e2e-agent-'));
	await mkdir(join(agentDir, 'extensions'), { recursive: true });
	await writeFile(join(projectDir, 'SPEC.md'), '# Spec\n\nBuild the thing.\n');
	await writeFile(join(projectDir, 'TODO.ralph'), RALPH_V1);
	await mkdir(join(projectDir, '.pi'), { recursive: true });
});

afterEach(async () => {
	session?.dispose();
	session = undefined;
	endpoint?.server.stop(true);
	endpoint = undefined;
	await rm(projectDir, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
});

async function createRalphSession(port: number, config: Record<string, unknown>) {
	await writeFile(join(projectDir, '.pi', 'ralph-loop.json'), `${JSON.stringify(config, null, '\t')}\n`);

	const loader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		additionalExtensionPaths: [RALPH_EXTENSION],
		extensionFactories: [
			(pi) => {
				pi.registerProvider('ralph-mock', {
					name: 'Ralph Mock',
					baseUrl: `http://127.0.0.1:${port}/v1`,
					apiKey: 'test-key',
					api: 'openai-completions',
					models: [
						{
							id: 'mock',
							name: 'Mock',
							reasoning: false,
							input: ['text'],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 20000,
							maxTokens: 4000
						}
					]
				});
			}
		]
	});
	await loader.reload();

	const model = {
		id: 'mock',
		name: 'Mock',
		api: 'openai-completions',
		provider: 'ralph-mock',
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 20000,
		maxTokens: 4000
	};

	const modelRuntime = await ModelRuntime.create();
	const created = await createAgentSession({
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		cwd: projectDir
	});
	// Pi's interactive/rpc modes call this during startup; a bare SDK session must
	// bind extensions itself or they never receive session_start (and the ralph
	// extension would never load its .pi/ralph-loop.json config).
	await created.session.bindExtensions({});
	session = created.session;
	return created.session;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function requestText(request: RecordedRequest): string {
	return JSON.stringify(request.body.messages ?? []);
}

/** Text of the LAST user message of a request body — what newly triggered it. */
function lastUserText(body: RecordedRequest['body']): string {
	const messages = body.messages ?? [];
	const lastUser = [...messages].reverse().find((m) => m.role === 'user');
	const content = lastUser?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
			.join(' ');
	}
	return '';
}

async function waitForRequestContaining(text: string, timeoutMs = 30000): Promise<string> {
	await waitFor(
		() => endpoint?.requests.some((r) => requestText(r).includes(text)),
		`request containing ${JSON.stringify(text)}`,
		timeoutMs
	);
	const request = endpoint!.requests.find((r) => requestText(r).includes(text))!;
	return requestText(request);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ralph-loop end-to-end (mocked LLM endpoint)', () => {
	test(
		'context-limit: work turn above threshold checkpoints, then a fresh iteration runs with a clean context',
		{ timeout: 60000 },
		async () => {
			// pi derives the context-usage percent from the last assistant response's
			// reported usage, so the mock controls it deterministically: 2300 of a
			// 20k window is 11.5%, above the 10% threshold.
			endpoint = startMockEndpoint([
				textResponder(`${BLOB_MARKER} work output. `.repeat(400), { prompt_tokens: 1500, completion_tokens: 800 }),
				textResponder('Checkpoint recorded in TODO.ralph.'),
				textResponder('Continuing from the checkpoint.')
			]);
			const sess = await createRalphSession(endpoint.port, {
				contextThresholds: { __default__: 0.1 },
				autoApproveDecisions: false,
				maxIterations: 10
			});

			await sess.prompt('/ralph start');

			// Iteration 1 runs against the real pipeline.
			await waitFor(() => (endpoint!.requests.length >= 1), 'iteration 1 request');
			expect(requestText(endpoint!.requests[0]!)).toContain('Run the Ralph loop');

			// The turn settles above the threshold: the extension must deliver the
			// durable-checkpoint prompt as the next model request.
			await waitFor(() => endpoint!.requests.length >= 2, 30000);
			expect(requestText(endpoint!.requests[1]!)).toContain('durable checkpoint');

			// The checkpoint turn settles: a fresh iteration starts, and the
			// context-boundary filter must keep the old work turn out of the
			// model's context.
			await waitFor(() => endpoint!.requests.length >= 3, 30000);
			const freshRequest = endpoint!.requests[2]!;
			expect(requestText(freshRequest)).toContain('context budget');
			expect(requestText(freshRequest)).not.toContain(BLOB_MARKER);

			// The boundary marker is recorded in the session itself.
			await waitFor(
				() =>
					sess.messages.some(
						(message) => message.role === 'custom' && (message as { customType?: string }).customType === 'ralph-loop-context-boundary'
					),
				'context boundary message'
			);
		}
	);

	test(
		'completed-task: a turn that checks off a TODO item via the real write tool starts the next iteration',
		{ timeout: 60000 },
		async () => {
			const todoPath = join(projectDir, 'TODO.ralph');
			endpoint = startMockEndpoint([
				writeToolCallResponder(todoPath, RALPH_V2_TASK_ONE_DONE),
				textResponder('Task one complete.'),
				// The dedicated progress-recording turn.
				textResponder('Progress recorded.'),
				// The fresh iteration.
				textResponder('Working on task two.')
			]);
			const sess = await createRalphSession(endpoint.port, {
				contextThresholds: { __default__: 0.9 },
				autoApproveDecisions: false,
				maxIterations: 10
			});

			await sess.prompt('/ralph start');

			// Iteration 1: the mock model calls the real write tool, which really
			// updates TODO.ralph on disk.
			await waitFor(() => endpoint!.requests.length >= 2, 30000);
			const todoOnDisk = await readFile(todoPath, 'utf8');
			expect(todoOnDisk).toContain('D 1');

			// A dedicated recording turn (completion log + commit) runs before the
			// fresh iteration — it is not the iteration prompt.
			await waitFor(() => endpoint!.requests.length >= 3, 30000);
			const recordingRequest = endpoint!.requests[2]!;
			expect(requestText(recordingRequest)).toContain('completion log');
			expect(requestText(recordingRequest)).not.toContain('Start the next independent iteration');

			// Only after the recording turn settles does the fresh iteration start,
			// with a clean context.
			await waitFor(() => endpoint!.requests.length >= 4, 30000);
			const freshRequest = endpoint!.requests[3]!;
			expect(requestText(freshRequest)).toContain('Start the next independent iteration');
			expect(requestText(freshRequest)).not.toContain('Task one complete.');
		}
	);

	test(
		'mid-turn: crossing the threshold during a long turn steers the checkpoint in without waiting for settle',
		{ timeout: 60000 },
		async () => {
			const scratchPath = join(projectDir, 'scratch.txt');
			endpoint = startMockEndpoint([
				writeToolCallResponder(scratchPath, 'first step'),
				// High usage (11.5% > 10%); the crossing becomes visible while the
				// next response streams, i.e. mid-turn.
				writeToolCallResponder(scratchPath, `${BLOB_MARKER} second step`, { prompt_tokens: 1500, completion_tokens: 800 }),
				writeToolCallResponder(scratchPath, 'third step'),
				// The model complies with the steered checkpoint and ends the turn.
				textResponder('Checkpoint recorded in TODO.ralph.'),
				textResponder('Continuing from the checkpoint.')
			]);
			const sess = await createRalphSession(endpoint.port, {
				contextThresholds: { __default__: 0.1 },
				autoApproveDecisions: false,
				maxIterations: 10
			});

			await sess.prompt('/ralph start');

			// The checkpoint instruction is steered into the STILL-RUNNING turn: the
			// request that carries it also carries the tool result, proving it was
			// injected mid-run rather than sent as a separate turn after settle.
			const midTurnCheckpoint = await waitForRequestContaining('durable checkpoint');
			expect(midTurnCheckpoint).toContain('"role":"tool"');

			// After the turn settles, the fresh iteration runs with a clean context.
			const freshRequest = await waitForRequestContaining('Re-establish facts from the repository');
			expect(freshRequest).not.toContain(BLOB_MARKER);
		}
	);

	test(
		'escape: aborting an over-budget turn pauses the loop; /ralph resume continues it',
		{ timeout: 60000 },
		async () => {
			const scratchPath = join(projectDir, 'scratch.txt');
			const endlessWork = writeToolCallResponder(scratchPath, 'more work', { prompt_tokens: 1500, completion_tokens: 800 });
			// After the resumed rotation, the recording prompt and the fresh
			// iteration prompt get plain text answers so the session settles.
			const smartFallback: ScriptedResponder = (body) => {
				const text = lastUserText(body);
				if (text.includes('Create a durable checkpoint now')) return textResponder('Checkpoint recorded in TODO.ralph.')(body);
				if (text.includes('Run the Ralph loop')) return textResponder('Continuing from the checkpoint.')(body);
				if (text.includes('was paused and is now resumed')) return textResponder('Continuing the interrupted iteration.')(body);
				return endlessWork(body);
			};
			endpoint = startMockEndpoint(
				[writeToolCallResponder(scratchPath, 'first step'), endlessWork],
				smartFallback,
				300
			);
			const sess = await createRalphSession(endpoint.port, {
				contextThresholds: { __default__: 0.1 },
				autoApproveDecisions: false,
				maxIterations: 10
			});

			await sess.prompt('/ralph start');

			// Wait until the high-usage response has fully completed (the next
			// request proves it), then the user presses escape. The turn is
			// over budget, so without the fix the settle would queue a rotation
			// and start a new turn the user just tried to end.
			await waitFor(() => endpoint!.requests.length >= 3, 30000);
			const countAtAbort = endpoint!.requests.length;
			await sess.abort();

			// Give any (incorrect) continuation time to appear, then assert the
			// loop is paused: no request after the abort may be *triggered by* a
			// fresh iteration, a (re-sent) recording prompt, or a resume-continue.
			// (Earlier requests may already contain the mid-turn steer in their
			// message history, so only the last user message counts.)
			await new Promise((r) => setTimeout(r, 2000));
			const afterAbort = endpoint!.requests.slice(countAtAbort);
			const continuationTexts = ['Run the Ralph loop', 'Create a durable checkpoint now', 'was paused and is now resumed'];
			expect(afterAbort.every((r) => continuationTexts.every((t) => !lastUserText(r.body).includes(t)))).toBe(true);

			// /ralph resume continues: a post-abort request is triggered by the
			// pending recording prompt (mid-turn steer had queued the rotation)
			// or the resume-continue prompt (no rotation was pending).
			await sess.prompt('/ralph resume');
			await waitFor(
				() =>
					endpoint!.requests
						.slice(countAtAbort)
						.some((r) => lastUserText(r.body).includes('Create a durable checkpoint now') || lastUserText(r.body).includes('was paused and is now resumed')),
				'post-resume request',
				30000
			);
		}
	);
});
