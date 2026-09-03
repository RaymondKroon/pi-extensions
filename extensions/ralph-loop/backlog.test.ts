import { describe, expect, test } from 'bun:test';
import {
	Backlog,
	BacklogParseError,
	formatBacklog,
	formatSearchResults,
	formatTaskDetail,
	isRalphBacklog
} from './backlog.ts';

// Numbers: 1, 2, 3, 4, 5 (the former sub-task is a flat task now).
const SAMPLE = `# ralph v2

T 1 dossier "Establish a clean local developer contract."
B 1
  - Replace the starter README with setup and test commands.
  - Acceptance: a new developer can install dependencies.
D 1

T 2 dossier "Remove starter/demo surfaces."
C 2 3
  Completed: schema removal. Next step: add the migration.

T 3 auth "Add sign-in."
T 4 - "Sub-task of P0.3"

T 5 - "Decide migration strategy."

L 1 1 2026-08-10
  Replaced the starter README. Verified: bun test.

L 2 5 2026-08-11
  Approved a greenfield-only migration boundary.
`;

describe('isRalphBacklog', () => {
	test('detects the ralph header as the first non-blank line', () => {
		expect(isRalphBacklog(SAMPLE)).toBe(true);
		expect(isRalphBacklog('# ralph v2\n')).toBe(true);
		// v1 files are still recognized: they auto-migrate to v2 on save.
		expect(isRalphBacklog('\n\n# ralph v1\n\nS 1 backlog "x"')).toBe(true);
	});

	test('rejects markdown and other text', () => {
		expect(isRalphBacklog('# Backlog\n\n- [ ] Task one\n')).toBe(false);
		expect(isRalphBacklog('')).toBe(false);
		expect(isRalphBacklog('# ralph v3\n')).toBe(false);
	});
});

describe('text format round-trip', () => {
	test('parse(render(parse(text))) is stable and render is idempotent', () => {
		const first = Backlog.parse(SAMPLE);
		const rendered = first.render();
		const second = Backlog.parse(rendered);
		expect(second.render()).toBe(rendered);
	});

	test('preserves tasks, bodies, checkpoints, and log entries', () => {
		const backlog = Backlog.parse(SAMPLE);

		const tasks = backlog.listTasks();
		expect(tasks).toHaveLength(5);
		const t1 = tasks.find((t) => t.id === 1);
		expect(t1).toMatchObject({
			done: true,
			category: 'dossier',
			body: '- Replace the starter README with setup and test commands.\n- Acceptance: a new developer can install dependencies.'
		});
		const t2 = tasks.find((t) => t.id === 2);
		expect(t2?.checkpoint).toBe('Completed: schema removal. Next step: add the migration.');
		expect(t2?.checkpointIteration).toBe(3);
		expect(t2?.done).toBe(false);
		const sub = tasks.find((t) => t.title === 'Sub-task of P0.3');
		expect(sub?.category).toBeNull();

		const log = backlog.listLogEntries();
		expect(log).toHaveLength(2);
		expect(log[0]).toMatchObject({ taskId: 1, date: '2026-08-10', note: 'Replaced the starter README. Verified: bun test.' });
	});

	test('escapes quotes and backslashes in titles', () => {
		const text = '# ralph v2\n\nT 1 - "Say \\\"hi\\\" \\\\ there"\n';
		const backlog = Backlog.parse(text);
		expect(backlog.listTasks()[0].title).toBe('Say "hi" \\ there');
		expect(backlog.render()).toContain('T 1 - "Say \\\"hi\\\" \\\\ there"');
	});

	test('tolerates legacy section records, task keys, and key log references', () => {
		const legacy = `# ralph v1

S 1 protocol "Ralph loop protocol"
SB 1
  1. Read the specification before every iteration.

S 2 backlog "Priority 0 — foundation"

T 1 2 - P0.1 dossier "Establish a clean local developer contract."
D 1

L 1 P0.1 2026-08-10
  Replaced the starter README.
`;
		const backlog = Backlog.parse(legacy);
		const task = backlog.findTaskByNumber('1');
		expect(task).toMatchObject({ done: true, category: 'dossier' });
		// The legacy key reference resolves to the task.
		expect(backlog.listLogEntriesForTask(task!.id)).toHaveLength(1);
		// render() writes the current form, which round-trips.
		const rendered = backlog.render();
		expect(rendered).not.toContain('S 1');
		expect(rendered).toContain('T 1 dossier "Establish a clean local developer contract."');
		expect(rendered).toContain('L 1 1 2026-08-10');
		const reloaded = Backlog.parse(rendered);
		expect(reloaded.findTaskByNumber('1')?.done).toBe(true);
		expect(reloaded.listLogEntriesForTask(1)).toHaveLength(1);
	});
});

