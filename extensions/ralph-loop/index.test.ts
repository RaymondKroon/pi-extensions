import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from './index.ts';

/**
 * Drives the real extension module with a fake ExtensionAPI and asserts the
 * rotation lifecycle: context-limit checkpoints, completed-task rotations,
 * iteration/task counters, the max-iterations stop, and the status widget
 * content after every transition.
 */

const TODO_V1 = `# Backlog

- [ ] Task one
- [ ] Task two
- [ ] Task three
`;

const TODO_V2_TASK_ONE_DONE = `# Backlog

- [x] Task one
- [ ] Task two
- [ ] Task three
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
			custom: (fn: unknown) => Promise<unknown>;
		};
	};
	widgets: Map<string, unknown>;
	notifications: FakeNotification[];
	usagePercent: { value: number };
	/** Whether the fake session reports itself idle (for /ralph stop). */
	idle: { value: boolean };
}

function createFakeCtx(cwd: string): FakeCtx {
	const widgets = new Map<string, unknown>();
	const notifications: FakeNotification[] = [];
	const usagePercent = { value: 10 };
	const idle = { value: true };

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
			custom: async () => undefined
		}
	};

	return { ctx, widgets, notifications, usagePercent, idle };
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
	await writeFile(join(dir, 'TODO.md'), TODO_V1);
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
		expect(fake.userMessages.at(-1)?.text).toContain('Context checkpoint (iteration 1)');
		// Only one checkpoint per item: a new one replaces the previous.
		expect(fake.userMessages.at(-1)?.text).toContain('keep only the single most recent checkpoint');

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
		await writeFile(join(dir, 'TODO.md'), TODO_V2_TASK_ONE_DONE);
		fakeCtx.usagePercent.value = 10;
		await fake.fire('agent_settled', fakeCtx.ctx);

		// A dedicated progress-recording turn runs before the fresh iteration.
		let status = statusLine(fakeCtx.widgets);
		expect(status).toContain('Ralph: recording');
		expect(fake.userMessages.at(-1)?.text).toContain('completion log');
		// The completion log is the single completion record.
		expect(fake.userMessages.at(-1)?.text).toContain('single completion record');

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
		expect(fake.userMessages.at(-1)?.text).toContain('do not also add a completion note under the checked item');
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

		await writeFile(join(dir, 'TODO.md'), TODO_V2_TASK_ONE_DONE);
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

		await writeFile(join(dir, 'TODO.md'), TODO_V2_TASK_ONE_DONE);
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
		await writeFile(join(dir, 'TODO.md'), TODO_V2_TASK_ONE_DONE);
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

		await writeFile(join(dir, 'TODO.md'), TODO_V2_TASK_ONE_DONE);
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
				await writeFile(join(dir, 'TODO.md'), TODO_V2_TASK_ONE_DONE);
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
