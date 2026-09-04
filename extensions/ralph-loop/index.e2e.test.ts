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

const RALPH_V2_TASK_ONE_DONE_LOGGED = `# ralph v2

T 1 - "Task one"
D 1
L 1 1 2026-09-04
  Implemented task one; changed a.ts; bun test passed.

T 2 - "Task two"

T 3 - "Task three"
`;

// A goal-only backlog: the planning state of the goal loop (goal open, no tasks).
const RALPH_GOAL_ONLY = `# ralph v2

G "Ship the thing" open
GB
  - Criterion one holds.
  - Criterion two holds.
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

/**
 * A scripted response that calls an arbitrary tool (e.g. ralph_todo or
 * ralph_goal) with the given JSON arguments, streamed in chunks like a real
 * tool call. The real tool executes, so its side effects (backlog file
 * writes, loop state changes) happen for real.
 */
function toolCallResponder(toolName: string, args: Record<string, unknown>, callId = 'call_mock_1'): ScriptedResponder {
	const argsJson = JSON.stringify(args);
	const chunks: string[] = [];
	for (let offset = 0; offset < argsJson.length; offset += 32) chunks.push(argsJson.slice(offset, offset + 32));
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
						tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: '' } }]
					}
				}
			]
		}),
		...chunks.map((chunk) =>
			dataLine({
				id: 'chatcmpl-mock',
				object: 'chat.completion.chunk',
				choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: chunk } }] } }]
			})
		),
		dataLine({
			id: 'chatcmpl-mock',
			object: 'chat.completion.chunk',
			choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
			usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
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
		cwd: projectDir,
		// Hermetic settings: without this the session would read the developer's
		// real ~/.pi/agent/settings.json (e.g. compaction.keepRecentTokens).
		agentDir
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
		'rotation: the finished iteration is compacted out of the TUI context; the fresh iteration\'s model context drops the completion summary',
		{ timeout: 60000 },
		async () => {
			const todoPath = join(projectDir, 'TODO.ralph');
			// Lower the compaction gate so a small test iteration is compactable
			// (pi refuses to compact when less than keepRecentTokens would be
			// discarded; the default is 20000).
			await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 100 } }, null, '\t')}\n`);
			endpoint = startMockEndpoint([
				writeToolCallResponder(todoPath, RALPH_V2_TASK_ONE_DONE_LOGGED),
				textResponder('Task one complete.'),
				// The dedicated progress-recording turn.
				textResponder('Progress recorded.'),
				// The fresh iteration.
				textResponder('Working on task two.')
			]);
			const sess = await createRalphSession(endpoint.port, {
				contextThresholds: { __default__: 0.9 },
				autoApproveDecisions: false,
				maxIterations: 10,
				compactionMode: true
			});

			await sess.prompt('/ralph start');

			// Iteration 1: the mock model calls the real write tool, which really
			// updates TODO.ralph on disk.
			await waitFor(() => endpoint!.requests.length >= 2, 30000);
			const todoOnDisk = await readFile(todoPath, 'utf8');
			expect(todoOnDisk).toContain('D 1');

			// The recording turn runs, then the rotation compacts the finished
			// iteration (extension-provided: no LLM call) and starts the fresh one.
			await waitFor(() => endpoint!.requests.length >= 4, 30000);

			// (a) A ralph-provided compaction entry exists, cut at the recording
			// prompt, with the completion summary as its text.
			const branch = sess.sessionManager.getBranch();
			const compaction = branch.find((entry) => entry.type === 'compaction');
			expect(compaction).toBeDefined();
			expect((compaction as { fromHook?: boolean }).fromHook).toBe(true);
			expect((compaction as { details?: { source?: string } }).details?.source).toBe('ralph-loop');
			expect(compaction!.summary).toContain('completed tasks so far');
			expect(compaction!.summary).toContain('Implemented task one; changed a.ts; bun test passed.');
			// The recording prompt, identified by its unique text (the iteration
			// prompts mention the completion log too, and the fresh iteration
			// prompt is already in the branch by now).
			const recordingPrompt = branch.find(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'user' &&
					JSON.stringify(entry.message.content).includes('A Ralph TODO task was just completed')
			);
			expect(recordingPrompt).toBeDefined();
			expect(compaction!.firstKeptEntryId).toBe(recordingPrompt!.id);

			// (b) The audit trail is intact in the session file…
			expect(branch.some((entry) => JSON.stringify(entry).includes('Task one complete.'))).toBe(true);
			// …but the compaction-aware context (what the TUI renders) drops it.
			const contextEntries = sess.sessionManager.buildContextEntries();
			expect(contextEntries.some((entry) => JSON.stringify(entry).includes('Task one complete.'))).toBe(false);

			// (c) The fresh iteration's model request carries none of the previous
			// iteration's content and no completion summary either: the summary
			// lands before the context boundary and is sliced out of the model
			// context (the model checks its own progress with ralph_todo).
			const freshRequest = requestText(endpoint!.requests[3]!);
			expect(freshRequest).toContain('Start the next independent iteration');
			expect(freshRequest).not.toContain('completed tasks so far');
			expect(freshRequest).not.toContain('Task one complete.');
			expect(freshRequest).not.toContain('Progress recorded.');
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

	test(
		'goal loop: planning -> execution -> re-evaluation -> approved completion stops the loop',
		{ timeout: 90000 },
		async () => {
			const todoPath = join(projectDir, 'TODO.ralph');
			await writeFile(todoPath, RALPH_GOAL_ONLY);
			endpoint = startMockEndpoint([
				// Iteration 1 (planning): the model creates the plan's list, then
				// decomposes the goal into the plan.
				toolCallResponder('ralph_todo', { action: 'new-list', name: 'Plan' }, 'call_list'),
				toolCallResponder(
					'ralph_todo',
					{ action: 'add-many', category: 'Plan', tasks: [{ title: 'Task one.' }, { title: 'Task two.' }] },
					'call_plan'
				),
				textResponder('Plan recorded: two tasks added.'),
				// Plan-updated recording turn (commit-only).
				textResponder('Plan committed.'),
				// Iteration 2 (execution): complete task 1 via the real tool.
				toolCallResponder('ralph_todo', { action: 'complete', task: '1' }, 'call_task1'),
				textResponder('Task one complete.'),
				// Completed-task recording turn.
				textResponder('Progress recorded.'),
				// Iteration 3 (execution): complete task 2.
				toolCallResponder('ralph_todo', { action: 'complete', task: '2' }, 'call_task2'),
				textResponder('Task two complete.'),
				// Completed-task recording turn.
				textResponder('Progress recorded.'),
				// Iteration 4 (re-evaluation): every criterion verified -> claim the goal.
				// ralph_goal complete terminates the turn (the approval gate).
				toolCallResponder(
					'ralph_goal',
					{ action: 'complete', note: 'All acceptance criteria verified: bun test passes (5 suites).' },
					'call_complete'
				),
				// The user approves in chat; the input is transformed into the decision context.
				toolCallResponder(
					'ralph_resolve_decision',
					{ recordPath: 'docs/decisions/goal-approval.md', resolution: 'User approved completion of the goal.' },
					'call_resolve'
				),
				// Approved: confirm the claim -> goal done.
				toolCallResponder('ralph_goal', { action: 'confirm' }, 'call_confirm'),
				textResponder('Goal confirmed; the loop should stop.')
			]);
			const sess = await createRalphSession(endpoint.port, {
				contextThresholds: { __default__: 0.9 },
				autoApproveDecisions: false,
				maxIterations: 10
			});

			await sess.prompt('/ralph start --goal');

			// The scripted endpoint answers instantly, so the whole loop can run
				// ahead of the assertions: the request log is the source of truth,
				// and the file is only asserted once the loop has provably stopped.

			// Iteration 1 is a planning iteration: goal open, no tasks yet.
			await waitFor(() => endpoint!.requests.length >= 1, 30000);
			expect(requestText(endpoint!.requests[0]!)).toContain('This is a planning iteration');

			// The planning turn creates the list and adds the plan through the REAL
				// ralph_todo tool (the tool calls and their results are in the log).
			await waitFor(() => endpoint!.requests.length >= 2, 30000);
			expect(requestText(endpoint!.requests[1]!)).toContain('"name":"ralph_todo"');
			await waitFor(() => endpoint!.requests.length >= 3, 30000);
			expect(requestText(endpoint!.requests[2]!)).toContain('add-many');

			// The grown plan triggers a plan-updated rotation with a commit-only
			// recording turn (no completion log: no task was completed).
			await waitFor(() => endpoint!.requests.length >= 4, 30000);
			expect(requestText(endpoint!.requests[3]!)).toContain('The Ralph plan was just updated');

			// Fresh execution iteration with a clean context: the old planning and
			// recording turns are filtered out by the context boundary.
			await waitFor(() => endpoint!.requests.length >= 5, 30000);
			let fresh = requestText(endpoint!.requests[4]!);
			expect(fresh).toContain('You are executing the goal');
			expect(fresh).toContain('The plan was just updated with new tasks.');
			expect(fresh).not.toContain('Plan committed.');

			// Iteration 2 completes task 1 via the real tool.
			await waitFor(() => endpoint!.requests.length >= 6, 30000);
			expect(requestText(endpoint!.requests[5]!)).toContain('"name":"ralph_todo"');

			// The completed-task recording turn names the completed task.
			await waitFor(() => endpoint!.requests.length >= 7, 30000);
			expect(requestText(endpoint!.requests[6]!)).toContain('A Ralph TODO task was just completed: task 1');

			// Fresh execution iteration for task 2, again from a clean context.
			await waitFor(() => endpoint!.requests.length >= 8, 30000);
			fresh = requestText(endpoint!.requests[7]!);
			expect(fresh).toContain('You are executing the goal');
			expect(fresh).toContain('A previous TODO item was completed.');
			expect(fresh).not.toContain('Task one complete.');

			// Iteration 3 completes task 2; its recording turn follows.
			await waitFor(() => endpoint!.requests.length >= 10, 30000);
			expect(requestText(endpoint!.requests[9]!)).toContain('A Ralph TODO task was just completed: task 2');

			// Plan exhausted: the fresh iteration is a re-evaluation, and the model
			// claims the goal (ralph_goal complete terminates the turn at the gate).
			await waitFor(() => endpoint!.requests.length >= 11, 30000);
			expect(requestText(endpoint!.requests[10]!)).toContain('This is a re-evaluation iteration');

			// The loop is paused at the approval gate: the user's chat reply is
			// transformed into the pending-decision context for the model. Wait for
			// the claim turn to fully settle first — prompting a still-streaming
			// session throws.
			await sess.waitForIdle();
			await sess.prompt('Approved. The evidence is solid.');
			const approvalRequest = await waitForRequestContaining('Ralph is paused in this session pending this decision');
			expect(approvalRequest).toContain('Approve completion of the goal');
			expect(approvalRequest).toContain('The user replied:');

			// After the decision is resolved and the goal confirmed, the goal is
			// done in the file and the loop stops: no further model request is
			// triggered (no fresh iteration, no recording turn).
			await waitFor(() => endpoint!.requests.length >= 14, 30000);
			const countAtEnd = endpoint!.requests.length;
			await new Promise((r) => setTimeout(r, 2000));
			expect(endpoint!.requests.length).toBe(countAtEnd);

			// The final file state proves the real tools did the work: both tasks
			// completed, the goal claimed with evidence and then confirmed to done.
			const todoOnDisk = await readFile(todoPath, 'utf8');
			expect(todoOnDisk).toContain('T 1 Plan "Task one."');
			expect(todoOnDisk).toContain('D 1');
			expect(todoOnDisk).toContain('T 2 Plan "Task two."');
			expect(todoOnDisk).toContain('D 2');
			expect(todoOnDisk).toContain('G "Ship the thing" done');
			expect(todoOnDisk).toContain('GE "All acceptance criteria verified: bun test passes (5 suites)."');
		}
	);
});
