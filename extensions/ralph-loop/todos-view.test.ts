import { describe, expect, test } from 'bun:test';
import { CURSOR_MARKER, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { Backlog } from './backlog.ts';
import { createTodosView, type TodosViewTheme } from './todos-view.ts';

const SAMPLE = `# ralph v2

T 1 dossier "Establish a clean local developer contract."
D 1

T 2 dossier "Remove starter/demo surfaces."
B 2
  Delete the demo routes and pages.
C 2 3
  Removed routes; next step is the shell.

T 3 auth "Add sign-in."

T 4 - "Decide migration strategy."

L 1 1 2026-08-10
  Replaced the README. Verified: bun test.
`;

const theme: TodosViewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text
};

/** Minimal TUI stub for the built-in Editor (terminal rows + requestRender). */
const stubTui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;

function createView(options?: { category?: string; reload?: () => Backlog | undefined }) {
	let renderRequests = 0;
	let closed = false;
	const view = createTodosView({
		backlog: Backlog.parse(SAMPLE),
		tui: stubTui,
		title: 'TODO.ralph',
		category: options?.category,
		theme,
		requestRender: () => {
			renderRequests += 1;
		},
		onClose: () => {
			closed = true;
		},
		reload: options?.reload
	});
	return { view, renderRequests: () => renderRequests, closed: () => closed, lines: (width = 100) => view.render(width) };
}

function createEditableView(options?: { category?: string; fail?: boolean }) {
	let closed = false;
	const started: Array<string> = [];
	let lastBacklog: Backlog | undefined;
	const view = createTodosView({
		backlog: Backlog.parse(SAMPLE),
		tui: stubTui,
		title: 'TODO.ralph',
		category: options?.category,
		theme,
		requestRender: () => {},
		onClose: () => {
			closed = true;
		},
		onStartLoop: (category) => {
			started.push(category ?? 'all');
		},
		mutate: (backlog, fn) => {
			lastBacklog = backlog;
			if (options?.fail) return Promise.resolve(false);
			fn(backlog);
			return Promise.resolve(true);
		}
	});
	return {
		view,
		lines: (width = 100) => view.render(width),
		closed: () => closed,
		started,
		lastBacklog: () => lastBacklog,
		type: (text: string) => {
			for (const ch of text) view.handleInput(ch);
		}
	};
}

// Mutations go through an async mutate callback; let the rebuild land.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('todos view rendering', () => {
	test('renders header, tasks, and checkpoint', () => {
		const { lines } = createView();
		const rendered = lines();
		const text = rendered.join('\n');
		expect(rendered[0]).toContain('Ralph backlog — TODO.ralph');
		expect(rendered[0]).toContain('3 of 4 open (1 done)');
		expect(text).toContain('  > [x] + 1 Establish a clean local developer contract. [dossier]');
		expect(text).toContain('    [ ] + 2 Remove starter/demo surfaces. [dossier]');
		expect(text).toContain('⚑ checkpoint (iteration 3): Removed routes; next step is the shell.');
		// There is no separate completion log section: entries show only under
		// their task when it is expanded.
		expect(text).not.toContain('Completion log');
		expect(rendered.at(-1)).toContain('q: quit');
	});

	test('scopes to a category', () => {
		const { lines } = createView({ category: 'dossier' });
		const rendered = lines();
		const text = rendered.join('\n');
		expect(rendered[0]).toContain('category "dossier"');
		expect(rendered[0]).toContain('1 of 2 open');
		expect(text).toContain('Establish a clean local developer contract.');
		expect(text).toContain('Remove starter/demo surfaces.');
		expect(text).not.toContain('Add sign-in.');
		expect(text).not.toContain('Decide migration strategy.');
	});

	test('truncates long lines to the width', () => {
		const { lines } = createView();
		const rendered = lines(20);
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});
});

