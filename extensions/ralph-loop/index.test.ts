import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backlog } from './backlog.ts';
import extension from './index.ts';

/**
 * Drives the real extension module with a fake ExtensionAPI and asserts the
 * rotation lifecycle: context-limit checkpoints, completed-task rotations,
 * iteration/task counters, the max-iterations stop, and the status widget
 * content after every transition.
 */

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

interface FakeNotification {
	message: string;
	type?: string;
}

interface FakeUserMessage {
	text: string;
	options?: unknown;
}

interface FakeCustomMessage {
	message: { customType?: string; content?: string };
	options?: unknown;
}

function createFakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const userMessages: FakeUserMessage[] = [];
	const customMessages: FakeCustomMessage[] = [];

	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool: (tool: { name: string }) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => {
			commands.set(name, command);
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: 'custom', customType, data });
		},
		sendUserMessage: (text: string, options?: unknown) => {
			userMessages.push({ text, options });
		},
		sendMessage: (message: { customType?: string; content?: string }, options?: unknown) => {
			customMessages.push({ message, options });
		}
	};

	return {
		pi,
		tools,
		commands,
		entries,
		userMessages,
		customMessages,
		fire: async (name: string, ctx: unknown, event: unknown = {}) => {
			let last: unknown;
			for (const handler of handlers.get(name) ?? []) {
				const result = await handler(event, ctx);
				if (result !== undefined) last = result;
			}
			return last;
		}
	};
}

interface FakeCtx {
	ctx: {
		cwd: string;
		model: { provider: string; id: string; contextWindow: number };
		mode: string;
		isIdle: () => boolean;
		getContextUsage: () => { percent: number; tokens: number };
		sessionManager: {
			getBranch: () => unknown[];
			getSessionFile: () => string;
		};
		ui: {
			setWidget: (id: string, widget: unknown) => void;
			setStatus: (id: string, value: unknown) => void;
			setHeader: (value: unknown) => void;
			notify: (message: string, type?: string) => void;
			custom: (fn: unknown, opts?: unknown) => Promise<unknown>;
			input: (title: string, placeholder?: string) => Promise<string | undefined>;
			select: (title: string, options: string[]) => Promise<string | undefined>;
		};
	};
	widgets: Map<string, unknown>;
	notifications: FakeNotification[];
	usagePercent: { value: number };
	/** Whether the fake session reports itself idle (for /ralph stop). */
	idle: { value: boolean };
	/** Factories passed to ui.custom (e.g. the backlog view). */
	customFactories: Array<(tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => unknown>;
	/** Options passed to ui.custom alongside each factory. */
	customOptions: Array<unknown>;
	/** Queued results for ui.custom (what the view's done() callback reports). */
	customResultQueue: Array<unknown>;
	/** Prompts passed to ui.input, in order. */
	inputPrompts: Array<{ title: string; placeholder?: string }>;
	/** Queued answers for ui.input; empty string (the default) accepts "none". */
	inputQueue: Array<string | undefined>;
	/** Select dialogs shown via ui.select, in order. */
	selectPrompts: Array<{ title: string; options: string[] }>;
	/** Queued answers for ui.select; the first option is the default. */
	selectQueue: Array<string | undefined>;
	/** ui.custom control: delay before resolving, and a hook for the created component. */
	customControl: { delayMs: number; factoryHook?: (component: unknown) => void };
}

function createFakeCtx(cwd: string): FakeCtx {
	const widgets = new Map<string, unknown>();
	const notifications: FakeNotification[] = [];
	const usagePercent = { value: 10 };
	const idle = { value: true };
	const customFactories: FakeCtx['customFactories'] = [];
	const customOptions: FakeCtx['customOptions'] = [];
	const customResultQueue: FakeCtx['customResultQueue'] = [];
	const inputPrompts: FakeCtx['inputPrompts'] = [];
	const inputQueue: FakeCtx['inputQueue'] = [];
	const selectPrompts: FakeCtx['selectPrompts'] = [];
	const selectQueue: FakeCtx['selectQueue'] = [];
	const customControl: FakeCtx['customControl'] = { delayMs: 0 };

	const ctx = {
		cwd,
		model: { provider: 'test', id: 'test-model', contextWindow: 200_000 },
		mode: 'tui',
		isIdle: () => idle.value,
		getContextUsage: () => ({
			percent: usagePercent.value,
			tokens: Math.round((200_000 * usagePercent.value) / 100)
		}),
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => join(cwd, 'session.jsonl')
		},
		ui: {
			setWidget: (id: string, widget: unknown) => {
				widgets.set(id, widget);
			},
			setStatus: () => {},
			setHeader: () => {},
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			custom: (factory: FakeCtx['customFactories'][number], opts?: unknown) => {
				customFactories.push(factory);
				customOptions.push(opts);
				if (customControl.factoryHook) {
					const component = factory({ requestRender: () => {} }, fakeTheme, undefined, () => {});
					customControl.factoryHook(component);
				}
				const result = customResultQueue.length > 0 ? (customResultQueue.shift() as unknown) : undefined;
				if (customControl.delayMs > 0) {
					return new Promise((resolve) => setTimeout(() => resolve(result), customControl.delayMs));
				}
				return Promise.resolve(result);
			},
			input: (title: string, placeholder?: string) => {
				inputPrompts.push({ title, placeholder });
				return Promise.resolve(inputQueue.length > 0 ? (inputQueue.shift() as string | undefined) : '');
			},
			select: (title: string, options: string[]) => {
				selectPrompts.push({ title, options });
				return Promise.resolve(selectQueue.length > 0 ? (selectQueue.shift() as string | undefined) : options[0]);
			}
		}
	};

	return {
		ctx,
		widgets,
		notifications,
		usagePercent,
		idle,
		customFactories,
		customOptions,
		customResultQueue,
		inputPrompts,
		inputQueue,
		selectPrompts,
		selectQueue,
		customControl
	};
}

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text
};

/** Read the current status-bar line rendered by the ralph-loop-status widget. */
function statusLine(widgets: Map<string, unknown>): string {
	const widget = widgets.get('ralph-loop-status') as
		| ((tui: unknown, theme: unknown) => { render: (width: number) => string[] })
		| undefined;
	expect(widget).toBeFunction();
	const lines = (widget as (tui: unknown, theme: unknown) => { render: (width: number) => string[] })({}, fakeTheme).render(400);
	return lines.join(' ').trim();
}

