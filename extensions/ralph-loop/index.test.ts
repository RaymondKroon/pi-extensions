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
		// The ralph backlog is diffed by task id, so the prompt names the task, and it
		// is idempotent: check for an existing entry before logging.
		expect(fake.userMessages.at(-1)?.text).toContain('was just completed: task 1');
		expect(fake.userMessages.at(-1)?.text).toContain('action "log" for task 1');
		expect(fake.userMessages.at(-1)?.text).toContain('do not add another');

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

		// The recording prompt names the completed task directly and is idempotent:
		// the model checks the task's completion log before adding an entry.
		const prompt = fake.userMessages.at(-1)?.text ?? '';
		expect(prompt).toContain('was just completed: task 1');
		expect(prompt).toContain('action "log" for task 1');
		expect(prompt).toContain('action "list"');
		expect(prompt).toContain('do not add another');
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

	test('ralph_todo complete with a note records the completion log entry in the same call', async () => {
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
		const file = () => readFile(join(dir, 'TODO.ralph'), 'utf8');

		// complete with a note: the note becomes the completion log entry, and the
		// result says so — the model never has to guess whether it was recorded.
		const done = await run({ action: 'complete', task: '1', note: 'Replaced the README. Verified: bun test.' });
		expect(done.content[0]!.text).toContain('Marked task 1 "Establish a clean local developer contract." done');
		expect(done.content[0]!.text).toContain('recorded the completion log entry');
		expect(await file()).toContain('D 1');
		expect(await file()).toContain('Replaced the README. Verified: bun test.');

		// The entry shows in the task detail view.
		const detail = await run({ action: 'list', task: '1' });
		expect(detail.content[0]!.text).toContain('Replaced the README. Verified: bun test.');

		// complete without a note: no entry is recorded, and the result says nothing about one.
		const plain = await run({ action: 'complete', task: '2' });
		expect(plain.content[0]!.text).toContain('Marked task 2 "Remove starter/demo surfaces." done');
		expect(plain.content[0]!.text).not.toContain('recorded the completion log entry');
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

describe('ralph-loop extension (goal mode start)', () => {
	const GOAL_OPEN = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.

T 1 - "Port the routes."
`;

	const GOAL_DONE = `# ralph v2

G "Rewrite the app" done
GE "All routes render."

T 1 - "Port the routes."
D 1
`;

	const GOAL_NO_TASKS = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
`;

	const RALPH_FINISHED = `# ralph v2

T 1 - "Task one"
D 1

T 2 - "Task two"
D 2
`;

	const stateEntries = (fake: ReturnType<typeof createFakePi>) =>
		fake.entries.filter((entry) => entry.customType === 'ralph-loop-state');

	test('start --goal is refused when the backlog has no goal', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'TODO.ralph'), RALPH_V1);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo TODO.ralph --goal', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('has no goal');
	});

	test('start --goal is refused when the goal is already complete', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_DONE);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('goal is already complete');
	});

	test('start --goal starts with an open goal and zero open tasks', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_NO_TASKS);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);
		expect(statusLine(fakeCtx.widgets)).toContain('task: 0/0 (iteration 1)');
		expect(stateEntries(fake).at(-1)!.data.mode).toBe('goal');
	});

	test('start --goal starts with an open goal and open tasks', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_OPEN);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);
		expect(statusLine(fakeCtx.widgets)).toContain('task: 1/1 (iteration 1)');
		expect(stateEntries(fake).at(-1)!.data.mode).toBe('goal');
	});

	test('start without --goal is unchanged: finished backlog refused, goal ignored', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'FINISHED.ralph'), RALPH_FINISHED);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_OPEN);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;

		await ralph.handler('start --todo FINISHED.ralph', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('all TODO items are complete');

		// A goal in the backlog does not change task-mode validation.
		fakeCtx.notifications.length = 0;
		await ralph.handler('start --todo GOAL.ralph', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);
		expect(statusLine(fakeCtx.widgets)).toContain('task: 1/1 (iteration 1)');
		expect(stateEntries(fake).at(-1)!.data.mode).toBe('tasks');
	});

	test('goal mode round-trips through persisted state and survives an exhausted plan', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_NO_TASKS);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);

		const entry = stateEntries(fake).at(-1)!;
		expect(entry.data.mode).toBe('goal');

		// Reload the session: the goal loop stays active with zero open tasks
		// (the planning state) instead of stopping as a finished task loop.
		const reloaded = createFakePi();
		extension(reloaded.pi as never);
		const reloadedCtx = createFakeCtx(dir);
		reloadedCtx.ctx.sessionManager.getBranch = () => [entry];
		await reloaded.fire('session_start', reloadedCtx.ctx, { reason: 'startup' });
		await reloaded.commands.get('ralph')!.handler('status', reloadedCtx.ctx);
		expect(reloadedCtx.notifications.at(-1)?.message).toContain('Ralph loop is active');
	});

	test('persisted state without a mode normalizes to the task loop', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_NO_TASKS);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		expect(fake.userMessages.length).toBe(1);

		// A session persisted before the mode existed: strip it and reload.
		// The exhausted plan now stops the loop, exactly as task mode always did.
		const legacy = { ...stateEntries(fake).at(-1)!, data: { ...stateEntries(fake).at(-1)!.data, mode: undefined } };
		const reloaded = createFakePi();
		extension(reloaded.pi as never);
		const reloadedCtx = createFakeCtx(dir);
		reloadedCtx.ctx.sessionManager.getBranch = () => [legacy];
		await reloaded.fire('session_start', reloadedCtx.ctx, { reason: 'startup' });
		await reloaded.commands.get('ralph')!.handler('status', reloadedCtx.ctx);
		expect(reloadedCtx.notifications.at(-1)?.message).toBe('Ralph loop is stopped');
	});
});