describe('todos view navigation', () => {
	test('j/k move the cursor with clamping', () => {
		const { view, renderRequests } = createView();
		expect(view.cursor()).toBe(0);
		view.handleInput('k');
		expect(view.cursor()).toBe(0);
		view.handleInput('j');
		expect(view.cursor()).toBe(1);
		view.handleInput('\x1b[B');
		expect(view.cursor()).toBe(2);
		view.handleInput('\x1b[A');
		expect(view.cursor()).toBe(1);
		for (let i = 0; i < 10; i += 1) view.handleInput('j');
		expect(view.cursor()).toBe(3);
		expect(renderRequests()).toBeGreaterThanOrEqual(6);
	});

	test('g/G jump to first and last task', () => {
		const { view } = createView();
		view.handleInput('G');
		expect(view.cursor()).toBe(3);
		view.handleInput('g');
		expect(view.cursor()).toBe(0);
	});

	test('u jumps to the next open task, wrapping around', () => {
		const { view } = createView();
		// Cursor on P0.1 (done) → next open is P0.2.
		view.handleInput('u');
		expect(view.cursor()).toBe(1);
		// P0.2 → P0.3.
		view.handleInput('u');
		expect(view.cursor()).toBe(2);
		// Task 3 → wraps to task 2 (task 4 is in another list but still a task;
		// it is open, so the wrap lands on it first).
		view.handleInput('u');
		expect(view.cursor()).toBe(3);
		view.handleInput('u');
		expect(view.cursor()).toBe(1);
	});

	test('the highlighted marker moves with the cursor', () => {
		const { view, lines } = createView();
		expect(lines().join('\n')).toContain('> [x] + 1 Establish');
		view.handleInput('j');
		const text = lines().join('\n');
		expect(text).toContain('> [ ] + 2 Remove');
		expect(text).toContain('    [x] + 1 Establish');
	});


	test('r reloads the backlog from disk', () => {
		const backlog2 = Backlog.parse(SAMPLE);
		backlog2.complete('2');
		const { view, lines } = createView({ reload: () => backlog2 });
		expect(lines().join('\n')).toContain('[ ] + 2 Remove');
		view.handleInput('r');
		expect(lines().join('\n')).toContain('[x] + 2 Remove');
	});

	test('q and Escape close the view', () => {
		const { view, closed } = createView();
		view.handleInput('q');
		expect(closed()).toBe(true);
		const second = createView();
		second.view.handleInput('\x1b');
		expect(second.closed()).toBe(true);
	});

	test('unknown keys are ignored without re-rendering', () => {
		const { view, renderRequests } = createView();
		view.handleInput('z');
		expect(renderRequests()).toBe(0);
	});
});

describe('todos view task expansion', () => {
	test('o expands the highlighted task to show its body and linked log entries', () => {
		const { view, lines } = createView();
		// Cursor starts on task 1, which has a linked completion log entry.
		view.handleInput('o');
		expect(view.expandedIds()).toHaveLength(1);
		let text = lines().join('\n');
		expect(text).toContain('− 1 Establish');
		expect(text).toContain('✓ 2026-08-10 Replaced the README. Verified: bun test.');

		// Task 2 has a body block but no log entries.
		view.handleInput('j');
		view.handleInput('o');
		expect(view.expandedIds()).toHaveLength(2);
		text = lines().join('\n');
		expect(text).toContain('− 2 Remove');
		expect(text).toContain('Delete the demo routes and pages.');

		// Collapsing removes the detail lines again.
		view.handleInput('o');
		expect(view.expandedIds()).toHaveLength(1);
		text = lines().join('\n');
		expect(text).toContain('+ 2 Remove');
		expect(text).not.toContain('Delete the demo routes and pages.');
	});

	test('expanding a task with no body or log entries only flips the marker', () => {
		const { view, lines } = createView();
		view.handleInput('j');
		view.handleInput('j'); // task 3: no body, no log entries
		view.handleInput('o');
		expect(lines().join('\n')).toContain('− 3 Add sign-in.');
		view.handleInput('o');
		expect(lines().join('\n')).toContain('+ 3 Add sign-in.');
	});
});