describe('goal', () => {
	const GOAL_SAMPLE = `# ralph v2

M source "TODO.md"

G "Rewrite the app in the new framework" open
GB
  - Port the routes.
  - Port the state.
GE "All routes render; bun test green."
GC 4
  Completed: routes. Next step: state.

T 1 - "Port the routes."
`;

	test('round-trips a goal and render is idempotent', () => {
		const first = Backlog.parse(GOAL_SAMPLE);
		expect(first.goal()).toEqual({
			title: 'Rewrite the app in the new framework',
			status: 'open',
			body: '- Port the routes.\n- Port the state.',
			evidence: 'All routes render; bun test green.',
			checkpoint: 'Completed: routes. Next step: state.',
			checkpointIteration: 4
		});
		const rendered = first.render();
		expect(Backlog.parse(rendered).render()).toBe(rendered);
		// The goal block sits between the meta records and the first task.
		const lines = rendered.split('\n');
		expect(lines.indexOf('G "Rewrite the app in the new framework" open'))
			.toBeGreaterThan(lines.indexOf('M source "TODO.md"'));
		expect(lines.indexOf('G "Rewrite the app in the new framework" open'))
			.toBeLessThan(lines.findIndex((line) => line.startsWith('T 1 ')));
	});

	test('a file without a goal parses as before and renders no G line', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.goal()).toBeUndefined();
		expect(backlog.render().split('\n').some((line) => /^G( |$)/.test(line))).toBe(false);
	});

	test('setGoal creates a goal with status open', () => {
		const backlog = Backlog.parse(SAMPLE);
		const goal = backlog.setGoal({ title: 'Ship the rewrite', body: '- Step one.' });
		expect(goal).toEqual({
			title: 'Ship the rewrite',
			status: 'open',
			body: '- Step one.',
			evidence: null,
			checkpoint: null,
			checkpointIteration: null
		});
		expect(backlog.goal()).toEqual(goal);
	});

	test('setGoal updates title and body but preserves status, evidence, and checkpoint', () => {
		const backlog = Backlog.parse(GOAL_SAMPLE);
		// Simulate a claimed goal with evidence and a checkpoint.
		backlog.db.prepare("UPDATE goal SET status = 'claimed', evidence = 'criteria met' WHERE id = 1").run();
		const updated = backlog.setGoal({ title: 'Ship the rewrite (v2)', body: '- Step two.' });
		expect(updated).toMatchObject({
			title: 'Ship the rewrite (v2)',
			status: 'claimed',
			body: '- Step two.',
			evidence: 'criteria met',
			checkpoint: 'Completed: routes. Next step: state.',
			checkpointIteration: 4
		});
	});

	test('setGoal requires a non-empty title', () => {
		const backlog = Backlog.empty();
		expect(() => backlog.setGoal({ title: '   ' })).toThrow(/goal title is required/);
	});

	test('deleteGoal removes the goal', () => {
		const backlog = Backlog.parse(GOAL_SAMPLE);
		backlog.deleteGoal();
		expect(backlog.goal()).toBeUndefined();
		expect(backlog.render().split('\n').some((line) => /^G( |$)/.test(line))).toBe(false);
	});

	test('escapes quotes and backslashes in the goal title', () => {
		const backlog = Backlog.empty();
		backlog.setGoal({ title: 'Say "hi" \\ there' });
		const rendered = backlog.render();
		expect(rendered).toContain('G "Say \\"hi\\" \\\\ there" open');
		expect(Backlog.parse(rendered).goal()?.title).toBe('Say "hi" \\ there');
	});

	test('rejects goal parse errors', () => {
		const parse = (text: string): never => {
			try {
				Backlog.parse(text);
			} catch (error) {
				expect(error).toBeInstanceOf(BacklogParseError);
				throw error;
			}
			throw new Error('expected a parse error');
		};
		expect(() => parse('# ralph v2\n\nG "a" open\nG "b" open\n')).toThrow(/duplicate goal record/);
		expect(() => parse('# ralph v2\n\nG "a" pending\n')).toThrow(/invalid goal status/);
		expect(() => parse('# ralph v2\n\nGB\n  body\n')).toThrow(/goal body before goal record/);
		expect(() => parse('# ralph v2\n\nGE "evidence"\n')).toThrow(/goal evidence before goal record/);
		expect(() => parse('# ralph v2\n\nGC 1\n  note\n')).toThrow(/goal checkpoint before goal record/);
		expect(() => parse('# ralph v2\n\nG "a" open\nGB\n  one\nGB\n  two\n')).toThrow(/already has a body block/);
		expect(() => parse('# ralph v2\n\nG "a" open\nGE "one"\nGE "two"\n')).toThrow(/already has evidence/);
		expect(() => parse('# ralph v2\n\nG "a" open\nGC 1\n  one\nGC 2\n  two\n')).toThrow(/already has a checkpoint block/);
	});
});

describe('goal state transitions', () => {
	const withGoal = (status: 'open' | 'claimed' | 'done' = 'open'): Backlog => {
		const backlog = Backlog.empty();
		backlog.setGoal({ title: 'Ship the rewrite', body: '- Step one.' });
		if (status !== 'open') {
			backlog.db.prepare(`UPDATE goal SET status = '${status}' WHERE id = 1`).run();
		}
		return backlog;
	};

	test('claimGoal: open → claimed, records the evidence', () => {
		const backlog = withGoal('open');
		const goal = backlog.claimGoal('All criteria pass; bun test green.');
		expect(goal).toMatchObject({ status: 'claimed', evidence: 'All criteria pass; bun test green.' });
		expect(backlog.goal()).toEqual(goal);
	});

	test('confirmGoal: claimed → done', () => {
		const backlog = withGoal('claimed');
		const goal = backlog.confirmGoal();
		expect(goal.status).toBe('done');
		expect(backlog.goal()?.status).toBe('done');
	});

	test('withdrawGoal: claimed → open, note becomes the checkpoint, evidence cleared', () => {
		const backlog = withGoal('claimed');
		backlog.db.prepare("UPDATE goal SET evidence = 'old evidence' WHERE id = 1").run();
		const goal = backlog.withdrawGoal('State migration still missing.');
		expect(goal).toMatchObject({
			status: 'open',
			evidence: null,
			checkpoint: 'State migration still missing.',
			checkpointIteration: null
		});
		expect(backlog.goal()).toEqual(goal);
	});

	test('withdrawGoal keeps the existing checkpoint iteration', () => {
		const backlog = withGoal('claimed');
		backlog.setGoalCheckpoint('Iteration work.', 3);
		const goal = backlog.withdrawGoal('Not done yet.');
		expect(goal).toMatchObject({ status: 'open', checkpoint: 'Not done yet.', checkpointIteration: 3 });
	});

	test('setGoalCheckpoint sets and replaces the goal checkpoint', () => {
		const backlog = withGoal('open');
		const first = backlog.setGoalCheckpoint('Decomposed the goal.', 1);
		expect(first).toMatchObject({ checkpoint: 'Decomposed the goal.', checkpointIteration: 1 });
		const second = backlog.setGoalCheckpoint('Re-evaluating.', 5);
		expect(second).toMatchObject({ checkpoint: 'Re-evaluating.', checkpointIteration: 5 });
		expect(backlog.goal()).toEqual(second);
	});

	test('the full lifecycle round-trips through render/parse', () => {
		const backlog = withGoal('open');
		backlog.claimGoal('criteria met');
		const rendered = backlog.render();
		expect(rendered).toContain('G "Ship the rewrite" claimed');
		expect(rendered).toContain('GE "criteria met"');
		const reloaded = Backlog.parse(rendered);
		reloaded.withdrawGoal('missing piece');
		expect(reloaded.render()).toContain('G "Ship the rewrite" open');
		expect(reloaded.render()).toContain('  missing piece');
		expect(reloaded.render()).not.toContain('GE ');
		reloaded.claimGoal('criteria met again');
		reloaded.confirmGoal();
		expect(Backlog.parse(reloaded.render()).goal()?.status).toBe('done');
	});

	test('claimGoal throws on claimed, done, and missing goals', () => {
		expect(() => withGoal('claimed').claimGoal('evidence')).toThrow(/cannot claim the goal: it is claimed/);
		expect(() => withGoal('done').claimGoal('evidence')).toThrow(/cannot claim the goal: it is done/);
		expect(() => Backlog.empty().claimGoal('evidence')).toThrow(/no goal in this backlog/);
	});

	test('claimGoal requires non-empty evidence', () => {
		expect(() => withGoal('open').claimGoal('   ')).toThrow(/goal evidence is required/);
	});

	test('confirmGoal throws on open, done, and missing goals', () => {
		expect(() => withGoal('open').confirmGoal()).toThrow(/cannot confirm the goal: it is open/);
		expect(() => withGoal('done').confirmGoal()).toThrow(/cannot confirm the goal: it is done/);
		expect(() => Backlog.empty().confirmGoal()).toThrow(/no goal in this backlog/);
	});

	test('withdrawGoal throws on open, done, and missing goals', () => {
		expect(() => withGoal('open').withdrawGoal('note')).toThrow(/cannot withdraw the goal: it is open/);
		expect(() => withGoal('done').withdrawGoal('note')).toThrow(/cannot withdraw the goal: it is done/);
		expect(() => Backlog.empty().withdrawGoal('note')).toThrow(/no goal in this backlog/);
	});

	test('withdrawGoal requires a non-empty note', () => {
		expect(() => withGoal('claimed').withdrawGoal('')).toThrow(/withdrawal note is required/);
	});

	test('setGoalCheckpoint throws without a goal and on bad input', () => {
		expect(() => Backlog.empty().setGoalCheckpoint('note', 1)).toThrow(/no goal in this backlog/);
		expect(() => withGoal('open').setGoalCheckpoint('  ', 1)).toThrow(/checkpoint note is required/);
		expect(() => withGoal('open').setGoalCheckpoint('note', 0)).toThrow(/positive integer/);
		expect(() => withGoal('open').setGoalCheckpoint('note', 1.5)).toThrow(/positive integer/);
	});
});