/** Let the detached rotation IIFE in startFreshIteration finish its file I/O. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'ralph-loop-test-'));
	await writeFile(join(dir, 'SPEC.md'), '# Spec\n\nBuild the thing.\n');
	await mkdir(join(dir, '.pi'), { recursive: true });
	await writeFile(
		join(dir, '.pi', 'ralph-loop.json'),
		`${JSON.stringify({ contextThresholds: {}, autoApproveDecisions: false, maxIterations: 10 }, null, '\t')}\n`
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function startLoop(fake: ReturnType<typeof createFakePi>, fakeCtx: FakeCtx) {
	await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
	const ralph = fake.commands.get('ralph');
	expect(ralph).toBeDefined();
	await ralph!.handler('start', fakeCtx.ctx);
}

describe('ralph-loop extension', () => {
	beforeEach(async () => {
		await writeFile(join(dir, 'TODO.ralph'), RALPH_V1);
	});

	test('start reports iteration and per-task counters in the status bar', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		expect(fake.userMessages.length).toBe(1);
		expect(fake.userMessages[0].text).toContain('Run the Ralph loop');
		const status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: on');
		expect(status).toContain('iteration 1/10');
		expect(status).toContain('task: 1/3 (iteration 1)');
	});

	test('start is refused while a loop is already active', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);
		expect(fake.userMessages.length).toBe(1);

		await fake.commands.get('ralph')!.handler('start', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);
		expect(fakeCtx.notifications.at(-1)?.message).toBe('Ralph loop is already active — /ralph stop to end it first');
	});

	test('context-limit rotation checkpoints, then starts a fresh iteration with incremented counters', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);
		expect(statusLine(fakeCtx.widgets)).toContain('iteration 1/10');

		// The iteration settles with context usage at/above the 50% threshold.
		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);

		// The loop must queue a durable checkpoint and say so in the status bar.
		expect(statusLine(fakeCtx.widgets)).toContain('checkpointing');
		expect(fake.userMessages.at(-1)?.text).toContain('durable checkpoint');
		// The checkpoint label must carry the actual iteration number, not a placeholder.
		expect(fake.userMessages.at(-1)?.text).toContain('iteration 1 of 10');
		expect(fake.userMessages.at(-1)?.text).toContain('action "checkpoint"');
		// Only one checkpoint per task: a new one replaces the previous.
		expect(fake.userMessages.at(-1)?.text).toContain('keep only the single most recent one');

		// The checkpoint turn settles; the fresh iteration starts from the TODO.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// The bar stays in the visible "starting" phase until the new turn streams.
		let status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: starting');
		expect(status).toContain('iteration 2/10');
		expect(status).toContain('task: 1/3 (iteration 2)');

		// The first streaming update of the fresh iteration ends the phase. The
		// fresh (filtered) context reports low usage again.
		fakeCtx.usagePercent.value = 10;
		await fake.fire('message_update', fakeCtx.ctx);
		status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: on');
		expect(status).toContain('iteration 2/10');
		// A context boundary was recorded and a fresh iteration prompt sent.
		expect(fake.customMessages.some((m) => m.message.customType === 'ralph-loop-context-boundary')).toBe(true);
		expect(fake.userMessages.at(-1)?.text).toContain('context budget');
	});

	test('completed-task rotation increments the iteration and resets the per-task counter', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// The model completes task one and settles with low context usage.
		await writeFile(join(dir, 'TODO.ralph'), RALPH_V2_TASK_ONE_DONE);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);

		// A dedicated progress-recording turn runs before the fresh iteration.
		let status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: recording');
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');
		// The completion log is the single completion record.
		expect(fake.userMessages.at(-1)?.text).toContain('single completion record');
		// The ralph backlog is diffed by task id, so the prompt names the task.
		expect(fake.userMessages.at(-1)?.text).toContain('was just completed: task 1');
		expect(fake.userMessages.at(-1)?.text).toContain('action "log" for task 1');

		// The recording turn settles: only now does the fresh iteration start.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// The "starting" phase stays visible until the fresh iteration streams.
		status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: starting');
		expect(status).toContain('iteration 2/10');
		expect(status).toContain('task: 2/3 (iteration 1)');

		fakeCtx.usagePercent.value = 10;
		await fake.fire('message_update', fakeCtx.ctx);
		status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: on');
		expect(fake.userMessages.at(-1)?.text).toContain('previous TODO item was completed');
		expect(fake.userMessages.at(-1)?.text).toContain('only through the ralph_todo tool');
	});

	test('completed-task rotation names the completed task in the recording prompt (ralph format)', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');

		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		// The model completes task one through the tool and settles with low context usage.
		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<unknown>;
		};
		await tool.execute('t', { action: 'complete', task: '1' }, undefined, undefined, fakeCtx.ctx);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);

		// The recording prompt names the completed task directly: no backlog re-read needed.
		const prompt = fake.userMessages.at(-1)?.text ?? '';
		expect(prompt).toContain('was just completed: task 1');
		expect(prompt).toContain('action "log" for task 1');
		expect(prompt).not.toContain('action "list"');
	});

	test('mid-turn: crossing the threshold during streaming steers the checkpoint into the running turn', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// A long turn crosses the 50% threshold while still streaming.
		fakeCtx.usagePercent.value = 55;
		await fake.fire('message_update', fakeCtx.ctx);

		// The checkpoint prompt is steered into the running turn and the bar
		// shows "checkpointing" immediately, without waiting for the settle.
		const last = fake.userMessages.at(-1)!;
		expect(last.text).toContain('durable checkpoint');
		expect(last.options).toEqual({ deliverAs: 'steer' });
		expect(statusLine(fakeCtx.widgets)).toContain('checkpointing');

		// Further streaming updates do not queue a second rotation.
		const queued = fake.userMessages.length;
		await fake.fire('message_update', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(queued);
	});

	test('aborted turn: Escape pauses the loop immediately, even mid-rotation; resume continues', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		await writeFile(join(dir, 'TODO.ralph'), RALPH_V2_TASK_ONE_DONE);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);
		const queuedCount = fake.userMessages.length;
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');

		// The user aborts (Escape) the recording turn.
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'aborted' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// The loop pauses: no re-sent recording prompt and no fresh iteration.
		expect(fake.userMessages.length).toBe(queuedCount);
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// A later settle (e.g. user chat) must not resume or rotate.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(fake.userMessages.length).toBe(queuedCount);
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// /ralph resume re-sends the interrupted recording prompt.
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('resume', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(queuedCount + 1);
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');
		expect(statusLine(fakeCtx.widgets)).toContain('recording');
	});

	test('aborted tool call: Escape during a tool call pauses the loop; resume continues the iteration', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// The assistant requests a tool call, then the user presses Escape while
		// it runs: the tool ends as an error and the run settles without an
		// 'aborted' assistant message.
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'toolUse' } });
		await fake.fire('tool_execution_end', fakeCtx.ctx, {
			isError: true,
			result: { content: [{ type: 'text', text: 'Operation aborted' }] }
		});
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// No rotation or fresh iteration: the loop is paused.
		expect(fake.userMessages.length).toBe(1);
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// Resume without a pending rotation continues the current iteration.
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('resume', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(2);
		expect(fake.userMessages.at(-1)?.text).toContain('was paused and is now resumed');
	});

	test('typing while paused stays paused: the message is an extra instruction', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// Pause the loop with Escape.
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'aborted' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');
		// A persistent hint widget offers the explicit alternatives.
		expect(fakeCtx.widgets.get('ralph-paused')).toBeDefined();

		// The user types an instruction: it runs as normal chat and the loop
		// stays paused — no loop prompt is sent.
		const before = fake.userMessages.length;
		const transform = (await fake.fire('input', fakeCtx.ctx, {
			text: 'add a test for the parser',
			source: 'interactive'
		})) as { action: string; text: string } | undefined;
		expect(fake.userMessages.length).toBe(before);
		// The typed message is framed as a normal instruction, not loop work.
		expect(transform?.action).toBe('transform');
		expect(transform?.text).toContain('temporarily paused');
		expect(transform?.text).toContain('NOT currently running the Ralph loop');
		expect(transform?.text).toContain('add a test for the parser');
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// The instruction turn settles: still paused, nothing queued.
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'stop' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(fake.userMessages.length).toBe(before);
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// /ralph resume is the only way back.
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('resume', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(before + 1);
		expect(fake.userMessages.at(-1)?.text).toContain('was paused and is now resumed');
		expect(statusLine(fakeCtx.widgets)).not.toContain('paused');
		expect(fakeCtx.widgets.get('ralph-paused')).toBeUndefined();
	});

	test('typing while the loop is running passes through untransformed', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// No pause, no blocked decision: the input handler must not rewrite it.
		const transform = await fake.fire('input', fakeCtx.ctx, {
			text: 'steer me left',
			source: 'interactive'
		});
		expect(transform).toBeUndefined();
	});

	test('typing while paused with a pending rotation stays paused; resume re-sends the recording prompt', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		await writeFile(join(dir, 'TODO.ralph'), RALPH_V2_TASK_ONE_DONE);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);
		const queuedCount = fake.userMessages.length;
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');

		// Escape during the recording turn pauses with the rotation still pending.
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'aborted' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// Typing an instruction does not touch the pending rotation.
		const transform = (await fake.fire('input', fakeCtx.ctx, {
			text: 'note: use bun test',
			source: 'interactive'
		})) as { action: string; text: string } | undefined;
		expect(fake.userMessages.length).toBe(queuedCount);
		expect(transform?.action).toBe('transform');
		expect(transform?.text).toContain('temporarily paused');
		expect(transform?.text).toContain('note: use bun test');
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: paused');

		// /ralph resume re-sends the interrupted recording turn first.
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('resume', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(queuedCount + 1);
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');
		expect(statusLine(fakeCtx.widgets)).toContain('recording');
	});

	test('stopping mode: a completed task is recorded before the loop stops', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// The loop is running a turn when the user requests a stop.
		fakeCtx.idle.value = false;
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('stop', fakeCtx.ctx);
		expect(statusLine(fakeCtx.widgets)).toContain('stopping');

		// The iteration completes task one and settles with low context usage.
		await writeFile(join(dir, 'TODO.ralph'), RALPH_V2_TASK_ONE_DONE);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// The completion is recorded first (dedicated recording turn), not skipped.
		expect(statusLine(fakeCtx.widgets)).toContain('recording');
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');
		const count = fake.userMessages.length;

		// Once the recording turn settles, the loop stops — no fresh iteration.
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'stop' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fake.userMessages.length).toBe(count);
	});

	test('stopping mode: an over-budget iteration checkpoints before the loop stops', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		fakeCtx.idle.value = false;
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('stop', fakeCtx.ctx);
		expect(statusLine(fakeCtx.widgets)).toContain('stopping');

		// The iteration settles at/above the 50% threshold.
		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// A durable checkpoint is recorded before the loop ends.
		expect(statusLine(fakeCtx.widgets)).toContain('checkpointing');
		expect(fake.userMessages.at(-1)?.text).toContain('durable checkpoint');
		const count = fake.userMessages.length;

		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'stop' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fake.userMessages.length).toBe(count);
	});

	test('stopping mode with a pending rotation: stops after recording, no fresh iteration', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);

		// A rotation is queued (over-budget settle) and the user requests a stop
		// while the recording turn is about to run.
		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('checkpointing');

		fakeCtx.idle.value = false;
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('stop', fakeCtx.ctx);
		// The in-progress recording turn is still shown; the stop applies after it.
		expect(statusLine(fakeCtx.widgets)).toContain('checkpointing');

		// The recording turn settles: the loop must stop, not start a fresh
		// iteration (which would carry stopRequested over and auto-rotate forever).
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'stop' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fake.userMessages.length).toBe(2); // iteration prompt + checkpoint prompt only
	});

	test('stops the loop when a context-limit rotation would exceed the maximum iterations', async () => {
		await writeFile(
			join(dir, '.pi', 'ralph-loop.json'),
			`${JSON.stringify({ contextThresholds: {}, autoApproveDecisions: false, maxIterations: 2 }, null, '\t')}\n`
		);
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);
		expect(statusLine(fakeCtx.widgets)).toContain('iteration 1/2');

		// First context-limit rotation reaches iteration 2 (allowed).
		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('iteration 2/2');

		// Second context-limit rotation would reach iteration 3: the loop stops.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fakeCtx.notifications.some((n) => n.message.includes('maximum of 2 iterations'))).toBe(true);
	});

	test('stops the loop when a task completes at the maximum iterations', async () => {
		await writeFile(
			join(dir, '.pi', 'ralph-loop.json'),
			`${JSON.stringify({ contextThresholds: {}, autoApproveDecisions: false, maxIterations: 1 }, null, '\t')}\n`
		);
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		await startLoop(fake, fakeCtx);
		expect(statusLine(fakeCtx.widgets)).toContain('iteration 1/1');

		await writeFile(join(dir, 'TODO.ralph'), RALPH_V2_TASK_ONE_DONE);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fakeCtx.notifications.some((n) => n.message.includes('completing iteration 1/1'))).toBe(true);
	});

	test('status bar is populated after every transition', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);

		const transitions: Array<() => Promise<void>> = [
			async () => {
				await startLoop(fake, fakeCtx);
			},
			async () => {
				fakeCtx.usagePercent.value = 55;
				await fake.fire('agent_settled', fakeCtx.ctx);
			},
			async () => {
				await fake.fire('agent_settled', fakeCtx.ctx);
				await flush();
			},
			async () => {
				await writeFile(join(dir, 'TODO.ralph'), RALPH_V2_TASK_ONE_DONE);
				fakeCtx.usagePercent.value = 10;
				await fake.fire('agent_settled', fakeCtx.ctx);
			},
			async () => {
				await fake.fire('agent_settled', fakeCtx.ctx);
				await flush();
			}
		];

		const expected = [
			'iteration 1/10',
			'checkpointing',
			'iteration 2/10',
			'recording',
			'iteration 3/10'
		];

		for (let index = 0; index < transitions.length; index += 1) {
			await transitions[index]!();
			const status = statusLine(fakeCtx.widgets);
			expect(status.startsWith('Ralph:')).toBe(true);
			expect(status.length).toBeGreaterThan('Ralph:'.length);
			expect(status).toContain(expected[index]!);
		}
	});
});

// --- SQLite-backed (ralph-format) backlogs ----------------------------------------

const RALPH_MD = `# Demo backlog

## Ralph loop protocol

1. Read the spec before every iteration.

## Priority 0 — foundation

- [ ] **P0.1 Establish a clean local developer contract.**
  - Replace the starter README.
  - Acceptance: a new developer can install dependencies.

- [ ] **P0.2 Remove starter/demo surfaces.**
  - Remove demo routes.

- [x] **P0.3 Add sign-in.**
  - Build product routes.

## Completion log

- 2026-08-10 **P0.3** — Built the sign-in route. Verified: bun test.
`;

async function importTodo(fake: ReturnType<typeof createFakePi>, fakeCtx: FakeCtx, args: string) {
	const ralph = fake.commands.get('ralph')!;
	await ralph.handler(args, fakeCtx.ctx);
}

describe('ralph-loop extension (SQLite-backed ralph format)', () => {
	beforeEach(async () => {
		await writeFile(join(dir, 'TODO.md'), RALPH_MD);
	});

	test('/ralph import converts a Markdown backlog and tracks its source', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		await importTodo(fake, fakeCtx, 'import TODO.md');
		const imported = await readFile(join(dir, 'TODO.ralph'), 'utf8');
		expect(imported.startsWith('# ralph v2')).toBe(true);
		expect(imported).toContain('M source "TODO.md"');
		expect(imported).toContain('T 1 General "Establish a clean local developer contract."');
		expect(imported).toContain('D 3');
		expect(imported).toContain('L 1 3 2026-08-10');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Imported 3 tasks (2 open)');

		// Importing the same file again is refused: the source is recorded.
		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import TODO.md');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('already imported into TODO.ralph');

		// --force does not bypass the duplicate-source guard either.
		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import TODO.md --force');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('already imported into TODO.ralph');
	});

	test('/ralph import rejects ralph-format input', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		await importTodo(fake, fakeCtx, 'import TODO.md');
		expect((await readFile(join(dir, 'TODO.ralph'), 'utf8')).startsWith('# ralph v2')).toBe(true);

		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import TODO.ralph');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('must be different files');

		// Non-Markdown input is rejected outright; ralph-format content in a
		// .md file is rejected as input.
		await writeFile(join(dir, 'OTHER.ralph'), await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import OTHER.ralph');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('only accepts Markdown TODO files');

		await writeFile(join(dir, 'OTHER.md'), await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import OTHER.md');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('already a ralph-format backlog');
	});

	test('/ralph import merges multiple todo files with categories and blocks duplicate sources', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		const otherMd = `# Other backlog

## Priority 1 — features

- [ ] **Q1.1 Ship export.**
`;
		await writeFile(join(dir, 'FEATURES.md'), otherMd);

		await importTodo(fake, fakeCtx, 'import TODO.md --category alpha');
		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import FEATURES.md --category beta');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Merged 1 task');

		const combined = await readFile(join(dir, 'TODO.ralph'), 'utf8');
		expect(combined).toContain('M source "TODO.md"');
		expect(combined).toContain('M source "FEATURES.md"');
		// Both files' tasks are present, stamped with their import categories.
		const merged = Backlog.parse(combined);
		expect(merged.listTasks().find((t) => t.title === 'Establish a clean local developer contract.')?.category).toBe('alpha');
		expect(merged.listTasks().find((t) => t.title === 'Ship export.')?.category).toBe('beta');
		expect(merged.counts()).toEqual({ open: 3, total: 4, completed: 1 });

		// Re-importing the same file is refused (source is tracked).
		fakeCtx.notifications.length = 0;
		await importTodo(fake, fakeCtx, 'import FEATURES.md --category beta');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('already imported into TODO.ralph');
	});

	test('/ralph import always targets TODO.ralph and prompts only for the category', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		const emailMd = `# Email backlog\n\n## Priority 1 — email\n\n- [ ] **E1.1 Fetch mail.**\n`;
		await writeFile(join(dir, 'TODO_EMAIL.md'), emailMd);

		// First import: empty answer accepts the suggested category.
		fakeCtx.inputQueue.push('');
		await importTodo(fake, fakeCtx, 'import TODO.md');
		expect(fakeCtx.inputPrompts).toEqual([{ title: 'Category', placeholder: 'General' }]);
		expect((await readFile(join(dir, 'TODO.ralph'), 'utf8')).startsWith('# ralph v2')).toBe(true);

		// Second import: merges into the same TODO.ralph; --category skips the prompt.
		fakeCtx.inputPrompts.length = 0;
		await importTodo(fake, fakeCtx, 'import TODO_EMAIL.md --category Email');
		expect(fakeCtx.inputPrompts).toEqual([]);
		const main = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(main.listTasks().find((t) => t.title === 'Establish a clean local developer contract.')).toBeDefined();
		expect(main.listTasks().find((t) => t.title === 'Fetch mail.')?.category).toBe('Email');
		expect(main.sources()).toEqual(['TODO.md', 'TODO_EMAIL.md']);
	});

	test('/ralph import cancels when a prompt is dismissed', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		fakeCtx.inputQueue.push(undefined); // Escape on the category prompt
		await importTodo(fake, fakeCtx, 'import TODO.md');
		expect(fakeCtx.notifications.at(-1)?.message).toBe('Import cancelled');
		const ralph = await readFile(join(dir, 'TODO.ralph'), 'utf8').catch(() => undefined);
		expect(ralph).toBeUndefined();
	});

	test('start with a ralph-format backlog uses the ralph_todo prompt and tool', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');

		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		expect(fake.userMessages.length).toBe(1);
		expect(fake.userMessages[0].text).toContain('ralph_todo');
		expect(fake.userMessages[0].text).toContain('SQLite-backed');
		expect(statusLine(fakeCtx.widgets)).toContain('task: 2/3 (iteration 1)');
	});

	test('start --category scopes the backlog and rejects unknown categories', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');

		// Give the tasks categories by editing the imported file directly.
		const withCategories = (await readFile(join(dir, 'TODO.ralph'), 'utf8'))
			.replace('T 1 General ', 'T 1 dossier ')
			.replace('T 2 General ', 'T 2 dossier ')
			.replace('T 3 General ', 'T 3 auth ');
		await writeFile(join(dir, 'TODO.ralph'), withCategories);

		const ralph = fake.commands.get('ralph')!;
		fakeCtx.notifications.length = 0;
		await ralph.handler('start --todo TODO.ralph --category nope', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Unknown category "nope"');

		fakeCtx.notifications.length = 0;
		await ralph.handler('start --todo TODO.ralph --category dossier', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);
		expect(fake.userMessages[0].text).toContain('category "dossier"');
		expect(statusLine(fakeCtx.widgets)).toContain('task: 1/2 (iteration 1)');
	});

	test('ralph_todo tool completes, checkpoints, logs, and adds tasks in the file', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		expect(tool).toBeDefined();
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);
		const file = () => readFile(join(dir, 'TODO.ralph'), 'utf8');

		// The compact list shows open tasks only; the recorded completion (P0.3) stays out.
		const list = await run({ action: 'list' });
		expect(list.content[0]!.text).toContain('Lists: General 2/3');
		expect(list.content[0]!.text).toContain('Establish a clean local developer contract.');
		expect(list.content[0]!.text).not.toContain('Built the sign-in route');

		// category filters the summary to one list.
		const scoped = await run({ action: 'list', category: 'General' });
		expect(scoped.content[0]!.text).toContain('category "General"');
		await expect(run({ action: 'list', category: 'nope' })).rejects.toThrow(/no list named "nope"/);

		// verbose: true restores the full backlog with the completion log.
		const full = await run({ action: 'list', verbose: true });
		// The completion entry shows under its task, not in a separate log section.
		expect(full.content[0]!.text).toContain('✓ 2026-08-10 Built the sign-in route. Verified: bun test.');

		// task narrows the list to one task's details, including its completion log.
		const one = await run({ action: 'list', task: '3' });
		expect(one.content[0]!.text).toContain('Task 3: Add sign-in. [x]');
		expect(one.content[0]!.text).toContain('✓ 2026-08-10 Built the sign-in route. Verified: bun test.');
		expect(one.content[0]!.text).not.toContain('Remove starter/demo surfaces.');
		await expect(run({ action: 'list', task: 'NOPE' })).rejects.toThrow(/no task NOPE \(tasks: 1, 2, 3\)/);

		const done = await run({ action: 'complete', task: '1' });
		expect(done.content[0]!.text).toContain('Marked task 1 "Establish a clean local developer contract." done');
		expect(await file()).toContain('D 1');

		const checkpoint = await run({ action: 'checkpoint', task: '2', note: 'Removed routes; next step is the shell.' });
		expect(checkpoint.content[0]!.text).toContain('Checkpoint recorded for task 2');
		const afterCheckpoint = await file();
		expect(afterCheckpoint).toContain('C 2 1');
		expect(afterCheckpoint).toContain('Removed routes; next step is the shell.');

		const logged = await run({ action: 'log', task: '1', date: '2026-08-11', note: 'Replaced the README. Verified: bun test.' });
		expect(logged.content[0]!.text).toContain('Completion log entry recorded');
		expect(await file()).toContain('L 2 1 2026-08-11');

		// Creating a list is explicit; add to it after.
		await run({ action: 'new-list', name: 'auth' });
		const added = await run({ action: 'add', title: 'Add sign-out.', category: 'auth', body: '- Acceptance: sessions expire.' });
		expect(added.content[0]!.text).toContain('Added task 1 "Add sign-out."');
		expect(await file()).toContain('T 4 auth "Add sign-out."');

		// Unknown numbers report the known numbers.
		await expect(run({ action: 'complete', task: 'NOPE' })).rejects.toThrow(/no task NOPE \(tasks: 1, 2, 3, 4\)/);

		// The file stays valid ralph format after every mutation.
		const final = await file();
		expect(final.startsWith('# ralph v2')).toBe(true);
	});

	test('ralph_todo manages the main backlog from chat without an active loop', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);

		// list works without a loop.
		const list = await run({ action: 'list' });
		expect(list.content[0]!.text).toContain('Establish a clean local developer contract.');

		// next returns a compact view of only the first open task.
		const next = await run({ action: 'next' });
		expect(next.content[0]!.text).toContain('Next task: 1 Establish a clean local developer contract.');
		expect(next.content[0]!.text).toContain('Task body:');
		expect(next.content[0]!.text).not.toContain('Remove starter/demo surfaces.');
		expect(next.content[0]!.text).not.toContain('Completion log');

		// Creating a list is explicit: new-list first, then add to it.
		const created = await run({ action: 'new-list', name: 'Docs' });
		expect(created.content[0]!.text).toContain('Created list "Docs"');
		const added = await run({ action: 'add', title: 'Write the onboarding doc.', category: 'Docs' });
		expect(added.content[0]!.text).toContain('category "Docs"');
		const backlog = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		const task = backlog.listTasks().find((t) => t.title === 'Write the onboarding doc.');
		expect(task?.category).toBe('Docs');
		// Adding to a list that does not exist yet is refused.
		await expect(run({ action: 'add', title: 'Nope.', category: 'Missing' })).rejects.toThrow(/no list named "Missing"/);

		// complete and log work without a loop too.
		const done = await run({ action: 'complete', task: '1' });
		expect(done.content[0]!.text).toContain('Marked task 1 "Establish a clean local developer contract." done');
		const logged = await run({ action: 'log', task: '1', note: 'Did it.' });
		expect(logged.content[0]!.text).toContain('Completion log entry recorded');

		// move reorders tasks in the file.
		const moved = await run({ action: 'move', task: '4', direction: 'up' });
		expect(moved.content[0]!.text).toContain('Moved task 3 "Write the onboarding doc." up by 1.');
		const afterMove = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(afterMove.listTasks().map((t) => t.title)).toEqual([
			'Establish a clean local developer contract.',
			'Remove starter/demo surfaces.',
			'Write the onboarding doc.',
			'Add sign-in.'
		]);
		// Moving it back down succeeds; one more step past the edge is refused.
		await run({ action: 'move', task: '3', direction: 'down' });
		await expect(run({ action: 'move', task: '4', direction: 'down' })).rejects.toThrow(/already last/);
		await expect(run({ action: 'move', task: '3' })).rejects.toThrow(/direction/);

		// checkpoint requires an active loop.
		await expect(run({ action: 'checkpoint', task: '2', note: 'x' })).rejects.toThrow(/active Ralph loop/);
	});

	test('ralph_todo add-many adds a batch of tasks all-or-nothing', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);

		// A batch spanning the default list and an explicit list.
		await run({ action: 'new-list', name: 'Docs' });
		const batch = await run({
			action: 'add-many',
			tasks: [
				{ title: 'First batch task.' },
				{ title: 'Second batch task.', body: '- detail' },
				{ title: 'Doc task.', category: 'Docs' }
			]
		});
		expect(batch.content[0]!.text).toContain('Added 3 tasks:');
		expect(batch.content[0]!.text).toContain('[Docs]');
		const backlog = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(backlog.listTasks().slice(-3).map((t) => t.title)).toEqual([
			'First batch task.',
			'Second batch task.',
			'Doc task.'
		]);
		expect(backlog.listTasks().at(-1)?.category).toBe('Docs');
		expect(backlog.listTasks().at(-2)?.body).toBe('- detail');

		// An unknown category refuses the whole batch: nothing is added.
		const before = backlog.listTasks().length;
		await expect(
			run({ action: 'add-many', tasks: [{ title: 'X.' }, { title: 'Y.', category: 'Nope' }] })
		).rejects.toThrow(/no list named "Nope"/);
		const after = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(after.listTasks().length).toBe(before);

		// An empty batch is refused.
		await expect(run({ action: 'add-many', tasks: [] })).rejects.toThrow(/non-empty/);
	});

	test('ralph_todo search finds tasks by keyword without writing the file', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);
		const before = await readFile(join(dir, 'TODO.ralph'), 'utf8');

		// query is required.
		await expect(run({ action: 'search' })).rejects.toThrow(/search requires the query/);

		// Matches the title and the completion log note of the same task.
		const found = await run({ action: 'search', query: 'sign-in' });
		expect(found.content[0]!.text).toContain('Search "sign-in": 1 of 3 tasks match in all lists.');
		expect(found.content[0]!.text).toContain('- [x] 3 Add sign-in. [General]');
		expect(found.content[0]!.text).toContain('~ log ✓ 2026-08-10 Built the sign-in route. Verified: bun test.');
		// Non-matching tasks stay out of the result.
		expect(found.content[0]!.text).not.toContain('Remove starter/demo surfaces.');

		// Case-insensitive; unknown categories are rejected.
		const ci = await run({ action: 'search', query: 'SIGN-IN' });
		expect(ci.content[0]!.text).toContain('3 Add sign-in.');
		await expect(run({ action: 'search', query: 'sign-in', category: 'nope' })).rejects.toThrow(/no list named "nope"/);

		// No matches reports the searched scope.
		const none = await run({ action: 'search', query: 'werkvoorraad' });
		expect(none.content[0]!.text).toBe('No matches for "werkvoorraad" (3 tasks in all lists).');

		// Search is read-only: the backlog file is untouched.
		expect(await readFile(join(dir, 'TODO.ralph'), 'utf8')).toBe(before);
	});


	test('ralph_todo import converts a Markdown backlog into TODO.ralph', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);

		// Import without a loop creates TODO.ralph from the Markdown file.
		// Without a category, tasks are stamped with the file-name-derived
		// default (TODO.md → General) so they show up in the todos view.
		const imported = await run({ action: 'import', file: 'TODO.md' });
		expect(imported.content[0]!.text).toContain('Imported 3 tasks (2 open)');
		expect(imported.content[0]!.text).toContain('category "General"');
		let file = await readFile(join(dir, 'TODO.ralph'), 'utf8');
		expect(file.startsWith('# ralph v2')).toBe(true);
		expect(file).toContain('M source "TODO.md"');
		expect(file).toContain('T 1 General "Establish a clean local developer contract."');

		// Re-importing the same source is refused (the source is recorded).
		await expect(run({ action: 'import', file: 'TODO.md' })).rejects.toThrow(/already imported into TODO\.ralph/);

		// A second Markdown file merges into the same backlog.
		await writeFile(
			join(dir, 'EMAIL.md'),
			['# Email backlog', '', '- [ ] Draft the reply template.', '- [x] Archive the inbox.'].join('\n')
		);
		// Omitted category defaults to the file-name-derived name (EMAIL.md → Email).
		const merged = await run({ action: 'import', file: 'EMAIL.md' });
		expect(merged.content[0]!.text).toContain('Merged 2 tasks');
		file = await readFile(join(dir, 'TODO.ralph'), 'utf8');
		expect(file).toContain('M source "EMAIL.md"');
		expect(file).toContain('T 4 Email "Draft the reply template."');

		// ralph-format input, missing files, and a missing path are refused.
		await expect(run({ action: 'import', file: 'TODO.ralph' })).rejects.toThrow(/must be different files/);
		await expect(run({ action: 'import', file: 'NOPE.md' })).rejects.toThrow(/Could not read NOPE\.md/);
		await expect(run({ action: 'import' })).rejects.toThrow(/requires the file path/);
	});
	test('completing a task through ralph_todo queues the completed-task rotation', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await importTodo(fake, fakeCtx, 'import TODO.md');
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<unknown>;
		};
		await tool.execute('t', { action: 'complete', task: '1' }, undefined, undefined, fakeCtx.ctx);

		fake.userMessages.length = 0;
		await fake.fire('agent_settled', fakeCtx.ctx, {});
		await flush();

		// The recording prompt is the ralph variant (log via the tool, not file edits).
		expect(fake.userMessages.length).toBe(1);
		expect(fake.userMessages[0].text).toContain('action "log"');
		expect(statusLine(fakeCtx.widgets)).toContain('recording');
	});

	test('ralph_todo without a loop needs a backlog; init bootstraps it; a Markdown TODO is refused at start', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);

		// No loop and no TODO.ralph: actions point at init (or import).
		await expect(run({ action: 'list' })).rejects.toThrow(
			/No Ralph backlog at .*Bootstrap it with ralph_todo action "init"/s
		);
		await expect(run({ action: 'add', title: 'Nope.' })).rejects.toThrow(/Bootstrap it with ralph_todo action "init"/);
		await expect(readFile(join(dir, 'TODO.ralph'), 'utf8')).rejects.toThrow();

		// init creates the file; new-list and add then work on it.
		const created = await run({ action: 'init' });
		expect(created.content[0]!.text).toContain('Created empty Ralph backlog');
		const listCreated = await run({ action: 'new-list', name: 'Docs' });
		expect(listCreated.content[0]!.text).toContain('Created list "Docs"');
		const added = await run({ action: 'add', title: 'Write the onboarding doc.', category: 'Docs' });
		expect(added.content[0]!.text).toContain('category "Docs"');
		const backlog = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		const task = backlog.listTasks().find((t) => t.title === 'Write the onboarding doc.');
		expect(task?.category).toBe('Docs');

		// A Markdown TODO is refused at start: import it first.
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.md', fakeCtx.ctx);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Import it first with /ralph import TODO.md');
	});

	test('ralph_todo init bootstraps a missing backlog and is idempotent', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });

		const tool = fake.tools.get('ralph_todo') as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
		};
		const run = (params: Record<string, unknown>) => tool.execute('t', params, undefined, undefined, fakeCtx.ctx);

		// init creates the missing file.
		const created = await run({ action: 'init' });
		expect(created.content[0]!.text).toContain('Created empty Ralph backlog');
		expect((await readFile(join(dir, 'TODO.ralph'), 'utf8')).startsWith('# ralph v2')).toBe(true);

		// init is idempotent on an existing ralph backlog.
		const again = await run({ action: 'init' });
		expect(again.content[0]!.text).toContain('already exists');

		// init refuses to overwrite a non-ralph file.
		await writeFile(join(dir, 'TODO.ralph'), '# not a backlog\n');
		await expect(run({ action: 'init' })).rejects.toThrow(/refusing to overwrite/);
	});
});

describe('ralph-loop extension (/ralph todos view)', () => {
	beforeEach(async () => {
		await writeFile(join(dir, 'TODO.md'), RALPH_MD);
	});

	test('opens the backlog view for the active loop and closes on q', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('import TODO.md', fakeCtx.ctx);
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		// One overlay hosts both stages, so the chat scroll position is
		// untouched and the stages swap without the chat flashing through.
		await ralph.handler('todos', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1);
		expect(fakeCtx.customOptions[0]).toEqual({
			overlay: true,
			overlayOptions: { width: '100%', maxHeight: '90%' }
		});
		let closed: string | undefined;
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, (r?: string) => {
			closed = r;
		}) as { render: (width: number) => string[]; handleInput: (data: string) => void };
		// The import stamped the "General" list, so the picker opens first;
		// selecting it swaps to the view scoped to the list.
		component.handleInput('\r');
		const rendered = component.render(100).join('\n');
		expect(rendered).toContain('Ralph backlog — TODO.ralph');
		expect(rendered).toContain('Establish a clean local developer contract.');
		// No separate completion log section in the view.
		expect(rendered).not.toContain('Completion log');
		component.handleInput('q');
		expect(closed).toBe('quit');
	});

	test('scopes the view to the loop category', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('import TODO.md', fakeCtx.ctx);
		await writeFile(
			join(dir, 'TODO.ralph'),
			(await readFile(join(dir, 'TODO.ralph'), 'utf8'))
				.replace('T 1 General ', 'T 1 dossier ')
				.replace('T 2 General ', 'T 2 dossier ')
				.replace('T 3 General ', 'T 3 auth ')
		);
		await ralph.handler('start --todo TODO.ralph --category dossier', fakeCtx.ctx);

		await ralph.handler('todos', fakeCtx.ctx);
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
		};
		const rendered = component.render(100).join('\n');
		expect(rendered).toContain('category "dossier"');
		expect(rendered).toContain('Establish a clean local developer contract.');
		expect(rendered).not.toContain('Add sign-in.');
	});

	test('asks to choose a list when the backlog has categories', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;

		await importTodo(fake, fakeCtx, 'import TODO.md --category General');
		await writeFile(
			join(dir, 'EMAIL.md'),
			`# Email backlog\n\n## Priority 1 — email\n\n- [ ] **E1.1 Fetch mail.**\n`
		);
		await importTodo(fake, fakeCtx, 'import EMAIL.md --category Email');

		// Without an active loop the picker opens first; selecting a list
		// swaps to the view scoped to it (the same overlay).
		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1);
		expect(fakeCtx.customOptions[0]).toEqual({ overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } });
		const host = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		// The picker opens first.
		const pickerText = host.render(100).join('\n');
		expect(pickerText).toContain('> General — 2 open / 3 total');
		expect(pickerText).toContain('Email — 1 open / 1 total');
		expect(pickerText).toContain('R: rename');
		// Like the todos view: pinned to the top, padded to 90% of the
		// terminal height, key hints on the bottom line.
		const pickerLines = host.render(100);
		expect(pickerLines.length).toBe(Math.max(10, Math.floor((process.stdout.rows ?? 40) * 0.9)));
		expect(pickerLines[0]).toContain('Ralph lists');
		expect(pickerLines[pickerLines.length - 1]).toContain('q: quit');
		expect(pickerLines[pickerLines.length - 2]).toBe('');
		// Selecting a list swaps to the view scoped to it (same overlay).
		host.handleInput('\r');
		expect(host.render(100).join('\n')).toContain('category "General"');
		expect(host.render(100).join('\n')).not.toContain('Fetch mail.');


		// Picking the second list scopes the view to it.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		const second = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		second.handleInput('j');
		second.handleInput('\r');
		const rendered = second.render(100).join('\n');
		expect(rendered).toContain('category "Email"');
		expect(rendered).toContain('Fetch mail.');
		expect(rendered).not.toContain('Establish a clean local developer contract.');


		// Cancelling the picker opens no view.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1); // single overlay, picker stage
		const cancelled = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
		};
		expect(cancelled.render(100).join('\n')).toContain('Ralph lists');


		// Escape in the view goes back to the list overview inside the same
		// overlay; q in the overview closes it.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		let closed = false;
		let result: string | undefined;
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, (r?: string) => {
			closed = true;
			result = r;
		}) as { render: (width: number) => string[]; handleInput: (data: string) => void };
		component.handleInput('j');
		component.handleInput('\r'); // open the Email view
		component.handleInput('\x1b'); // back to the list overview
		expect(component.render(100).join('\n')).toContain('Ralph lists');
		expect(closed).toBe(false);
		component.handleInput('q');
		expect(closed).toBe(true);
		expect(result).toBeUndefined();


		// Re-opening a list from the overview swaps back to the view.
		component.handleInput('\r');
		expect(component.render(100).join('\n')).toContain('category "General"');
	});

	test('the list picker renames a list inline', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;

		await importTodo(fake, fakeCtx, 'import TODO.md --category General');
		await writeFile(
			join(dir, 'EMAIL.md'),
			`# Email backlog\n\n## Priority 1 — email\n\n- [ ] **E1.1 Fetch mail.**\n`
		);
		await importTodo(fake, fakeCtx, 'import EMAIL.md --category Email');

		// The picker opens; close it after the rename round.
		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		const picker = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};

		// R starts the inline rename of the highlighted list, prefilled with
		// its name; appending and pressing enter saves it to disk.
		picker.handleInput('R');
		picker.handleInput('2');
		picker.handleInput('\r');
		await flush();
		const onDisk = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(onDisk.categories()).toEqual(['General2', 'Email']);
		expect(onDisk.listTasks().find((t) => t.title === 'Establish a clean local developer contract.')?.category).toBe('General2');
		// The picker shows the renamed list in place with a saved notice.
		const renamed = picker.render(100).join('\n');
		expect(renamed).toContain('> General2 — 2 open / 3 total');
		expect(renamed).toContain('saved');

		// Colliding names are refused: the row keeps its name, nothing is written.
		picker.handleInput('R');
		for (let i = 0; i < 'General2'.length; i += 1) picker.handleInput('\x7f');
		for (const ch of 'Email') picker.handleInput(ch);
		picker.handleInput('\r');
		await flush();
		const after = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(after.categories()).toEqual(['General2', 'Email']);
		expect(picker.render(100).join('\n')).toContain('not saved');

		// Escape cancels the inline rename.
		picker.handleInput('R');
		picker.handleInput('x');
		picker.handleInput('\x1b');
		expect(picker.render(100).join('\n')).toContain('> General2 — 2 open / 3 total');
	});

	test('falls back to a file argument, then conventional names; errors without TUI', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;

		// No loop, no TODO.ralph: a Markdown TODO.md has no todo entries; the
		// view suggests importing it instead.
		await ralph.handler('todos', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toBe('Todo entries empty. Import data with /ralph import');

		// Explicit file argument wins.
		await ralph.handler('import TODO.md', fakeCtx.ctx);
		fakeCtx.customFactories.length = 0;
		// The import stamped the "General" list; opening it shows the view.
		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		const host = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		host.handleInput('\r');
		expect(host.render(100).join('\n')).toContain('Ralph backlog — TODO.ralph');

		// Missing file: error notification, no view.
		fakeCtx.notifications.length = 0;
		fakeCtx.customFactories.length = 0;
		await ralph.handler('todos missing.md', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Could not read missing.md');

		// Non-TUI mode: refused.
		fakeCtx.notifications.length = 0;
		(fakeCtx.ctx as { mode: string }).mode = 'rpc';
		await ralph.handler('todos', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('requires TUI mode');
	});

	test('edits from the view are written back to the backlog file', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await importTodo(fake, fakeCtx, 'import TODO.md --category General');

		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		// The picker opens first; opening the list swaps to the view.
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			handleInput: (data: string) => void;
		};
		component.handleInput('\r');
		component.handleInput('a');
		component.handleInput('\r'); // enter starts editing the form
		for (const ch of 'New task from the view') component.handleInput(ch);
		component.handleInput('\x13'); // Ctrl+S saves the form
		await flush();
		const onDisk = await readFile(join(dir, 'TODO.ralph'), 'utf8');
		expect(onDisk).toContain('New task from the view');
	});

	test('s starts a loop scoped to the chosen list through the shared start path', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;

		await importTodo(fake, fakeCtx, 'import TODO.md --category General');
		await writeFile(join(dir, 'EMAIL.md'), `# Email backlog\n\n## Priority 1 — email\n\n- [ ] **E1.1 Fetch mail.**\n`);
		await importTodo(fake, fakeCtx, 'import EMAIL.md --category Email');

		await ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		let closed: string | undefined;
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, (r?: string) => {
			closed = r;
		}) as { handleInput: (data: string) => void };
		component.handleInput('j'); // highlight the Email list
		component.handleInput('\r'); // open it
		component.handleInput('s');
		component.handleInput('y');
		expect(closed).toBe('quit');
		await flush();

		// The loop started on the Email list with the same validation as /ralph start.
		const prompt = fake.userMessages.at(-1)?.text ?? '';
		expect(prompt).toContain('Run the Ralph loop');
		expect(prompt).toContain('category "Email"');
		expect(statusLine(fakeCtx.widgets)).toContain('category: Email');
	});

	test('the list picker refreshes after a view round renames a list', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await importTodo(fake, fakeCtx, 'import TODO.md --category General');

		const created: unknown[] = [];
		fakeCtx.customControl.factoryHook = (component) => created.push(component);
		const handler = ralph.handler('todos TODO.ralph', fakeCtx.ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const host = created[0] as { render: (width: number) => string[]; handleInput: (data: string) => void };
		// Open the list, rename it from the view, and go back to the overview.
		host.handleInput('\r');
		host.handleInput('R');
		host.handleInput('x');
		host.handleInput('\r');
		await flush();
		host.handleInput('\x1b');
		// The overview re-read the file: the list is renamed.
		expect(host.render(100).join('\n')).toContain('Generalx — 2 open / 3 total');
		host.handleInput('q');
		await handler;
		fakeCtx.customControl.factoryHook = undefined;
	});
});

describe('/ralph-init (ralph-format-only)', () => {
	let fake: ReturnType<typeof createFakePi>;
	let fakeCtx: FakeCtx;

	beforeEach(async () => {
		fake = createFakePi();
		extension(fake.pi as never);
		fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
	});

	const init = (args: string) => fake.commands.get('ralph-init')!.handler(args, fakeCtx.ctx);

	test('creates an empty ralph backlog directly and sends a spec-only prompt', async () => {
		await rm(join(dir, 'SPEC.md'));
		await init('Build a lamp.');

		// The backlog is created by the command itself, in ralph format.
		expect((await readFile(join(dir, 'TODO.ralph'), 'utf8')).startsWith('# ralph v2')).toBe(true);
		// The LLM is asked for the spec only.
		expect(fake.userMessages).toHaveLength(1);
		const prompt = fake.userMessages[0]!.text;
		expect(prompt).toContain('specification: SPEC.md');
		expect(prompt).toContain('SPEC.template.md');
		expect(prompt).not.toContain('TODO template');
		expect(prompt).not.toContain('TODO.template.md');
		expect(prompt).not.toContain('backlog: ');
	});

	test('--todo only creates the backlog without an LLM prompt', async () => {
		await init('--todo TODO.ralph');
		expect((await readFile(join(dir, 'TODO.ralph'), 'utf8')).startsWith('# ralph v2')).toBe(true);
		expect(fake.userMessages).toHaveLength(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Created empty Ralph backlog at TODO.ralph');
	});

	test('is idempotent on an existing ralph backlog', async () => {
		await rm(join(dir, 'SPEC.md'));
		await init('Build a lamp.');
		const first = await readFile(join(dir, 'TODO.ralph'), 'utf8');
		fake.userMessages.length = 0;
		fakeCtx.notifications.length = 0;
		await init('Build a lamp.');
		expect(await readFile(join(dir, 'TODO.ralph'), 'utf8')).toBe(first);
		expect(fake.userMessages).toHaveLength(1);
	});

	test('refuses to replace an existing spec without --force', async () => {
		// The top-level beforeEach writes SPEC.md.
		await init('Build a lamp.');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Refusing to replace existing SPEC.md');
		expect(fake.userMessages).toHaveLength(0);
	});

	test('refuses a non-ralph backlog without --force and overwrites it with --force', async () => {
		await rm(join(dir, 'SPEC.md'));
		await writeFile(join(dir, 'TODO.ralph'), '- [ ] old markdown\n');
		await init('Build a lamp.');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Refusing to replace existing TODO.ralph');
		expect(fake.userMessages).toHaveLength(0);
		expect(await readFile(join(dir, 'TODO.ralph'), 'utf8')).toBe('- [ ] old markdown\n');

		fakeCtx.notifications.length = 0;
		await init('--force Build a lamp.');
		expect((await readFile(join(dir, 'TODO.ralph'), 'utf8')).startsWith('# ralph v2')).toBe(true);
		expect(fake.userMessages).toHaveLength(1);
	});
});