describe('ralph-loop extension (goal loop prompts)', () => {
	const GOAL_PLANNING = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
  - Port the state.
`;

	const GOAL_EXECUTION = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
  - Port the state.

T 1 - "Port the routes."

T 2 - "Port the state."
`;

	const GOAL_REEVALUATION = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
  - Port the state.

T 1 - "Port the routes."
D 1

T 2 - "Port the state."
D 2
`;

	async function startGoalLoop(content: string, goal = true) {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), content);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await fake.commands.get('ralph')!.handler(`start --todo GOAL.ralph${goal ? ' --goal' : ''}`, fakeCtx.ctx);
		return { fake, fakeCtx };
	}

	test('planning prompt: goal open, zero tasks', async () => {
		const { fake } = await startGoalLoop(GOAL_PLANNING);
		const prompt = fake.userMessages[0].text;
		expect(prompt).toContain('Run the Ralph goal loop');
		expect(prompt).toContain('The goal is "Rewrite the app" (status: open).');
		expect(prompt).toContain('Port the routes.');
		expect(prompt).toContain('Port the state.');
		expect(prompt).toContain('This is a planning iteration: the goal is open and the backlog has no tasks yet.');
		expect(prompt).toContain('Decompose the goal into small, ordered tasks');
		expect(prompt).toContain('action "add-many"');
		expect(prompt).toContain('Do not implement the goal in this iteration');
		// Planning does not select a task.
		expect(prompt).not.toContain('action "next"');
	});

	test('execution prompt: goal open, open tasks', async () => {
		const { fake } = await startGoalLoop(GOAL_EXECUTION);
		const prompt = fake.userMessages[0].text;
		expect(prompt).toContain('Run the Ralph goal loop');
		expect(prompt).toContain('The goal is "Rewrite the app" (status: open).');
		expect(prompt).toContain('You are executing the goal');
		expect(prompt).toContain('keep the plan honest');
		expect(prompt).toContain('add or adjust tasks with ralph_todo');
		// The task workflow is the task prompt plus the goal context.
		expect(prompt).toContain('action "next"');
		expect(prompt).toContain('action "complete"');
		expect(prompt).not.toContain('planning iteration');
		expect(prompt).not.toContain('re-evaluation iteration');
	});

	test('re-evaluation prompt: goal open, tasks exist, none open', async () => {
		const { fake } = await startGoalLoop(GOAL_REEVALUATION);
		const prompt = fake.userMessages[0].text;
		expect(prompt).toContain('Run the Ralph goal loop');
		expect(prompt).toContain('This is a re-evaluation iteration: the goal is open and every planned task is complete.');
		expect(prompt).toContain('Re-check every acceptance criterion of the goal against the repository');
		expect(prompt).toContain('add tasks for the missing work with ralph_todo');
		expect(prompt).toContain('ralph_goal with action "complete"');
		expect(prompt).not.toContain('action "next"');
	});

	test('task-less goal iterations checkpoint via ralph_goal', async () => {
		const { fake, fakeCtx } = await startGoalLoop(GOAL_PLANNING);

		// The planning iteration settles at/above the context threshold.
		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);

		const prompt = fake.userMessages.at(-1)!.text;
		expect(prompt).toContain('durable checkpoint');
		expect(prompt).toContain('iteration 1 of 10');
		expect(prompt).toContain('ralph_goal with action "checkpoint"');
		expect(prompt).toContain('keep only the single most recent one');
		// The task checkpoint tool is not offered for a task-less iteration.
		expect(prompt).not.toContain('ralph_todo');
	});

	test('goal execution iterations still checkpoint the task via ralph_todo', async () => {
		const { fake, fakeCtx } = await startGoalLoop(GOAL_EXECUTION);

		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);

		const prompt = fake.userMessages.at(-1)!.text;
		expect(prompt).toContain('durable checkpoint');
		expect(prompt).toContain('ralph_todo with action "checkpoint"');
		expect(prompt).not.toContain('ralph_goal');
	});

	test('task-mode prompt is unchanged when the backlog has a goal', async () => {
		const { fake } = await startGoalLoop(GOAL_EXECUTION, false);
		const prompt = fake.userMessages[0].text;
		expect(prompt).toContain('Run the Ralph loop for this repository');
		expect(prompt).not.toContain('goal loop');
		expect(prompt).not.toContain('planning iteration');
		expect(prompt).not.toContain('re-evaluation iteration');
		expect(prompt).not.toContain('executing the goal');
	});
});

describe('ralph-loop extension (ralph_goal tool)', () => {
	const GOAL_OPEN = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
  - Port the state.
`;

	const GOAL_OPEN_WITH_TASK = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.

T 1 - "Port the routes."
`;

	const GOAL_OPEN_TASKS_DONE = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.

T 1 - "Port the routes."
D 1
`;

	const GOAL_CLAIMED = `# ralph v2

G "Rewrite the app" claimed
GE "All routes render."
`;

	const GOAL_CLAIMED_WITH_TASK = `# ralph v2

G "Rewrite the app" claimed
GE "All routes render."

T 1 - "Port the routes."
`;

	const GOAL_DONE = `# ralph v2

G "Rewrite the app" done
GE "All routes render."
`;

	type GoalTool = {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown
		) => Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }>;
	};

	const goalTool = (fake: ReturnType<typeof createFakePi>): GoalTool => {
		const tool = fake.tools.get('ralph_goal') as GoalTool | undefined;
		expect(tool).toBeDefined();
		return tool!;
	};

	async function startLoopWith(content: string, mode: 'goal' | 'tasks' = 'goal') {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), content);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await fake.commands.get('ralph')!.handler(`start --todo GOAL.ralph${mode === 'goal' ? ' --goal' : ''}`, fakeCtx.ctx);
		return { fake, fakeCtx, run: (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx) };
	}

	test('show works outside a loop on TODO.ralph', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await writeFile(join(dir, 'TODO.ralph'), GOAL_OPEN);

		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);
		const shown = await run({ action: 'show' });
		expect(shown.content[0]!.text).toContain('Goal: "Rewrite the app" (status: open)');
		expect(shown.content[0]!.text).toContain('Port the routes.');
		expect(shown.content[0]!.text).toContain('Port the state.');
		expect(shown.content[0]!.text).not.toContain('Evidence');
		expect(shown.content[0]!.text).not.toContain('Checkpoint');

		// A done goal shows its completion evidence.
		await writeFile(join(dir, 'TODO.ralph'), GOAL_DONE);
		const done = await run({ action: 'show' });
		expect(done.content[0]!.text).toContain('(status: done)');
		expect(done.content[0]!.text).toContain('Evidence: All routes render.');
	});

	test('show reports a missing goal, a missing file, and a non-ralph file', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);

		await writeFile(join(dir, 'TODO.ralph'), RALPH_V1);
		const noGoal = await run({ action: 'show' });
		expect(noGoal.content[0]!.text).toContain('No goal in');

		await rm(join(dir, 'TODO.ralph'));
		await expect(run({ action: 'show' })).rejects.toThrow(/No Ralph backlog/);

		await writeFile(join(dir, 'TODO.ralph'), '# Plain\n\n- [ ] task\n');
		await expect(run({ action: 'show' })).rejects.toThrow(/not a ralph-format backlog/);
	});

	test('show targets the active loop\'s backlog, not TODO.ralph', async () => {
		const { fake, run } = await startLoopWith(GOAL_OPEN);
		await writeFile(join(dir, 'TODO.ralph'), GOAL_DONE);

		const shown = await run({ action: 'show' });
		expect(shown.content[0]!.text).toContain('(status: open)');
		expect(shown.content[0]!.text).not.toContain('Evidence');
		expect(fake.userMessages.length).toBe(1);
	});

	test('checkpoint requires an active goal loop and a note', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await writeFile(join(dir, 'TODO.ralph'), GOAL_OPEN);
		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);

		// No loop at all.
		await expect(run({ action: 'checkpoint', note: 'x' })).rejects.toThrow(/active Ralph loop/);

		// A task-mode loop is not a goal loop.
		const taskLoop = await startLoopWith(GOAL_OPEN_WITH_TASK, 'tasks');
		await expect(taskLoop.run({ action: 'checkpoint', note: 'x' })).rejects.toThrow(/active goal loop/);

		// A goal loop still needs the note.
		const goalLoop = await startLoopWith(GOAL_OPEN);
		await expect(goalLoop.run({ action: 'checkpoint' })).rejects.toThrow(/requires a note/);
	});

	test('checkpoint replaces the single goal checkpoint in the file', async () => {
		const { run } = await startLoopWith(GOAL_OPEN);
		const file = () => readFile(join(dir, 'GOAL.ralph'), 'utf8');

		const first = await run({ action: 'checkpoint', note: 'Plan drafted; next: review the routes.' });
		expect(first.content[0]!.text).toContain('Checkpoint recorded for the goal "Rewrite the app" (iteration 1)');
		let text = await file();
		expect(text).toContain('GC 1');
		expect(text).toContain('Plan drafted; next: review the routes.');

		// The checkpoint is replaced, never stacked.
		const second = await run({ action: 'checkpoint', note: 'Plan reviewed; next: start execution.' });
		expect(second.content[0]!.text).toContain('(iteration 1)');
		text = await file();
		expect(text).toContain('Plan reviewed; next: start execution.');
		expect(text).not.toContain('Plan drafted; next: review the routes.');
		const goal = Backlog.parse(text).goal()!;
		expect(goal.checkpoint).toBe('Plan reviewed; next: start execution.');
		expect(goal.checkpointIteration).toBe(1);
		// The file stays valid ralph format.
		expect(text.startsWith('# ralph v2')).toBe(true);
	});

	test('complete requires an active goal loop, an open goal, no open tasks, and evidence', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await writeFile(join(dir, 'TODO.ralph'), GOAL_OPEN);
		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);

		// No loop at all.
		await expect(run({ action: 'complete', note: 'verified' })).rejects.toThrow(/active Ralph loop/);

		// A task-mode loop is not a goal loop.
		const taskLoop = await startLoopWith(GOAL_OPEN_WITH_TASK, 'tasks');
		await expect(taskLoop.run({ action: 'complete', note: 'verified' })).rejects.toThrow(/active goal loop/);

		// Open tasks block completion; the file is untouched.
		const openTasks = await startLoopWith(GOAL_OPEN_WITH_TASK);
		await expect(openTasks.run({ action: 'complete', note: 'verified' })).rejects.toThrow(/1 task still open/);
		expect(await readFile(join(dir, 'GOAL.ralph'), 'utf8')).toContain('G "Rewrite the app" open');

		// Missing evidence is refused before any state change.
		const noEvidence = await startLoopWith(GOAL_OPEN_TASKS_DONE);
		await expect(noEvidence.run({ action: 'complete' })).rejects.toThrow(/verification evidence/);

		// A claimed goal cannot be completed again.
		const claimed = await startLoopWith(GOAL_CLAIMED);
		await expect(claimed.run({ action: 'complete', note: 'verified' })).rejects.toThrow(/complete requires open/);

		// A claimed goal (from a pending approval) cannot be completed again
		// either: complete only claims; the approval flow confirms.
		const finished = await startLoopWith(GOAL_OPEN_TASKS_DONE);
		await finished.run({ action: 'complete', note: 'verified' });
		await expect(finished.run({ action: 'complete', note: 'verified' })).rejects.toThrow(/complete requires open/);
	});

	test('complete claims the goal, blocks the loop, and terminates the turn', async () => {
		const { fake, fakeCtx, run } = await startLoopWith(GOAL_OPEN_TASKS_DONE);

		const result = await run({ action: 'complete', note: 'All criteria verified: bun test green.' });
		// The turn terminates so the model cannot act before the user answers.
		expect(result.terminate).toBe(true);
		// The result instructs the after-answer procedure for both outcomes.
		expect(result.content[0]!.text).toContain('claimed');
		expect(result.content[0]!.text).toContain('ralph_resolve_decision');
		expect(result.content[0]!.text).toContain('ralph_goal with action "confirm"');
		expect(result.content[0]!.text).toContain('ralph_goal with action "withdraw"');

		// The goal is claimed (not done) with the evidence in the file.
		const text = await readFile(join(dir, 'GOAL.ralph'), 'utf8');
		expect(text).toContain('G "Rewrite the app" claimed');
		expect(text).toContain('GE "All criteria verified: bun test green."');
		const goal = Backlog.parse(text).goal()!;
		expect(goal.status).toBe('claimed');
		expect(goal.evidence).toBe('All criteria verified: bun test green.');
		// The file stays valid ralph format.
		expect(text.startsWith('# ralph v2')).toBe(true);

		// The loop is blocked: the status shows waiting, the decision widget is
		// set, and the user is notified.
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: waiting');
		expect(fakeCtx.widgets.has('ralph-decision')).toBe(true);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('paused');
	});

	test('complete goes straight to done when auto-approve decisions is enabled', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(
			join(dir, '.pi', 'ralph-loop.json'),
			`${JSON.stringify({ contextThresholds: {}, autoApproveDecisions: true, maxIterations: 10 }, null, '\t')}\n`
		);
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_OPEN_TASKS_DONE);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await fake.commands.get('ralph')!.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);

		// Delegated approval: the claim is confirmed immediately, no block, no
		// terminated turn.
		const result = await run({ action: 'complete', note: 'All criteria verified: bun test green.' });
		expect(result.terminate).toBeUndefined();
		expect(result.content[0]!.text).toContain('Goal "Rewrite the app" is done (approver: auto-approved)');

		const text = await readFile(join(dir, 'GOAL.ralph'), 'utf8');
		expect(text).toContain('G "Rewrite the app" done');
		expect(text).toContain('GE "All criteria verified: bun test green."');
		expect(statusLine(fakeCtx.widgets)).not.toContain('waiting');
	});

	test('confirm requires an active goal loop and a claimed goal', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await writeFile(join(dir, 'TODO.ralph'), GOAL_CLAIMED);
		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);

		// No loop at all.
		await expect(run({ action: 'confirm' })).rejects.toThrow(/active Ralph loop/);

		// A task-mode loop is not a goal loop.
		const taskLoop = await startLoopWith(GOAL_CLAIMED_WITH_TASK, 'tasks');
		await expect(taskLoop.run({ action: 'confirm' })).rejects.toThrow(/active goal loop/);

		// An open goal cannot be confirmed.
		const open = await startLoopWith(GOAL_OPEN);
		await expect(open.run({ action: 'confirm' })).rejects.toThrow(/confirm requires claimed/);
	});

	test('confirm marks a claimed goal done, keeping its evidence', async () => {
		const { run } = await startLoopWith(GOAL_CLAIMED);

		const result = await run({ action: 'confirm' });
		expect(result.terminate).toBeUndefined();
		expect(result.content[0]!.text).toContain('Goal "Rewrite the app" is done (approved)');

		const text = await readFile(join(dir, 'GOAL.ralph'), 'utf8');
		expect(text).toContain('G "Rewrite the app" done');
		expect(text).toContain('GE "All routes render."');
		const goal = Backlog.parse(text).goal()!;
		expect(goal.status).toBe('done');
		expect(goal.evidence).toBe('All routes render.');
		// The file stays valid ralph format.
		expect(text.startsWith('# ralph v2')).toBe(true);
	});

	test('withdraw requires an active goal loop, a claimed goal, and a note', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await writeFile(join(dir, 'TODO.ralph'), GOAL_CLAIMED);
		const run = (params: Record<string, unknown>) => goalTool(fake).execute('t', params, undefined, undefined, fakeCtx.ctx);

		// No loop at all.
		await expect(run({ action: 'withdraw', note: 'missing' })).rejects.toThrow(/active Ralph loop/);

		// A task-mode loop is not a goal loop.
		const taskLoop = await startLoopWith(GOAL_CLAIMED_WITH_TASK, 'tasks');
		await expect(taskLoop.run({ action: 'withdraw', note: 'missing' })).rejects.toThrow(/active goal loop/);

		// An open goal cannot be withdrawn.
		const open = await startLoopWith(GOAL_OPEN);
		await expect(open.run({ action: 'withdraw', note: 'missing' })).rejects.toThrow(/withdraw requires claimed/);

		// A claimed goal still needs the note.
		const claimed = await startLoopWith(GOAL_CLAIMED);
		await expect(claimed.run({ action: 'withdraw' })).rejects.toThrow(/requires a note/);
	});

	test('withdraw returns a claimed goal to open with the note as checkpoint', async () => {
		const { run } = await startLoopWith(GOAL_CLAIMED);

		const result = await run({ action: 'withdraw', note: 'Criterion 2 not met: the state was not ported.' });
		expect(result.terminate).toBeUndefined();
		expect(result.content[0]!.text).toContain('open again');

		const text = await readFile(join(dir, 'GOAL.ralph'), 'utf8');
		expect(text).toContain('G "Rewrite the app" open');
		const goal = Backlog.parse(text).goal()!;
		expect(goal.status).toBe('open');
		expect(goal.evidence).toBeNull();
		expect(goal.checkpoint).toBe('Criterion 2 not met: the state was not ported.');
		// The file stays valid ralph format.
		expect(text.startsWith('# ralph v2')).toBe(true);
	});
});