describe('position numbers', () => {
	test('numbers tasks in list order', () => {
		const backlog = Backlog.parse(SAMPLE);
		const numbers = backlog.taskNumbers();
		expect(numbers.get(1)).toBe('1');
		expect(numbers.get(2)).toBe('2');
		expect(numbers.get(3)).toBe('3');
		expect(numbers.get(4)).toBe('4');
		expect(numbers.get(5)).toBe('5');
	});

	test('numbers are scoped to the category', () => {
		const backlog = Backlog.parse(SAMPLE);
		const numbers = backlog.taskNumbers('dossier');
		expect(numbers.get(1)).toBe('1');
		expect(numbers.get(2)).toBe('2');
		expect(numbers.get(3)).toBeUndefined();
	});

	test('findTaskByNumber resolves position numbers', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.findTaskByNumber('3')?.id).toBe(3);
		expect(backlog.findTaskByNumber('4')?.id).toBe(4);
		expect(backlog.findTaskByNumber('9')).toBeUndefined();
	});
});

describe('text format parse errors', () => {
	const parse = (text: string): never => {
		try {
			Backlog.parse(text);
		} catch (error) {
			expect(error).toBeInstanceOf(BacklogParseError);
			throw error;
		}
		throw new Error('expected a parse error');
	};

	test('unknown record tag', () => {
		expect(() => parse('# ralph v2\n\nX 1\n')).toThrow(/unknown record tag/);
	});

	test('indented line outside a block', () => {
		expect(() => parse('# ralph v2\n\nT 1 - "t"\n  stray\n')).toThrow(/outside a block/);
	});

	test('invalid date', () => {
		expect(() => parse('# ralph v2\n\nT 1 - "t"\n\nL 1 1 2026-1-1\n  note\n')).toThrow(/invalid date/);
	});

	test('duplicate done record', () => {
		expect(() => parse('# ralph v2\n\nT 1 - "t"\nD 1\nD 1\n')).toThrow(/already marked done/);
	});

	test('v2 rejects legacy T fields, section records, and key or "-" log references', () => {
		expect(() => parse('# ralph v2\n\nT 1 2 - "x"\n')).toThrow(/task record is/);
		expect(() => parse('# ralph v2\n\nS 1 backlog "x"\n\nT 1 - "x"\n')).toThrow(/section records are v1-only/);
		expect(() => parse('# ralph v2\n\nSB 1\n  body\n')).toThrow(/section body records are v1-only/);
		expect(() => parse('# ralph v2\n\nT 1 - "x"\n\nL 1 P0.1 2026-08-10\n  note\n')).toThrow(/task reference must be a task id/);
		expect(() => parse('# ralph v2\n\nT 1 - "x"\n\nL 1 - 2026-08-10\n  note\n')).toThrow(/always belong to a task/);
	});

	test('v2 rejects unknown or missing headers', () => {
		expect(() => parse('# ralph v3\n\nT 1 - "x"\n')).toThrow(/unsupported ralph header/);
		expect(() => parse('T 1 - "x"\n')).toThrow(/unsupported ralph header/);
		expect(() => parse('')).toThrow(/missing ralph header/);
	});
});

describe('v1 auto-migration', () => {
	const V1 = `# ralph v1

S 1 protocol "Ralph loop protocol"
SB 1
  1. Read the specification before every iteration.

T 1 2 - P0.1 dossier "Establish a clean local developer contract."
D 1
T 2 1 - "Sub-task of P0.1"

L 1 P0.1 2026-08-10
  Replaced the starter README.
`;

	test('parses v1 leniently and drops the legacy fields', () => {
		const backlog = Backlog.parse(V1);
		// Both tasks are flat; the section and parent fields are gone.
		expect(backlog.listTasks().map((t) => t.title)).toEqual([
			'Establish a clean local developer contract.',
			'Sub-task of P0.1'
		]);
		// The legacy key reference resolves to the task.
		expect(backlog.listLogEntriesForTask(1)).toHaveLength(1);
	});

	test('render writes the v2 form, which round-trips strictly', () => {
		const rendered = Backlog.parse(V1).render();
		expect(rendered.startsWith('# ralph v2')).toBe(true);
		expect(rendered).not.toContain('S 1');
		expect(rendered).not.toContain('L 1 P0.1');
		const reloaded = Backlog.parse(rendered);
		expect(reloaded.render()).toBe(rendered);
		expect(reloaded.counts()).toEqual({ open: 1, total: 2, completed: 1 });
	});
});