describe('todos view list management', () => {

	test('the footer advertises the management keys only when available', () => {
		const { lines } = createEditableView({ category: 'dossier' });
		const text = lines(200).join('\n');
		expect(text).toContain('a: add');
		expect(text).toContain('e: edit');
		expect(text).toContain('x: delete');
		expect(text).toContain('J/K: move task');
		expect(text).toContain('R: rename');
		expect(text).toContain('s: start');
		const plain = createView();
		const plainText = plain.lines(200).join('\n');
		expect(plainText).not.toContain('a: add');
		expect(plainText).not.toContain('s: start');
	});

	test('a opens the task form popup; enter edits, saving adds a top-level task and focuses it', async () => {
		const { view, lines } = createEditableView({ category: 'dossier' });
		view.handleInput('a');
		expect(view.mode()).toBe('form');
		const popup = lines().join('\n');
		// A bordered popup, left-aligned with the list, read-only until enter.
		expect(popup).toContain('┌');
		expect(popup).toContain('│');
		expect(popup).toContain('└');
		expect(popup).toContain('New task');
		expect(popup).toContain('Title:');
		expect(popup).toContain('Body:');
		expect(popup).toContain('enter: edit');
		// Typing before enter does not edit.
		view.handleInput('x');
		expect(lines().join('\n')).not.toContain('Title:    x');
		view.handleInput('\r'); // enter starts editing
		expect(lines().join('\n')).toContain('tab/↑↓: field');
		for (const ch of 'Ship the widget') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(view.mode()).toBe('browse');
		const text = lines().join('\n');
		expect(text).toContain('Ship the widget');
		expect(text).toContain('[dossier]');
		// The cursor moved to the new task and the scoped header count moved on.
		expect(lines()[0]).toContain('2 of 3 open');
		expect(text).toContain('> [ ] + 3 Ship the widget');
	});

	test('Esc cancels the form without adding a task', () => {
		const { view, lines } = createEditableView();
		view.handleInput('a');
		for (const ch of 'Nope') view.handleInput(ch);
		view.handleInput('\x1b');
		expect(view.mode()).toBe('browse');
		expect(lines()[0]).toContain('3 of 4 open');
	});

	test('form and confirm popups float over the dimmed list with attached hints', () => {
		// A theme that marks dim and bold output so the swap is observable.
		const marked: TodosViewTheme = {
			fg: (color, text) => (color === 'dim' ? `⟨${text}⟩` : text),
			bold: (text) => `⟨b:${text}⟩`
		};
		const view = createTodosView({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme: marked,
			requestRender: () => {},
			onClose: () => {},
			mutate: (backlog, fn) => {
				fn(backlog);
				return Promise.resolve(true);
			}
		});
		view.handleInput('a');
		let rendered = view.render(100);
		// The list behind is dimmed; the popup label keeps full opacity.
		expect(rendered[0]).toContain('⟨Ralph backlog');
		let top = rendered.findIndex((l) => l.includes('┌'));
		expect(rendered[top]).toContain('⟨b:New task⟩');
		// The hint is attached under the box; the browse footer stays.
		let bottom = rendered.findIndex((l) => l.includes('└'));
		expect(rendered[bottom + 1]).toContain('ctrl+s: save · esc: cancel');
		expect(rendered.join('\n')).toContain('jk: move');

		view.handleInput('\x1b');
		view.handleInput('x');
		rendered = view.render(100);
		top = rendered.findIndex((l) => l.includes('┌'));
		expect(rendered[top]).toContain('⟨b:Confirm⟩');
		expect(rendered[top + 1]).toContain('Delete task 1');
		bottom = rendered.findIndex((l) => l.includes('└'));
		expect(rendered[bottom + 1]).toContain('y: yes · n/esc: no');
	});

	test('a with an empty title refuses to save and keeps the form open', async () => {
		const { view, lines } = createEditableView();
		view.handleInput('a');
		view.handleInput('\r');
		view.handleInput('\x13'); // Ctrl+S with no title
		expect(view.mode()).toBe('form');
		expect(lines().join('\n')).toContain('a task title is required');
	});


	test('e opens the form prefilled with the task; editing the title saves', async () => {
		const { view, lines } = createEditableView();
		view.handleInput('e');
		expect(view.mode()).toBe('form');
		const form = lines().join('\n');
		expect(form).toContain('Edit 1 Establish a clean local developer contract.');
		expect(form).toContain('Establish a clean local developer contract.');
		view.handleInput('\r'); // enter starts editing
		for (const ch of ' (edited)') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(lines().join('\n')).toContain('Establish a clean local developer contract. (edited)');
	});

	test('e then tab to Body opens the body editor (ctrl+s saves, esc cancels)', async () => {
		const { view, lines, lastBacklog } = createEditableView();
		view.handleInput('j'); // task 2 has a one-line body
		view.handleInput('e');
		// Tab from Title to Body (read-only), then enter opens the editor.
		view.handleInput('\t');
		view.handleInput('\r');
		expect(view.mode()).toBe('editor');
		expect(lines().join('\n')).toContain('enter: newline');
		// Move to the end of the line, split, and append a second line.
		view.handleInput('\x1b[F');
		view.handleInput('\r');
		for (const ch of 'Second line.') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S saves the body and returns to the form
		expect(view.mode()).toBe('form');
		view.handleInput('\x13'); // Ctrl+S saves the form
		await flush();
		expect(view.mode()).toBe('browse');
		expect(lastBacklog()?.findTaskByNumber('2')?.body).toBe('Delete the demo routes and pages.\nSecond line.');

		// Esc returns to the form without saving the body.
		view.handleInput('e');
		view.handleInput('\t');
		view.handleInput('\r');
		for (const ch of ' junk') view.handleInput(ch);
		view.handleInput('\x1b');
		expect(view.mode()).toBe('form');
		view.handleInput('\x13'); // Ctrl+S saves the form with the unchanged body
		await flush();
		expect(view.mode()).toBe('browse');
		expect(lastBacklog()?.findTaskByNumber('2')?.body).toBe('Delete the demo routes and pages.\nSecond line.');
	});

	test('body editor shows a movable cursor', () => {
		const { view, lines } = createEditableView();
		view.handleInput('j'); // task 2 has a one-line body
		view.handleInput('e');
		view.handleInput('\t');
		view.handleInput('\r');
		// The built-in Editor renders the cursor inverted over the char under it
		// (preceded by the zero-width hardware-cursor marker).
		const inv = (ch: string) => `${CURSOR_MARKER}\x1b[7m${ch}\x1b[0m`;
		// The cursor starts at the end of the text (like the title field).
		expect(lines().join('\n')).toContain('Delete the demo routes and pages.' + inv(' '));
		// Arrow left moves the cursor within the line.
		view.handleInput('\x1b[D');
		view.handleInput('\x1b[D');
		expect(lines().join('\n')).toContain('page' + inv('s') + '.');
		// Home jumps to the start of the line; end back to the end.
		view.handleInput('\x1b[H');
		expect(lines().join('\n')).toContain(inv('D') + 'elete the demo routes and pages.');
		view.handleInput('\x1b[F');
		expect(lines().join('\n')).toContain('Delete the demo routes and pages.' + inv(' '));
	});

	test('e: the form has no Done field; editing a done task keeps it done', async () => {
		const { view, lines, lastBacklog } = createEditableView();
		view.handleInput('e'); // task 1 is done
		expect(lines().join('\n')).not.toContain('Done:');
		view.handleInput('\r'); // edit Title
		for (const ch of ' (edited)') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(lines().join('\n')).toContain('> [x] + 1 Establish');
		// Editing never changes the done state or moves the task to another list.
		expect(lastBacklog()?.findTaskByNumber('1')?.done).toBe(true);
		expect(lastBacklog()?.findTaskByNumber('1')?.category).toBe('dossier');
	});

	test('a: enter edits just the Title field; the new task stays in the viewed list', async () => {
		const { view, lines, lastBacklog } = createEditableView({ category: 'dossier' });
		view.handleInput('a');
		view.handleInput('\r'); // edit Title
		for (const ch of 'Task') view.handleInput(ch);
		view.handleInput('\r'); // confirm Title, back to read-only
		expect(lines().join('\n')).toContain('enter: edit');
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		const task = lastBacklog()?.listTasks().find((t) => t.title === 'Task');
		expect(task?.category).toBe('dossier'); // stays in the list being viewed
	});

	test('a: a new task is added open (done is set via space, not the form)', async () => {
		const { view, lines, lastBacklog } = createEditableView();
		view.handleInput('a');
		view.handleInput('\r');
		for (const ch of 'Task') view.handleInput(ch);
		view.handleInput('\r');
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(lastBacklog()?.listTasks().find((t) => t.title === 'Task')?.done).toBe(false);
	});

	test('x deletes the highlighted task after confirmation', async () => {
		const { view, lines } = createEditableView();
		view.handleInput('j'); // task 2
		view.handleInput('x');
		expect(view.mode()).toBe('confirm');
		expect(lines().join('\n')).toContain('Delete task 2 "Remove starter/demo surfaces."?');
		view.handleInput('n');
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).toContain('Remove starter/demo surfaces.');
		view.handleInput('x');
		view.handleInput('y');
		await flush();
		expect(lines().join('\n')).not.toContain('Remove starter/demo surfaces.');
		expect(lines()[0]).toContain('2 of 3 open');
	});

	test('R renames the current list and the scope follows the rename', async () => {
		const { view, lines } = createEditableView({ category: 'dossier' });
		view.handleInput('R');
		expect(view.mode()).toBe('input');
		view.handleInput('x'); // dossier → dossierx
		view.handleInput('\r');
		await flush();
		expect(lines()[0]).toContain('category "dossierx"');
		// The renamed tasks are still shown (the scope tracks the rename).
		expect(lines().join('\n')).toContain('Establish a clean local developer contract.');
		expect(lines().join('\n')).toContain('Remove starter/demo surfaces.');
	});

	test('s starts a Ralph loop on the current list after confirmation', () => {
		const { view, lines, closed, started } = createEditableView({ category: 'dossier' });
		view.handleInput('s');
		expect(view.mode()).toBe('confirm');
		expect(lines().join('\n')).toContain('Start a Ralph loop on list "dossier"?');
		view.handleInput('n');
		expect(view.mode()).toBe('browse');
		expect(started).toHaveLength(0);
		view.handleInput('s');
		view.handleInput('y');
		expect(closed()).toBe(true);
		expect(started).toEqual(['dossier']);
	});

	test('a failed mutation keeps the previous data and shows a notice', async () => {
		const { view, lines } = createEditableView({ fail: true });
		view.handleInput('a');
		view.handleInput('\r');
		for (const ch of 'New task') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		const text = lines().join('\n');
		expect(text).toContain('not saved');
		expect(lines()[0]).toContain('3 of 4 open');
	});

	test('management keys are inert without a mutate callback', () => {
		let renderRequests = 0;
		const view = createTodosView({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			requestRender: () => {
				renderRequests += 1;
			},
			onClose: () => {}
		});
		view.handleInput('a');
		view.handleInput('e');
		view.handleInput('x');
		view.handleInput('R');
		view.handleInput('J');
		view.handleInput('K');
		view.handleInput(' ');
		expect(renderRequests).toBe(0);
		expect(view.mode()).toBe('browse');
	});
});
describe('todos view task move', () => {
	test('J moves the highlighted task down and keeps it focused', async () => {
		const { view, lines } = createEditableView();
		view.handleInput('J'); // task 1
		await flush();
		const text = lines().join('\n');
		expect(text).toContain('saved');
		// Task 1 now sits below task 2 and the cursor follows it.
		expect(text.indexOf('Remove starter/demo surfaces.')).toBeLessThan(text.indexOf('Establish a clean local developer contract.'));
		expect(view.cursor()).toBe(1);
	});

	test('K moves the highlighted task up', async () => {
		const { view, lines } = createEditableView();
		view.handleInput('j'); // task 2
		view.handleInput('K');
		await flush();
		const text = lines().join('\n');
		expect(text.indexOf('Remove starter/demo surfaces.')).toBeLessThan(text.indexOf('Establish a clean local developer contract.'));
		expect(view.cursor()).toBe(0);
	});

	test('J on the last task and K on the first show a notice and change nothing', () => {
		const { view, lines } = createEditableView();
		view.handleInput('G');
		view.handleInput('J');
		let text = lines().join('\n');
		expect(text).toContain('task 4 is already last in the list');
		expect(view.cursor()).toBe(3);
		view.handleInput('g');
		view.handleInput('K');
		text = lines().join('\n');
		expect(text).toContain('task 1 is already first in the list');
		// The order is untouched.
		expect(text.indexOf('Establish a clean local developer contract.')).toBeLessThan(text.indexOf('Decide migration strategy.'));
	});

	test('J/K move tasks within the flat list', async () => {
		const sample = `# ralph v2

T 1 - "Parent."
T 2 - "Child one."
T 3 - "Child two."
T 4 - "Other."
`;
		const view = createTodosView({
			backlog: Backlog.parse(sample),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			requestRender: () => {},
			onClose: () => {},
			mutate: (backlog, fn) => {
				fn(backlog);
				return Promise.resolve(true);
			}
		});
		// Move "Parent." down: it swaps with the next task.
		view.handleInput('J');
		await flush();
		let text = view.render(100).join('\n');
		expect(text.indexOf('Child one.')).toBeLessThan(text.indexOf('Parent.'));
		// Move "Child two" up past "Parent."
		view.handleInput('j'); // Child two
		view.handleInput('K');
		await flush();
		text = view.render(100).join('\n');
		expect(text.indexOf('Child two.')).toBeLessThan(text.indexOf('Parent.'));
	});

	test('J/K are inert without a mutate callback', () => {
		let renderRequests = 0;
		const view = createTodosView({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			requestRender: () => {
				renderRequests += 1;
			},
			onClose: () => {}
		});
		view.handleInput('J');
		view.handleInput('K');
		expect(renderRequests).toBe(0);
		expect(view.mode()).toBe('browse');
	});
});