describe('ralph-loop extension (goal loop stop)', () => {
	const GOAL_NO_TASKS = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
  - Port the state.
`;

	const GOAL_OPEN_TASKS_DONE = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.

T 1 - "Port the routes."
D 1
`;

	const GOAL_EXECUTION = `# ralph v2

G "Rewrite the app" open
GB
  - Port the routes.
  - Port the state.

T 1 - "Port the routes."

T 2 - "Port the state."
`;

	type GoalTool = {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown
		) => Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }>;
	};

	async function startGoalLoopWith(content: string) {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await writeFile(join(dir, 'GOAL.ralph'), content);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		await fake.commands.get('ralph')!.handler('start --todo GOAL.ralph --goal', fakeCtx.ctx);
		const goal = fake.tools.get('ralph_goal') as GoalTool;
		const todo = fake.tools.get('ralph_todo') as GoalTool;
		return {
			fake,
			fakeCtx,
			run: (params: Record<string, unknown>) => goal.execute('t', params, undefined, undefined, fakeCtx.ctx),
			todo: (params: Record<string, unknown>) => todo.execute('t', params, undefined, undefined, fakeCtx.ctx)
		};
	}

	test('agent_settled stops the goal loop after the approved completion', async () => {
		const { fake, fakeCtx, run } = await startGoalLoopWith(GOAL_OPEN_TASKS_DONE);

		// The re-evaluation iteration verifies the goal and claims it: the loop
		// blocks pending the user's approval and the turn terminates.
		const result = await run({ action: 'complete', note: 'All criteria verified: bun test green.' });
		expect(result.terminate).toBe(true);
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: waiting');

		// The blocked turn settles: nothing rotates, nothing stops.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: waiting');

		// The user approves; the model records the decision and resolves it.
		const resolve = fake.tools.get('ralph_resolve_decision') as GoalTool;
		await resolve.execute(
			't',
			{ recordPath: 'docs/decisions/goal.md', resolution: 'Goal approved' },
			undefined,
			undefined,
			fakeCtx.ctx
		);

		// The model confirms the goal; the settle stops the loop on the done goal.
		await run({ action: 'confirm' });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('goal is complete');
	});

	test('agent_settled stops the goal loop when a planning iteration makes no progress', async () => {
		const { fake, fakeCtx } = await startGoalLoopWith(GOAL_NO_TASKS);

		// The planning iteration settles without adding any tasks (no progress).
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('made no progress');
	});

	test('agent_settled stops the goal loop when a re-evaluation iteration makes no progress', async () => {
		const { fake, fakeCtx } = await startGoalLoopWith(GOAL_OPEN_TASKS_DONE);

		// The re-evaluation iteration settles without adding tasks or completing the goal.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('made no progress');
	});

	test('agent_settled rotates a planning iteration that adds tasks into an execution iteration', async () => {
		const { fake, fakeCtx } = await startGoalLoopWith(GOAL_NO_TASKS);

		// The planning iteration decomposes the goal into tasks (the plan grew) and settles.
		await writeFile(join(dir, 'GOAL.ralph'), GOAL_EXECUTION);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// A commit-only recording turn runs before the fresh iteration: the plan
		// update is committed, but no completion log entry is written.
		let status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: recording');
		const recordingPrompt = fake.userMessages.at(-1)?.text ?? '';
		expect(recordingPrompt).toContain('plan was just updated');
		expect(recordingPrompt).toContain('Check git status');
		expect(recordingPrompt).toContain('Do not push');
		expect(recordingPrompt).toContain('Do not add a completion log entry');
		expect(recordingPrompt).toContain('Do not start work on the new tasks');
		expect(recordingPrompt).not.toContain('action "log"');

		// The recording turn settles: the fresh iteration starts in the execution phase.
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: starting');
		expect(status).toContain('iteration 2/10');
		expect(status).toContain('task: 1/2 (iteration 2)');

		fakeCtx.usagePercent.value = 10;
		await fake.fire('message_update', fakeCtx.ctx);
		status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: on');
		const iterationPrompt = fake.userMessages.at(-1)?.text ?? '';
		expect(iterationPrompt).toContain('The plan was just updated with new tasks');
		expect(iterationPrompt).toContain('You are executing the goal');
		expect(iterationPrompt).toContain('action "next"');
		expect(fakeCtx.notifications.some((n) => n.message.includes('made no progress'))).toBe(false);
	});

	test('agent_settled does not rotate when tasks are edited without changing the open set', async () => {
		const { fake, fakeCtx } = await startGoalLoopWith(GOAL_EXECUTION);

		// The execution iteration rewords a task (same ids, same open set) and settles.
		const edited = GOAL_EXECUTION.replace('T 1 - "Port the routes."', 'T 1 - "Port the HTTP routes."');
		await writeFile(join(dir, 'GOAL.ralph'), edited);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// No rotation: the open set is unchanged, so no recording turn and no fresh iteration.
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: on');
		expect(statusLine(fakeCtx.widgets)).toContain('iteration 1/10');
		expect(fake.userMessages.length).toBe(1);
		expect(fakeCtx.notifications.some((n) => n.message.includes('made no progress'))).toBe(false);
	});

	test('startFreshIteration does not start a fresh iteration once the goal is done', async () => {
		const { fake, fakeCtx, run, todo } = await startGoalLoopWith(GOAL_EXECUTION);

		// The execution iteration settles at/above the context threshold: a
		// context-limit rotation is queued (recording), not a stall.
		fakeCtx.usagePercent.value = 55;
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();
		expect(statusLine(fakeCtx.widgets)).toContain('checkpointing');

		// The recording turn completes the remaining tasks and claims the goal:
		// the loop blocks pending the user's approval.
		await todo({ action: 'complete', task: '1', note: 'done' });
		await todo({ action: 'complete', task: '2', note: 'done' });
		const result = await run({ action: 'complete', note: 'All criteria verified: bun test green.' });
		expect(result.terminate).toBe(true);
		await fake.fire('message_end', fakeCtx.ctx, { message: { role: 'assistant', stopReason: 'stop' } });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// The blocked turn settles: the loop waits — it does not rotate or start
		// a fresh iteration.
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: waiting');

		// The user approves; the model resolves the decision and confirms the goal.
		const resolve = fake.tools.get('ralph_resolve_decision') as GoalTool;
		await resolve.execute(
			't',
			{ recordPath: 'docs/decisions/goal.md', resolution: 'Goal approved' },
			undefined,
			undefined,
			fakeCtx.ctx
		);
		await run({ action: 'confirm' });
		await fake.fire('agent_settled', fakeCtx.ctx);
		await flush();

		// The fresh iteration is not started; the loop stops on the done goal.
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: off');
		expect(fakeCtx.notifications.at(-1)?.message).toContain('goal is complete');
	});
});