describe('counts and category filtering', () => {
	test('counts all tasks and per-category tasks', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.counts()).toEqual({ open: 4, total: 5, completed: 1 });
		expect(backlog.counts('dossier')).toEqual({ open: 1, total: 2, completed: 1 });
		expect(backlog.counts('auth')).toEqual({ open: 1, total: 1, completed: 0 });
		expect(backlog.counts('missing')).toEqual({ open: 0, total: 0, completed: 0 });
	});

	test('listTasks filters by category', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.listTasks('dossier').map((t) => t.id)).toEqual([1, 2]);
	});
});

describe('mutations', () => {
	test('complete marks the task done and render reflects it', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.complete('2');
		const rendered = backlog.render();
		expect(rendered).toContain('D 2');
		const reloaded = Backlog.parse(rendered);
		expect(reloaded.findTaskByNumber('2')?.done).toBe(true);
	});

	test('complete clears the task checkpoint', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.findTaskByNumber('2')?.checkpoint).not.toBeNull();
		const done = backlog.complete('2');
		expect(done).toMatchObject({ done: true, checkpoint: null, checkpointIteration: null });
		const rendered = backlog.render();
		expect(rendered.match(/^C 2 /gm)).toBeNull();
		const reloaded = Backlog.parse(rendered);
		const task = reloaded.findTaskByNumber('2');
		expect(task).toMatchObject({ done: true, checkpoint: null, checkpointIteration: null });
	});

	test('complete with an unknown number lists the known numbers', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(() => backlog.complete('9')).toThrow(/no task 9 \(tasks: 1, 2, 3, 4, 5\)/);
	});

	test('setCheckpoint replaces the checkpoint', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.setCheckpoint('2', 'New checkpoint note.', 7);
		const reloaded = Backlog.parse(backlog.render());
		const task = reloaded.findTaskByNumber('2');
		expect(task?.checkpoint).toBe('New checkpoint note.');
		expect(task?.checkpointIteration).toBe(7);
		// Only one checkpoint block survives the round-trip.
		expect(reloaded.render().match(/^C 2 /gm)).toHaveLength(1);
	});

	test('addTask appends with category', () => {
		const backlog = Backlog.parse(SAMPLE);
		const added = backlog.addTask({
			title: 'Add sign-out.',
			body: '- Acceptance: sessions expire.',
			category: 'auth'
		});
		expect(added).toMatchObject({ id: 6, category: 'auth' });
		// It is the sixth task in the flat list.
		expect(backlog.taskNumbers().get(added.id)).toBe('6');
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.findTaskByNumber('6')?.body).toBe('- Acceptance: sessions expire.');
	});


	test('addLogEntry appends a dated entry', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.addLogEntry({ task: '2', date: '2026-08-12', note: 'Removed demo routes.' });
		const reloaded = Backlog.parse(backlog.render());
		const entry = reloaded.listLogEntries().at(-1);
		expect(entry).toMatchObject({ taskId: 2, date: '2026-08-12', note: 'Removed demo routes.' });
	});

	test('addLogEntry records the kind and round-trips it', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.addLogEntry({ task: '2', date: '2026-08-12', note: 'Shipped.', kind: 'done' });
		backlog.addLogEntry({ task: '2', date: '2026-08-13', note: 'Blocked on API access.', kind: 'reopen' });
		const rendered = backlog.render();
		expect(rendered).toContain('L 3 2 2026-08-12');
		expect(rendered).toContain('L 4 2 2026-08-13 reopen');
		const reloaded = Backlog.parse(rendered);
		const entries = reloaded.listLogEntriesForTask(2);
		expect(entries.map((e) => e.kind)).toEqual(['done', 'reopen']);
	});

	test('addLogEntry defaults the kind to done (no token written)', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.addLogEntry({ task: '2', date: '2026-08-12', note: 'Shipped.' });
		const rendered = backlog.render();
		expect(rendered).toContain('L 3 2 2026-08-12');
		expect(rendered).not.toContain('reopen');
		expect(Backlog.parse(rendered).listLogEntriesForTask(2)[0]?.kind).toBe('done');
	});

	test('parses the optional L kind token and rejects unknown kinds', () => {
		const text = `# ralph v2

T 1 - "Task."

L 1 1 2026-08-13 reopen
  Reopened for a fix.
	`;
		const backlog = Backlog.parse(text);
		expect(backlog.listLogEntriesForTask(1)[0]?.kind).toBe('reopen');
		expect(() =>
			Backlog.parse(`# ralph v2

T 1 - "Task."

L 1 1 2026-08-13 maybe
  Note.
	`)
		).toThrow(BacklogParseError);
	});

	test('formatBacklog marks reopen entries with a cross', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.addLogEntry({ task: '2', date: '2026-08-12', note: 'Shipped.' });
		backlog.addLogEntry({ task: '2', date: '2026-08-13', note: 'Blocked.', kind: 'reopen' });
		const out = formatBacklog(backlog, undefined, { verbose: true });
		expect(out).toContain('✓ 2026-08-12 Shipped.');
		expect(out).toContain('✗ 2026-08-13 Blocked.');
	});

	test('addLogEntry rejects a malformed date', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(() => backlog.addLogEntry({ task: '1', date: '12-08-2026', note: 'x' })).toThrow(/invalid date/);
	});
});