describe('todos view done toggle', () => {
	const today = () => {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	};

	test('space on an open task prompts for a reason and completes it', async () => {
		const { view, lines, lastBacklog } = createEditableView();
		view.handleInput('j'); // task 2 (open)
		view.handleInput(' ');
		expect(view.mode()).toBe('reason');
		let text = lines().join('\n');
		expect(text).toContain('✓ Complete task 2 — reason:');
		// A bordered popup box, like the add/edit form.
		expect(text).toContain('┌');
		expect(text).toContain('│');
		expect(text).toContain('└');
		// The popup is centered over the cleared body area: no list lines are
		// visible while it is open.
		const rendered = lines();
		const top = rendered.findIndex((l) => l.includes('┌'));
		expect(rendered[top]).toContain('✓ Complete task 2 — reason:');
		expect(rendered.join('\n')).not.toContain('Remove starter/demo surfaces.');
		expect(rendered.join('\n')).not.toContain('Establish a clean local developer contract.');
		// Left-aligned with the list entries (2-space indent).
		expect(rendered[top]).toMatch(/^  ┌ /);
		// The key hint is attached to the popup, right under its bottom border;
		// and the browse footer stays in place.
		const bottom = rendered.findIndex((l) => l.includes('└'));
		expect(rendered[bottom + 1]).toContain('enter: save · esc: cancel');
		expect(text).toContain('jk: move');
		for (const ch of 'shipped in prod.') view.handleInput(ch);
		view.handleInput('\r');
		await flush();
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).toContain('> [x] + 2 Remove');
		const entries = lastBacklog()?.listLogEntriesForTask(2) ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.note).toBe('shipped in prod.');
		expect(entries[0]?.date).toBe(today());
		expect(entries[0]?.kind).toBe('done');
	});

	test('the body is cleared while the reason popup is open', () => {
		// A theme that marks dim and bold output so the swap is observable.
		const marked: TodosViewTheme = {
			fg: (color, text) => (color === 'dim' ? `⟨${text}⟩` : text),
			bold: (text) => `⟨b:${text}⟩`
		};
		const view = createTodosView({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme: marked,
			requestRender: () => {},
			onClose: () => {},
			mutate: (backlog, fn) => {
				fn(backlog);
				return Promise.resolve(true);
			}
		});
		// Browse: the header title is bold (full opacity).
		expect(view.render(100)[0]).toContain('⟨b:Ralph backlog');
		view.handleInput(' '); // task 1 (done) → reopen prompt
		const rendered = view.render(100);
		// The header is rendered through the dimmed theme: dim, not bold.
		expect(rendered[0]).toContain('⟨Ralph backlog');
		expect(rendered[0]).not.toContain('⟨b:');
		// The body area is cleared: the list lines are gone, leaving a clean
		// backdrop for the popup and its hint.
		expect(rendered.find((l) => l.includes('Decide migration strategy.'))).toBeUndefined();
		// The popup itself keeps full opacity: its label is bold, not dim.
		const top = rendered.findIndex((l) => l.includes('┌'));
		expect(rendered[top]).toContain('⟨b:✗ Reopen task 1 — reason:⟩');
	});

	test('space on a done task prompts for a reason and reopens it', async () => {
		const { view, lines, lastBacklog } = createEditableView();
		view.handleInput(' '); // task 1 (done)
		expect(lines().join('\n')).toContain('✗ Reopen task 1 — reason:');
		for (const ch of 'blocked on API access') view.handleInput(ch);
		view.handleInput('\r');
		await flush();
		expect(lines().join('\n')).toContain('> [ ] + 1 Establish');
		const entries = lastBacklog()?.listLogEntriesForTask(1) ?? [];
		expect(entries).toHaveLength(2); // the imported entry plus the reopen note
		expect(entries.at(-1)?.note).toBe('blocked on API access');
		expect(entries.at(-1)?.date).toBe(today());
		expect(entries.at(-1)?.kind).toBe('reopen');
		// The expanded task shows the reopen entry with a cross, not a check.
		view.handleInput('o');
		expect(lines().join('\n')).toContain(`✗ ${today()} blocked on API access`);
	});

	test('space with an empty reason refuses to toggle and shows a notice', async () => {
		const { view, lines } = createEditableView();
		view.handleInput('j'); // task 2 (open)
		view.handleInput(' ');
		view.handleInput('\r');
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).toContain('a reason is required');
		expect(lines().join('\n')).toContain('> [ ] + 2 Remove');
	});

	test('Esc cancels the reason prompt without changing the task', () => {
		const { view, lines } = createEditableView();
		view.handleInput('j');
		view.handleInput(' ');
		for (const ch of 'nope') view.handleInput(ch);
		view.handleInput('\x1b');
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).toContain('> [ ] + 2 Remove');
	});

	test('the footer advertises space only with a mutate callback', () => {
		const editable = createEditableView();
		expect(editable.lines(200).join('\n')).toContain('space: toggle done');
		const plain = createView();
		expect(plain.lines(200).join('\n')).not.toContain('space: toggle done');
	});

	test('space is inert without a mutate callback', () => {
		let renderRequests = 0;
		const view = createTodosView({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			requestRender: () => {
				renderRequests += 1;
			},
			onClose: () => {}
		});
		view.handleInput(' ');
		expect(renderRequests).toBe(0);
		expect(view.mode()).toBe('browse');
	});
});