describe('ralph-loop extension (/ralph home view)', () => {
	beforeEach(async () => {
		await writeFile(join(dir, 'TODO.md'), RALPH_MD);
	});

	test('bare /ralph opens the home view for the active loop; enter opens the task view, q closes it', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await ralph.handler('import TODO.md', fakeCtx.ctx);
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);

		// One overlay hosts both stages, so the chat scroll position is
		// untouched and the stages swap without the chat flashing through.
		await ralph.handler('', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1);
		expect(fakeCtx.customOptions[0]).toEqual({
			overlay: true,
			overlayOptions: { width: '100%', maxHeight: '90%' }
		});
		let closed: string | undefined;
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, (r?: string) => {
			closed = r;
		}) as { render: (width: number) => string[]; handleInput: (data: string) => void };
		// The home view shows the list rows (the import stamped "General");
		// with no goal the (all) row is highlighted first.
		const home = component.render(100).join('\n');
		expect(home).toContain('Ralph home — TODO.ralph');
		expect(home).toContain('> (all) — 2 open / 3 total');
		expect(home).toContain('General — 2 open / 3 total');
		// Enter on (all) opens the unchanged task view.
		component.handleInput('\r');
		const rendered = component.render(100).join('\n');
		expect(rendered).toContain('Ralph backlog — TODO.ralph');
		expect(rendered).toContain('Establish a clean local developer contract.');
		// No separate completion log section in the view.
		expect(rendered).not.toContain('Completion log');
		component.handleInput('q');
		expect(closed).toBe('quit');
	});

	test('opens the task view scoped to the list chosen in the home view', async () => {
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

		await ralph.handler('', fakeCtx.ctx);
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		// Rows: (all), dossier, auth (first-appearance order). Highlight
		// dossier and open it.
		component.handleInput('j');
		component.handleInput('\r');
		const rendered = component.render(100).join('\n');
		expect(rendered).toContain('category "dossier"');
		expect(rendered).toContain('Establish a clean local developer contract.');
		expect(rendered).not.toContain('Add sign-in.');
	});

	test('shows the lists with counts; enter opens the task view for each list', async () => {
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

		// The home view opens on the lists; selecting one swaps to the view
		// scoped to it (the same overlay).
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1);
		expect(fakeCtx.customOptions[0]).toEqual({ overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } });
		const host = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		// The home view shows one row per list with open/total counts.
		const homeText = host.render(100).join('\n');
		expect(homeText).toContain('Ralph home — TODO.ralph');
		expect(homeText).toContain('> (all) — 3 open / 4 total');
		expect(homeText).toContain('General — 2 open / 3 total');
		expect(homeText).toContain('Email — 1 open / 1 total');
		expect(homeText).toContain('R: rename list');
		// Like the task view: pinned to the top, padded to 90% of the
		// terminal height, key hints on the bottom line.
		const homeLines = host.render(100);
		expect(homeLines.length).toBe(Math.max(10, Math.floor((process.stdout.rows ?? 40) * 0.9)));
		expect(homeLines[0]).toContain('Ralph home');
		expect(homeLines[homeLines.length - 1]).toContain('q: quit');
		// Selecting a list swaps to the view scoped to it (same overlay).
		host.handleInput('j'); // General
		host.handleInput('\r');
		expect(host.render(100).join('\n')).toContain('category "General"');
		expect(host.render(100).join('\n')).not.toContain('Fetch mail.');

		// Picking the second list scopes the view to it.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		const second = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		second.handleInput('j'); // General
		second.handleInput('j'); // Email
		second.handleInput('\r');
		const rendered = second.render(100).join('\n');
		expect(rendered).toContain('category "Email"');
		expect(rendered).toContain('Fetch mail.');
		expect(rendered).not.toContain('Establish a clean local developer contract.');

		// Escape in the view goes back to the home view inside the same
		// overlay; q in the home view closes it.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		let closed = false;
		let result: string | undefined;
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, (r?: string) => {
			closed = true;
			result = r;
		}) as { render: (width: number) => string[]; handleInput: (data: string) => void };
		component.handleInput('j');
		component.handleInput('\r'); // open the General view
		component.handleInput('\x1b'); // back to the home view
		expect(component.render(100).join('\n')).toContain('Ralph home');
		expect(closed).toBe(false);
		component.handleInput('q');
		expect(closed).toBe(true);
		expect(result).toBeUndefined();

		// Re-opening a list from the home view swaps back to the view.
		component.handleInput('\r'); // (all) row
		expect(component.render(100).join('\n')).toContain('Ralph backlog — TODO.ralph');
	});

	test('R renames the highlighted list from the home view', async () => {
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

		// The home view opens; close it after the rename round.
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		const home = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};

		// Highlight General; R starts the inline rename prefilled with its
		// name. Appending and pressing enter saves it to disk.
		home.handleInput('j');
		home.handleInput('R');
		home.handleInput('2');
		home.handleInput('\r');
		await flush();
		const onDisk = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(onDisk.categories()).toEqual(['General2', 'Email']);
		expect(onDisk.listTasks().find((t) => t.title === 'Establish a clean local developer contract.')?.category).toBe('General2');
		// The home view shows the renamed list in place with a saved notice.
		const renamed = home.render(100).join('\n');
		expect(renamed).toContain('> General2 — 2 open / 3 total');
		expect(renamed).toContain('saved');

		// Colliding names are refused: the row keeps its name, nothing is written.
		home.handleInput('R');
		for (let i = 0; i < 'General2'.length; i += 1) home.handleInput('\x7f');
		for (const ch of 'Email') home.handleInput(ch);
		home.handleInput('\r');
		await flush();
		const after = Backlog.parse(await readFile(join(dir, 'TODO.ralph'), 'utf8'));
		expect(after.categories()).toEqual(['General2', 'Email']);
		expect(home.render(100).join('\n')).toContain('not saved');

		// Escape cancels the inline rename.
		home.handleInput('R');
		home.handleInput('x');
		home.handleInput('\x1b');
		expect(home.render(100).join('\n')).toContain('> General2 — 2 open / 3 total');
	});

	test('falls back to a file argument, then conventional names; errors without TUI', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;

		// No loop, no TODO.ralph: a Markdown TODO.md has no todo entries; the
		// view suggests importing it instead.
		await ralph.handler('', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toBe('Todo entries empty. Import data with /ralph import');

		// Explicit file argument wins.
		await ralph.handler('import TODO.md', fakeCtx.ctx);
		fakeCtx.customFactories.length = 0;
		// The import stamped the "General" list; opening it shows the view.
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		const host = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		host.handleInput('\r');
		expect(host.render(100).join('\n')).toContain('Ralph backlog — TODO.ralph');

		// Missing file: error notification, no view.
		fakeCtx.notifications.length = 0;
		fakeCtx.customFactories.length = 0;
		await ralph.handler('missing.md', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Could not read missing.md');

		// Non-TUI mode: bare /ralph shows the usage, a file argument errors.
		fakeCtx.notifications.length = 0;
		(fakeCtx.ctx as { mode: string }).mode = 'rpc';
		await ralph.handler('', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Usage: /ralph');
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(fakeCtx.notifications.at(-1)?.message).toContain('Unknown subcommand');
	});

	test('edits from the task view are written back to the backlog file', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await importTodo(fake, fakeCtx, 'import TODO.md --category General');

		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		// The home view opens first; opening the (all) row swaps to the view.
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

		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		let closed: string | undefined;
		const component = fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, (r?: string) => {
			closed = r;
		}) as { handleInput: (data: string) => void };
		component.handleInput('j'); // General
		component.handleInput('j'); // Email
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

	test('the home view refreshes after a task-view round renames a list', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await importTodo(fake, fakeCtx, 'import TODO.md --category General');

		const created: unknown[] = [];
		fakeCtx.customControl.factoryHook = (component) => created.push(component);
		const handler = ralph.handler('TODO.ralph', fakeCtx.ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const host = created[0] as { render: (width: number) => string[]; handleInput: (data: string) => void };
		// Open the General view, rename the list from the view, and go back
		// to the home view.
		host.handleInput('j');
		host.handleInput('\r');
		host.handleInput('R');
		host.handleInput('x');
		host.handleInput('\r');
		await flush();
		host.handleInput('\x1b');
		// The home view re-read the file: the list is renamed.
		expect(host.render(100).join('\n')).toContain('Generalx — 2 open / 3 total');
		host.handleInput('q');
		await handler;
		fakeCtx.customControl.factoryHook = undefined;
	});

	test('dispatch: subcommands stay, a bare /ralph and a file argument open the home view', async () => {
		const fake = createFakePi();
		extension(fake.pi as never);
		const fakeCtx = createFakeCtx(dir);
		await fake.fire('session_start', fakeCtx.ctx, { reason: 'startup' });
		const ralph = fake.commands.get('ralph')!;
		await importTodo(fake, fakeCtx, 'import TODO.md --category General');

		// Bare /ralph opens the home view on the conventional backlog.
		await ralph.handler('', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1);
		expect(
			(fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as { render: (w: number) => string[] }).render(100).join('\n')
		).toContain('Ralph home — TODO.ralph');

		// A first argument that is not a subcommand is a backlog file.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('TODO.ralph', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(1);
		expect(
			(fakeCtx.customFactories[0]!({ requestRender: () => {} }, fakeTheme, undefined, () => {}) as { render: (w: number) => string[] }).render(100).join('\n')
		).toContain('Ralph home — TODO.ralph');

		// Known subcommands are untouched: start still starts the task loop.
		fakeCtx.customFactories.length = 0;
		await ralph.handler('start --todo TODO.ralph', fakeCtx.ctx);
		expect(fakeCtx.customFactories.length).toBe(0);
		expect(statusLine(fakeCtx.widgets)).toContain('Ralph: on');

		// The command description and argument completions no longer offer
		// the removed todos subcommand.
		const command = fake.commands.get('ralph') as unknown as {
			description: string;
			getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null;
		};
		expect(command.description).not.toContain('todos');
		for (const prefix of ['', 't', 's', 'i', 'st', 're', 'co']) {
			const values = (command.getArgumentCompletions(prefix) ?? []).map((o) => o.value);
			expect(values).not.toContain('todos');
		}
		expect((command.getArgumentCompletions('') ?? []).map((o) => o.value)).toEqual([
			'start',
			'import',
			'stop',
			'resume',
			'status',
			'config'
		]);
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