describe('moveTask', () => {
	test('moves a task down and renumbers the list', () => {
		const backlog = Backlog.parse(SAMPLE);
		const moved = backlog.moveTask('2', 'down');
		// The returned task is the moved one, not whatever now holds the old number.
		expect(moved.id).toBe(2);
		expect(backlog.listTasks().map((t) => t.id)).toEqual([1, 3, 2, 4, 5]);
		const numbers = backlog.taskNumbers();
		expect(numbers.get(3)).toBe('2');
		expect(numbers.get(2)).toBe('3');
		expect(numbers.get(5)).toBe('5');
	});

	test('moves a task up by several steps', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.moveTask('4', 'up', 2);
		expect(backlog.listTasks().map((t) => t.id)).toEqual([1, 4, 2, 3, 5]);
		expect(backlog.taskNumbers().get(4)).toBe('2');
	});


	test('rejects moving past the edge of the list', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(() => backlog.moveTask('1', 'up')).toThrow(/task 1 is already first in the list/);
		expect(() => backlog.moveTask('5', 'down')).toThrow(/task 5 is already last in the list/);
	});

	test('rejects invalid step counts', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(() => backlog.moveTask('2', 'down', 0)).toThrow(/positive integer/);
	});

	test('keeps unscoped tasks in place for a scoped move', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.moveTask('1', 'down', 1, 'dossier');
		expect(backlog.listTasks().map((t) => t.id)).toEqual([2, 1, 3, 4, 5]);
		expect(backlog.listTasks('dossier').map((t) => t.id)).toEqual([2, 1]);
	});

	test('round-trips through render and parse', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.moveTask('4', 'up', 2);
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.listTasks().map((t) => t.id)).toEqual([1, 4, 2, 3, 5]);
		expect(reloaded.findTaskByNumber('2')?.title).toBe('Sub-task of P0.3');
	});
});

describe('list management (categories, update, delete)', () => {
	test('categories lists distinct categories in first-appearance order', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.categories()).toEqual(['dossier', 'auth']);
	});

	test('renameCategory renames the list and keeps log entries linked', () => {
		const backlog = Backlog.parse(SAMPLE);
		const renamed = backlog.renameCategory('dossier', 'Foundation');
		expect(renamed).toBe(2);
		expect(backlog.categories()).toEqual(['Foundation', 'auth']);
		expect(backlog.listTasks('Foundation').map((t) => t.id)).toEqual([1, 2]);
		// Log entries link via task id, so they survive the rename.
		expect(backlog.listLogEntriesForTask(1)).toHaveLength(1);
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.categories()).toEqual(['Foundation', 'auth']);
		expect(reloaded.listLogEntriesForTask(1)).toHaveLength(1);
	});

	test('renameCategory is a no-op for the same name and rejects unknown or taken targets', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.renameCategory('dossier', 'dossier')).toBe(0);
		expect(() => backlog.renameCategory('nope', 'x')).toThrow(/no list named "nope" \(lists: dossier, auth\)/);
		expect(() => backlog.renameCategory('dossier', 'auth')).toThrow(/already exists/);
		expect(() => backlog.renameCategory('dossier', '  ')).toThrow(/a list name is required/);
	});

	test('createList makes an explicit empty list that survives a round-trip', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.createList('Docs');
		expect(backlog.categories()).toContain('Docs');
		// The empty list is persisted via an M list meta record.
		expect(backlog.render()).toContain('M list "Docs"');
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.categories()).toContain('Docs');
		// Rejects blank, spaced, and duplicate names.
		expect(() => backlog.createList('  ')).toThrow(/a list name is required/);
		expect(() => backlog.createList('a b')).toThrow(/cannot be empty or contain spaces/);
		expect(() => backlog.createList('Docs')).toThrow(/already exists/);
		// Renaming an empty list updates the meta record.
		expect(backlog.renameCategory('Docs', 'Notes')).toBe(0);
		expect(backlog.categories()).toContain('Notes');
		expect(backlog.categories()).not.toContain('Docs');
		expect(Backlog.parse(backlog.render()).categories()).toContain('Notes');
	});

	test('updateTask changes title, body, and category', () => {
		const backlog = Backlog.parse(SAMPLE);
		const updated = backlog.updateTask('2', {
			title: 'Remove demo surfaces and docs.',
			body: 'New body.',
			category: 'auth'
		});
		expect(updated).toMatchObject({ title: 'Remove demo surfaces and docs.', category: 'auth' });
		expect(updated.body).toBe('New body.');
		expect(backlog.findTaskByNumber('2')?.title).toBe('Remove demo surfaces and docs.');
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.findTaskByNumber('2')?.body).toBe('New body.');
	});

	test('updateTask clears body and category with empty values', () => {
		const backlog = Backlog.parse(SAMPLE);
		const updated = backlog.updateTask('1', { body: '', category: '' });
		expect(updated).toMatchObject({ category: null });
		expect(updated.body).toBeNull();
		// The linked log entry keeps its link to the task.
		expect(backlog.listLogEntriesForTask(1)).toHaveLength(1);
	});

	test('updateTask rejects empty titles and unknown tasks', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(() => backlog.updateTask('2', { title: '  ' })).toThrow(/a task title is required/);
		expect(() => backlog.updateTask('NOPE', { title: 'x' })).toThrow(/no task NOPE/);
	});

	test('setDone toggles the done flag in both directions', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.setDone('1', false);
		expect(backlog.findTaskByNumber('1')?.done).toBe(false);
		backlog.setDone('3', true);
		expect(backlog.findTaskByNumber('3')?.done).toBe(true);
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.findTaskByNumber('1')?.done).toBe(false);
		expect(reloaded.findTaskByNumber('3')?.done).toBe(true);
		expect(() => backlog.setDone('9', true)).toThrow(/no task 9/);
	});

	test('setDone keeps the checkpoint when reopening and clears it when completing', () => {
		const backlog = Backlog.parse(SAMPLE);
		const original = backlog.findTaskByNumber('2');
		expect(original?.checkpoint).not.toBeNull();
		// Reopening an open task keeps the checkpoint.
		const reopened = backlog.setDone('2', false);
		expect(reopened).toMatchObject({ done: false, checkpoint: original?.checkpoint, checkpointIteration: original?.checkpointIteration });
		// Completing clears it.
		const done = backlog.setDone('2', true);
		expect(done).toMatchObject({ done: true, checkpoint: null, checkpointIteration: null });
		const rendered = backlog.render();
		expect(rendered.match(/^C 2 /gm)).toBeNull();
		const reloaded = Backlog.parse(rendered);
		expect(reloaded.findTaskByNumber('2')).toMatchObject({ done: true, checkpoint: null, checkpointIteration: null });
	});

	test('deleteTask removes the task and its log entries', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.deleteTask('1');
		expect(backlog.listTasks().map((t) => t.id)).toEqual([2, 3, 4, 5]);
		// The log entry for task 1 is deleted with the task.
		const entries = backlog.listLogEntries();
		expect(entries).toHaveLength(1);
		expect(entries.find((entry) => entry.note.startsWith('Replaced'))).toBeUndefined();
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.listLogEntries()).toHaveLength(1);
	});

	test('deleteTask removes the task and renumbers, and rejects unknown numbers', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(() => backlog.deleteTask('9')).toThrow(/no task 9/);
		backlog.deleteTask('3');
		expect(backlog.listTasks().map((t) => t.id)).toEqual([1, 2, 4, 5]);
		expect(backlog.taskNumbers().get(4)).toBe('3');
	});
});