describe('todos view popup scrolling', () => {
	function createPopupView(height: number) {
		const view = createTodosView({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			height: () => height,
			requestRender: () => {},
			onClose: () => {}
		});
		return { view, lines: (width = 100) => view.render(width) };
	}

	test('renders a fixed-height window that keeps header and footer', () => {
		const { view, lines } = createPopupView(6);
		const rendered = lines(80);
		expect(rendered.length).toBeLessThanOrEqual(6);
		expect(rendered[0]).toContain('Ralph backlog');
		// Narrow width: the key hints wrap onto two footer lines.
		expect(rendered.at(-2)).toContain('jk: move');
		expect(rendered.at(-1)).toContain('q: quit');
		// Wide width: the footer fits on a single line.
		const wide = lines(120);
		expect(wide.at(-1)).toContain('jk: move');
		expect(wide.at(-1)).toContain('q: quit');
	});

	test('pads a short list with blank lines up to the full height', () => {
		const short = Backlog.parse('# ralph v2\n\nT 1 - "Only task"\n');
		const view = createTodosView({
			backlog: short,
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			height: () => 20,
			requestRender: () => {},
			onClose: () => {}
		});
		const rendered = view.render(80);
		expect(rendered.length).toBe(20);
		// The blank padding sits between the list and the footer.
		const footerIndex = rendered.findIndex((line) => line.includes('jk: move'));
		expect(rendered[footerIndex - 1]).toBe('');
	});
	test('page down and page up scroll the window', () => {
		const { view, lines } = createPopupView(6);
		expect(view.scrollTop()).toBe(0);
		expect(lines().join('\n')).toContain('Establish a clean local developer contract.');
		view.handleInput('\x1b[6~'); // PageDown
		expect(view.scrollTop()).toBeGreaterThan(0);
		view.handleInput('\x1b[6~');
		view.handleInput('\x1b[6~');
		const max = view.scrollTop();
		view.handleInput('\x1b[6~'); // clamped at the end
		expect(view.scrollTop()).toBe(max);
		view.handleInput('\x1b[5~'); // PageUp
		expect(view.scrollTop()).toBeLessThan(max);
		view.handleInput('\x1b[5~');
		view.handleInput('\x1b[5~');
		view.handleInput('\x1b[5~');
		expect(view.scrollTop()).toBe(0);
	});

	test('cursor movement scrolls the window to keep the cursor visible', () => {
		const { view, lines } = createPopupView(6); // body window: 4 rows
		for (let i = 0; i < 5; i += 1) view.handleInput('j');
		expect(view.cursor()).toBe(3); // task 4, the last task
		expect(view.scrollTop()).toBeGreaterThan(0);
		expect(lines().join('\n')).toContain('Decide migration strategy.');
		view.handleInput('g');
		expect(view.scrollTop()).toBe(0);
		expect(lines().join('\n')).toContain('Establish a clean local developer contract.');
	});

	test('page keys scroll away from the cursor without snapping back', () => {
		const { view } = createPopupView(6);
		view.handleInput('\x1b[6~');
		const afterPage = view.scrollTop();
		expect(afterPage).toBeGreaterThan(0);
		// The cursor is still on the first task; the window must not snap back.
		expect(view.cursor()).toBe(0);
		expect(view.scrollTop()).toBe(afterPage);
	});
});