describe('completion log task links', () => {
	test('entries whose id matches a task are linked to it', () => {
		const backlog = Backlog.parse(SAMPLE);
		const [first, second] = backlog.listLogEntries();
		expect(first?.taskId).toBe(1);
		expect(second?.taskId).toBe(5);
		expect(backlog.listLogEntriesForTask(1)).toHaveLength(1);
		expect(backlog.listLogEntriesForTask(1)[0]?.note).toBe('Replaced the starter README. Verified: bun test.');
		expect(backlog.listLogEntriesForTask(2)).toHaveLength(0);
	});

	test('v1 entries with unknown or missing references are dropped on migration', () => {
		const backlog = Backlog.parse(`# ralph v1

T 1 - - "Do the thing."
L 1 - -
  General note.
L 2 NOPE -
  Refers to a missing legacy key.
		`);
		// Neither entry links to a task, so both are dropped.
		expect(backlog.listLogEntries()).toHaveLength(0);
	});

	test('addLogEntry links the entry to the task and the link survives a round-trip', () => {
		const backlog = Backlog.parse(SAMPLE);
		const entry = backlog.addLogEntry({ task: '2', date: '2026-08-12', note: 'Removed demo routes.' });
		expect(entry.taskId).toBe(2);
		const reloaded = Backlog.parse(backlog.render());
		const reloadedEntry = reloaded.listLogEntriesForTask(2)[0];
		expect(reloadedEntry?.note).toBe('Removed demo routes.');
	});

	test('markdown import links log entries to imported tasks', () => {
		const backlog = Backlog.fromMarkdown(`# Demo

## Backlog

- [x] **P0.1 Ship it.**

## Completion log

- 2026-08-10 **P0.1** — Shipped.
- 2026-08-11 — General note.
`);
		const task = backlog.findTaskByNumber('1')!;
		const linked = backlog.listLogEntriesForTask(task.id);
		expect(linked).toHaveLength(1);
		expect(linked[0]?.note).toBe('Shipped.');
		// The unlinked general note is dropped: entries always belong to a task.
		expect(backlog.listLogEntries()).toHaveLength(1);
	});

	test('markdown import resolves numeric references to position numbers', () => {
		const backlog = Backlog.fromMarkdown(`# Demo

- [ ] **First.** Do one.
- [ ] **Part of one.** Do one and a half.
- [ ] **Second.** Do two.

## Completion log

- 2026-08-10 **2** — Did one and a half.
`);
		// The reference "2" resolves to the second task in the flat list.
		expect(backlog.listLogEntries()[0]?.taskId).toBe(2);
	});
});

describe('meta records (import sources)', () => {
	test('M source records round-trip and addSource appends', () => {
		const backlog = Backlog.parse(`# ralph v2

M source "TODO.md"

T 1 - "Task."
`);
		expect(backlog.sources()).toEqual(['TODO.md']);
		backlog.addSource('OTHER.md');
		const reloaded = Backlog.parse(backlog.render());
		expect(reloaded.sources()).toEqual(['TODO.md', 'OTHER.md']);
	});

	test('rejects invalid meta keys', () => {
		expect(() =>
			Backlog.parse('# ralph v2\n\nM Source "x"\n\nT 1 - "T."\n')
		).toThrow(/invalid meta key/);
	});
});

describe('mergeFrom (multi-file import)', () => {
	const OTHER_MD = `# Other backlog

## Priority 1 — features

- [ ] **Q1.1 Ship export.**
  - Body line.

- [ ] **Q1.2 Ship import.**
  - [ ] Prepare the importer.

## Completion log

- 2026-08-20 **Q1.1** — Exported.
`;

	test('merges tasks with new ids, stamps the category, and links log entries', () => {
		const target = Backlog.parse(SAMPLE);
		const other = Backlog.fromMarkdown(OTHER_MD);
		const result = target.mergeFrom(other, { category: 'beta' });
		expect(result).toEqual({ tasks: 3, logEntries: 1 });
		const q11 = target.listTasks().find((t) => t.title === 'Ship export.')!;
		expect(q11.category).toBe('beta');
		expect(q11.id).toBeGreaterThan(5);
		expect(q11.body).toBe('- Body line.');
		// The merged log entry links to the merged task.
		expect(target.listLogEntriesForTask(q11.id)).toHaveLength(1);
		// The result round-trips through the text format.
		const reloaded = Backlog.parse(target.render());
		const reloadedQ11 = reloaded.listTasks().find((t) => t.title === 'Ship export.')!;
		expect(reloadedQ11.category).toBe('beta');
		expect(reloaded.listLogEntriesForTask(reloadedQ11.id)).toHaveLength(1);
	});

	test('merged indented todos become flat top-level tasks', () => {
		const target = Backlog.parse(SAMPLE);
		const other = Backlog.fromMarkdown(OTHER_MD);
		target.mergeFrom(other);
		const sub = target.listTasks().find((task) => task.title === 'Prepare the importer.')!;
		expect(sub.category).toBeNull();
	});

	test('fromMarkdown stamps a category on every imported task', () => {
		const backlog = Backlog.fromMarkdown(OTHER_MD, { category: 'beta' });
		const tasks = backlog.listTasks();
		expect(tasks.length).toBeGreaterThan(0);
		for (const task of tasks) expect(task.category).toBe('beta');
	});
});