describe('todos view expansion scrolling', () => {
	// Eight tasks; the last one carries a body and three log entries so its
	// expansion overflows a small window.
	const TALL_SAMPLE = `# ralph v2

T 1 - "Task one"
D 1

T 2 - "Task two"

T 3 - "Task three"

T 4 - "Task four"

T 5 - "Task five"

T 6 - "Task six"

T 7 - "Task seven"

T 8 - "Task eight"
B 8
  body line one
  body line two
L 1 8 2026-08-10
  first log entry
L 2 8 2026-08-11
  second log entry
L 3 8 2026-08-12
  third log entry
`;

	function createTallView(height: number) {
		const view = createTodosView({
			backlog: Backlog.parse(TALL_SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			height: () => height,
			requestRender: () => {},
			onClose: () => {}
		});
		return { view, lines: (width = 100) => view.render(width) };
	}

	test('j scrolls the window down when the cursor is on the last task', () => {
		const { view } = createTallView(6); // body window: 3 rows
		view.handleInput('G'); // last task, window at the bottom (scrollTop 5)
		view.handleInput('\x1b[5~'); // PageUp: scroll away from the cursor
		expect(view.scrollTop()).toBe(3);
		view.handleInput('j'); // cursor cannot move further; the window does
		expect(view.scrollTop()).toBe(4);
		view.handleInput('j');
		expect(view.scrollTop()).toBe(5);
		view.handleInput('j'); // clamped at the end
		expect(view.scrollTop()).toBe(5);
	});

	test('k scrolls the window up when the cursor is on the first task', () => {
		const { view } = createTallView(6);
		view.handleInput('\x1b[6~'); // PageDown: scroll away from the cursor
		expect(view.scrollTop()).toBe(2);
		view.handleInput('k');
		expect(view.scrollTop()).toBe(1);
		view.handleInput('k');
		expect(view.scrollTop()).toBe(0);
		view.handleInput('k'); // clamped at the top
		expect(view.scrollTop()).toBe(0);
	});

	test('expanding the last task scrolls its content into view', () => {
		const { view, lines } = createTallView(6); // body window: 3 rows
		view.handleInput('G'); // cursor on the last task (line 7)
		view.handleInput('o'); // 5 detail lines appear below the window
		// The task line stays visible at the top of the window and the first
		// detail lines are revealed.
		const text = lines().join('\n');
		expect(text).toContain('> [ ] − 8 Task eight');
		expect(text).toContain('body line one');
		expect(text).toContain('body line two');
		expect(text).not.toContain('third log entry');
		// j scrolls through the rest of the expansion.
		view.handleInput('j');
		expect(lines().join('\n')).toContain('first log entry');
		view.handleInput('j');
		view.handleInput('j');
		expect(lines().join('\n')).toContain('third log entry');
	});
});

describe('todos view line wrapping', () => {
	// The title and the log note are long enough to wrap at the narrow test
	// width (40 columns).
	const WRAP_SAMPLE = `# ralph v2

T 1 - "A task with a title that is long enough to wrap at the narrow test width"

T 2 - "Task with long log"
L 1 2 2026-08-10
  This log note is deliberately long so that it wraps across several lines at the narrow test width used below
`;

	function createWrapView(height?: number) {
		const view = createTodosView({
			backlog: Backlog.parse(WRAP_SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			height: height === undefined ? undefined : () => height,
			requestRender: () => {},
			onClose: () => {}
		});
		return { view, lines: (width = 40) => view.render(width) };
	}

	test('long lines wrap to the width instead of truncating', () => {
		const { view, lines } = createWrapView();
		view.handleInput('j');
		view.handleInput('o'); // expand the task with the long log note
		const rendered = lines(40);
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
		const text = rendered.join('\n');
		// The full title and note are present, split across lines.
		expect(text).toContain('A task with a title that is');
		expect(text).toContain('narrow test width');
		expect(text).toContain('✓ 2026-08-10 This log note is');
		expect(text).toContain('the narrow test width used below');
		// No truncation ellipsis in the body lines (header/footer aside).
		for (const line of rendered.slice(1, -2)) {
			expect(line).not.toContain('…');
		}
	});

	test('wrapped log continuations align under the text without the marker', () => {
		const { view, lines } = createWrapView();
		view.handleInput('j');
		view.handleInput('o');
		const rendered = lines(40);
		const first = rendered.findIndex((line) => line.includes('✓'));
		expect(first).toBeGreaterThan(-1);
		expect(rendered[first]).toContain('✓ 2026-08-10 This log note is');
		expect(rendered[first + 1]).toBe('        deliberately long so that it');
		expect(rendered[first + 2]).toBe('        wraps across several lines at');
		expect(rendered[first + 3]).toBe('        the narrow test width used below');
	});

	test('scrolling reaches every wrapped line', () => {
		const { view, lines } = createWrapView(6); // body window: 3 rows
		lines(40); // establish the layout width
		view.handleInput('G');
		view.handleInput('o'); // expand the last task (the note wraps to 4 lines)
		expect(lines(40).join('\n')).toContain('Task with long log');
		for (let i = 0; i < 10; i += 1) view.handleInput('\x1b[6~'); // PageDown
		expect(lines(40).join('\n')).toContain('the narrow test width used below');
	});

	test('the form body preview wraps long lines instead of truncating', () => {
		// A list long enough that the popup gets a full-height budget.
		let sample = `# ralph v2\n\n`;
		for (let i = 1; i <= 8; i += 1) sample += `T ${i} - "Task ${i}"\n\n`;
		sample += `B 8\n  This body line is deliberately long so that it wraps across several lines in the popup\n`;
		const view = createTodosView({
			backlog: Backlog.parse(sample),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			requestRender: () => {},
			onClose: () => {},
			mutate: (backlog, fn) => {
				fn(backlog);
				return true;
			}
		});
		view.handleInput('G');
		view.handleInput('e');
		const rendered = view.render(50);
		const text = rendered.join('\n');
		// The full body line is present, wrapped across the box lines.
		expect(text).toContain('This body line is deliberately long so');
		expect(text).toContain('that it wraps across several lines in');
		expect(text).toContain('the popup');
		// No truncation ellipsis inside the box.
		const top = rendered.findIndex((line) => line.includes('┌'));
		const bottom = rendered.findIndex((line) => line.includes('└'));
		for (const line of rendered.slice(top, bottom + 1)) {
			expect(line).not.toContain('…');
		}
	});
});

describe('todos view popup layout', () => {
	function createLayoutView(height?: number) {
		let sample = `# ralph v2\n\n`;
		for (let i = 1; i <= 8; i += 1) sample += `T ${i} - "Task ${i}"\n\n`;
		const view = createTodosView({
			backlog: Backlog.parse(sample),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			height: height === undefined ? undefined : () => height,
			requestRender: () => {},
			onClose: () => {},
			mutate: (backlog, fn) => {
				fn(backlog);
				return true;
			}
		});
		return { view, lines: (width = 100) => view.render(width) };
	}

	test('the popup box spans the full list width', () => {
		const { view, lines } = createLayoutView();
		view.handleInput(' ');
		const rendered = lines(100);
		const top = rendered.findIndex((l) => l.includes('┌'));
		// Two-space margin on each side: the right border sits at the last
		// column.
		expect(rendered[top]).toMatch(/^  ┌ /);
		// The top border stays a solid line: the title sits in it and the
		// remainder up to the corner is filled with border characters.
		expect(rendered[top]).toMatch(/^  ┌ .*─+┐\s*$/);
		expect(rendered[top]).toMatch(/┐\s*$/);
	});

	test('the body is cleared and the popup is centered', () => {
		const { view, lines } = createLayoutView();
		view.handleInput(' ');
		const rendered = lines(100);
		// No list lines while the popup is open.
		expect(rendered.join('\n')).not.toContain('Task 4');
		// Centered in the body area: blank lines above the box and below its
		// hint.
		const top = rendered.findIndex((l) => l.includes('┌'));
		const bottom = rendered.findIndex((l) => l.includes('└'));
		expect(rendered[top - 1]).toBe('');
		expect(rendered[bottom + 2]).toBe('');
	});

	test('the body editor stays inside the form popup', () => {
		const { view, lines } = createLayoutView(16);
		view.handleInput('G');
		view.handleInput('e');
		view.handleInput('\t');
		view.handleInput('\r');
		expect(view.mode()).toBe('editor');
		const rendered = lines(100);
		const text = rendered.join('\n');
		// The form box stays: the title and the body label are inside it.
		expect(text).toContain('┌');
		expect(text).toContain('Title:');
		expect(text).toContain('Body:');
		// The editor is embedded in the box, framed by its own top/bottom
		// borders (3-space body indent inside the box padding).
		const borders = rendered.map((l, i) => (l.startsWith('  │    ─') ? i : -1)).filter((i) => i >= 0);
		expect(borders).toHaveLength(2);
		// The body is cleared like the other popup modes.
		expect(text).not.toContain('Task 4');
		// The editor hint is attached below the box.
		const bottom = rendered.findIndex((l) => l.includes('└'));
		expect(rendered[bottom + 1]).toContain('enter: newline · ctrl+s: save body · esc: back to form');
	});
});