describe('next open task', () => {
	test('returns the first open task in backlog order', () => {
		const backlog = Backlog.parse(SAMPLE);
		// Task 1 is done, so the first open task is task 2.
		expect(backlog.nextOpenTask()?.id).toBe(2);
	});

	test('respects the category scope', () => {
		const backlog = Backlog.parse(SAMPLE);
		expect(backlog.nextOpenTask('auth')?.id).toBe(3);
		backlog.complete('2');
		backlog.complete('3');
		backlog.complete('4');
		expect(backlog.nextOpenTask()?.title).toBe('Decide migration strategy.');
	});

	test('returns undefined when every task is done', () => {
		const backlog = Backlog.parse(`# ralph v2

T 1 - "One."
D 1
T 2 - "Two."
D 2
`);
		expect(backlog.nextOpenTask()).toBeUndefined();
	});
});

// --- Markdown import -------------------------------------------------------------

const APG_STYLE_MD = `# APGLoket Svelte rewrite — Ralph loop backlog

Read SPEC.md before every iteration.

## Ralph loop protocol

1. Read SPEC.md, this file, and the relevant target code before choosing a task.
2. Select the highest-priority unblocked item.

## Current baseline

- Target: SvelteKit 2 / Svelte 5 / TypeScript, Drizzle + SQLite.
- Scope constraint: no email integration in the first release.

## Priority 0 — make the target a safe foundation

- [x] **P0.1 Establish a clean local developer contract.**
  - Replace the starter README with setup and test commands.
  - Acceptance: a new developer can install dependencies.

- [ ] **P0.2 Remove starter/demo surfaces.**
  - Remove demo routes that are not product functionality.
  - Evidence: target baseline only.
  - Acceptance: / is not a welcome page.
  - _Context checkpoint (iteration 3): removed routes; next step is the shell._

- [ ] **P0.3 Add sign-in.**
  - Build product routes around the auth configuration.
    - Nested detail line.
    - [ ] **Sub-step one.** Prepare the form.

## Deferred source parity (not implementation work until explicitly promoted)

- [x] **D1 Decide historic data migration strategy.** Define extraction and mapping.

## Completion log

_Add one short dated entry per completed task here._

- 2026-08-10 **P0.1** — Replaced the starter README. Verified: bun test.
- 2026-08-11 **D1** — Approved a greenfield-only migration boundary.
`;

const PLAYGROUND_STYLE_MD = `# Ralph playground backlog

- [x] **Scaffold.** Create package.json and a stub. Acceptance: bun test passes.
- [x] **Add command.** bun todo.ts add appends an item.
  - _Completion note: added loadTodos/saveTodos. bun test (6 pass)._

## Visual polish (new)

- [x] **Moodboard.** Create MOODBOARD.md with palettes.
- [ ] **ANSI colors in list.** Color the list output per the moodboard.
`;

describe('fromMarkdown (APGLoket dialect)', () => {
	const backlog = () => Backlog.fromMarkdown(APG_STYLE_MD);

	test('strips source keys from titles and keeps sub-bullet bodies', () => {
		const t1 = backlog().findTaskByNumber('1');
		expect(t1).toMatchObject({ done: true, title: 'Establish a clean local developer contract.' });
		expect(t1?.body).toBe('- Replace the starter README with setup and test commands.\n- Acceptance: a new developer can install dependencies.');
		const t2 = backlog().findTaskByNumber('2');
		expect(t2?.done).toBe(false);
		expect(t2?.body).toContain('Evidence: target baseline only.');
	});

	test('captures the context checkpoint with its iteration', () => {
		const t2 = backlog().findTaskByNumber('2');
		expect(t2?.checkpoint).toBe('removed routes; next step is the shell.');
		expect(t2?.checkpointIteration).toBe(3);
		expect(t2?.body).not.toContain('checkpoint');
	});

	test('parses indented checkbox todos as regular tasks', () => {
		const tasks = backlog().listTasks();
		const sub = tasks.find((t) => t.title === 'Sub-step one.');
		expect(sub?.category).toBeNull();
		expect(sub?.body).toBe('Prepare the form.');
	});

	test('parses the completion log with dates', () => {
		const log = backlog().listLogEntries();
		expect(log).toHaveLength(2);
		expect(log[0]).toMatchObject({ taskId: 1, date: '2026-08-10' });
		expect(log[0].note).toBe('Replaced the starter README. Verified: bun test.');
	});

	test('round-trips through the text format', () => {
		const rendered = backlog().render();
		const reloaded = Backlog.parse(rendered);
		expect(reloaded.counts()).toEqual(backlog().counts());
		expect(reloaded.findTaskByNumber('2')?.checkpointIteration).toBe(3);
	});
});

describe('fromMarkdown (playground dialect)', () => {
	const backlog = () => Backlog.fromMarkdown(PLAYGROUND_STYLE_MD);

	test('parses bold titles with inline bodies', () => {
		const scaffold = backlog().listTasks().find((t) => t.title === 'Scaffold.');
		expect(scaffold).toMatchObject({ done: true });
		expect(scaffold?.body).toBe('Create package.json and a stub. Acceptance: bun test passes.');
	});

	test('keeps completion notes in the task body', () => {
		const add = backlog().listTasks().find((t) => t.title === 'Add command.');
		expect(add?.body).toBe('bun todo.ts add appends an item.\n- _Completion note: added loadTodos/saveTodos. bun test (6 pass)._');
	});
});

describe('formatBacklog', () => {
	test('compact view shows counts, per-list counts, and open tasks only', () => {
		const text = formatBacklog(Backlog.parse(SAMPLE));
		expect(text).toContain('Backlog: 4 open / 5 total (1 done)');
		expect(text).toContain('Lists: dossier 1/2 · auth 1/1 · uncategorized 2/2');
		expect(text).toContain('- [ ] 2 Remove starter/demo surfaces. [dossier]');
		expect(text).toContain('- [ ] 4 Sub-task of P0.3');
		// Recorded completions, checkpoints, and log entries stay out of the compact view.
		expect(text).not.toContain('Establish a clean local developer contract.');
		expect(text).not.toContain('Completed: schema removal');
		expect(text).not.toContain('Replaced the starter README');
	});

	test('compact view keeps completed tasks that lack a completion log entry', () => {
		const unrecorded = SAMPLE.replace('L 1 1 2026-08-10\n  Replaced the starter README. Verified: bun test.\n', '');
		const text = formatBacklog(Backlog.parse(unrecorded));
		expect(text).toContain('- [x] 1 Establish a clean local developer contract. [dossier]');
	});

	test('verbose view renders markers, numbers, categories, checkpoints, and log', () => {
		const text = formatBacklog(Backlog.parse(SAMPLE), undefined, { verbose: true });
		expect(text).toContain('Backlog: 4 open / 5 total (1 done)');
		expect(text).toContain('- [x] 1 Establish a clean local developer contract. [dossier]');
		expect(text).toContain('- [ ] 2 Remove starter/demo surfaces. [dossier]');
		expect(text).toContain('checkpoint (iteration 3): Completed: schema removal. Next step: add the migration.');
		expect(text).toContain('- [ ] 4 Sub-task of P0.3');
		expect(text).toContain('  ✓ 2026-08-10 Replaced the starter README. Verified: bun test.');
	});

	test('shows the category subset in the summary', () => {
		const text = formatBacklog(Backlog.parse(SAMPLE), 'dossier');
		expect(text).toContain('category "dossier": 1 open / 2 total (1 done)');
		expect(text).not.toContain('Add sign-in.');
	});
});

describe('formatTaskDetail', () => {
	test('shows one task with body, checkpoint, and completion log', () => {
		const backlog = Backlog.parse(SAMPLE);
		const withCheckpoint = formatTaskDetail(backlog, backlog.findTaskByNumber('2')!);
		expect(withCheckpoint).toContain('Task 2: Remove starter/demo surfaces. [ ]');
		expect(withCheckpoint).toContain('list: dossier');
		expect(withCheckpoint).toContain('Checkpoint (iteration 3):');
		expect(withCheckpoint).toContain('Completed: schema removal. Next step: add the migration.');
		expect(withCheckpoint).not.toContain('Completion log:');

		const withLog = formatTaskDetail(backlog, backlog.findTaskByNumber('5')!);
		expect(withLog).toContain('Task 5: Decide migration strategy. [ ]');
		expect(withLog).toContain('Completion log:');
		expect(withLog).toContain('  ✓ 2026-08-11 Approved a greenfield-only migration boundary.');
		// Other tasks stay out of the single-task view.
		expect(withLog).not.toContain('Establish a clean local developer contract.');
		expect(withLog).not.toContain('Add sign-in.');
	});

	test('marks done tasks and omits sections the task lacks', () => {
		const backlog = Backlog.parse(SAMPLE);
		const done = formatTaskDetail(backlog, backlog.findTaskByNumber('1')!);
		expect(done).toContain('Task 1: Establish a clean local developer contract. [x]');
		expect(done).toContain('Task body:');
		expect(done).toContain('  ✓ 2026-08-10 Replaced the starter README. Verified: bun test.');
		expect(done).not.toContain('Checkpoint');

		const bare = formatTaskDetail(backlog, backlog.findTaskByNumber('4')!);
		expect(bare).toContain('Task 4: Sub-task of P0.3 [ ]');
		expect(bare).not.toContain('Task body:');
		expect(bare).not.toContain('Checkpoint');
		expect(bare).not.toContain('Completion log:');
	});

	test('marks reopen entries with a cross', () => {
		const backlog = Backlog.parse(SAMPLE);
		backlog.addLogEntry({ task: '2', date: '2026-08-13', note: 'Blocked.', kind: 'reopen' });
		const text = formatTaskDetail(backlog, backlog.findTaskByNumber('2')!);
		expect(text).toContain('  ✗ 2026-08-13 Blocked.');
	});
});

describe('searchTasks / formatSearchResults', () => {
	test('finds tasks by keyword in titles, bodies, checkpoints, and log notes', () => {
		const backlog = Backlog.parse(SAMPLE);
		const text = formatSearchResults(backlog, 'migration');
		expect(text).toContain('Search "migration": 2 of 5 tasks match in all lists.');
		// Task 2 matches via its checkpoint, task 5 via title and log note.
		expect(text).toContain('- [ ] 2 Remove starter/demo surfaces. [dossier]');
		expect(text).toContain('~ checkpoint (iteration 3): Completed: schema removal. Next step: add the migration.');
		expect(text).toContain('- [ ] 5 Decide migration strategy.');
		expect(text).toContain('~ log ✓ 2026-08-11 Approved a greenfield-only migration boundary.');
		// Non-matching tasks stay out of the result.
		expect(text).not.toContain('Establish a clean local developer contract.');
		expect(text).not.toContain('Add sign-in.');
	});

	test('is case-insensitive and shows only the matching lines', () => {
		const backlog = Backlog.parse(SAMPLE);
		const text = formatSearchResults(backlog, 'STARTER README');
		expect(text).toContain('Search "STARTER README": 1 of 5 tasks match in all lists.');
		expect(text).toContain('- [x] 1 Establish a clean local developer contract. [dossier]');
		expect(text).toContain('~ body: - Replace the starter README with setup and test commands.');
		expect(text).toContain('~ log ✓ 2026-08-10 Replaced the starter README. Verified: bun test.');
		// The non-matching body line stays out.
		expect(text).not.toContain('a new developer can install dependencies');
	});

	test('scopes to a category and reports no matches', () => {
		const backlog = Backlog.parse(SAMPLE);
		const scoped = formatSearchResults(backlog, 'migration', 'dossier');
		expect(scoped).toContain('1 of 2 tasks match in list "dossier"');
		expect(scoped).toContain('Remove starter/demo surfaces.');
		expect(scoped).not.toContain('Decide migration strategy.');

		const none = formatSearchResults(backlog, 'werkvoorraad');
		expect(none).toBe('No matches for "werkvoorraad" (5 tasks in all lists).');
	});

	test('searchTasks matches titles, bodies, and checkpoints', () => {
		const backlog = Backlog.parse(SAMPLE);
		// Checkpoint match (task 2) and title match (task 5).
		expect(backlog.searchTasks('migration').map((t) => t.id)).toEqual([2, 5]);
		// Title match only.
		expect(backlog.searchTasks('sign-in').map((t) => t.id)).toEqual([3]);
		// Body match only.
		expect(backlog.searchTasks('install dependencies').map((t) => t.id)).toEqual([1]);
		expect(backlog.searchTasks('zzz-not-there')).toEqual([]);
	});
});
