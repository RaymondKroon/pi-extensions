import { describe, expect, test } from 'bun:test';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { Backlog } from './backlog.ts';
import { createRalphHome, type RalphHomeOptions } from './ralph-home.ts';
import type { RalphViewTheme } from './view-kit.ts';

const SAMPLE = `# ralph v2

G "Rewrite the app in the new framework" open
GB
  - Port the routes.
  - Port the state.
GE "All routes render; bun test green."
GC 4
  Completed: routes. Next step: state.

T 1 dossier "First task."
T 2 auth "Second task."
T 3 - "Unfiled task."
`;

const NO_GOAL_SAMPLE = `# ralph v2

T 1 dossier "First task."
T 2 - "Unfiled task."
`;

const theme: RalphViewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text
};

/** Minimal TUI stub for the built-in Editor (terminal rows + requestRender). */
const stubTui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;

function createHome(options?: {
	backlog?: Backlog;
	reload?: () => Backlog | undefined;
	fail?: boolean;
}) {
	let renderRequests = 0;
	let closed = false;
	const opened: Array<string | undefined> = [];
	const started: boolean[] = [];
	let lastBacklog: Backlog | undefined;
	const view = createRalphHome({
		backlog: options?.backlog ?? Backlog.parse(SAMPLE),
		tui: stubTui,
		title: 'TODO.ralph',
		theme,
		requestRender: () => {
			renderRequests += 1;
		},
		onClose: () => {
			closed = true;
		},
		reload: options?.reload,
		onOpenList: (category) => {
			opened.push(category);
		},
		onStartGoalLoop: () => {
			started.push(true);
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
		renderRequests: () => renderRequests,
		closed: () => closed,
		opened,
		started,
		lastBacklog: () => lastBacklog,
		type: (text: string) => {
			for (const ch of text) view.handleInput(ch);
		}
	};
}

function createHomeWith(options: Partial<RalphHomeOptions>) {
	let closed = false;
	const view = createRalphHome({
		backlog: Backlog.parse(SAMPLE),
		tui: stubTui,
		title: 'TODO.ralph',
		theme,
		requestRender: () => {},
		onClose: () => {
			closed = true;
		},
		onOpenList: () => {},
		onStartGoalLoop: () => {},
		...options
	});
	return { view, lines: (width = 100) => view.render(width), closed: () => closed };
}

// Mutations go through an async mutate callback; let the rebuild land.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('home view rendering', () => {
	test('renders the goal row, list rows with counts, and footer', () => {
		const { lines } = createHome();
		const rendered = lines();
		const text = rendered.join('\n');
		expect(rendered[0]).toContain('Ralph home — TODO.ralph');
		expect(rendered[0]).toContain('3 of 3 open (0 done)');
		expect(text).toContain('> ● Goal: Rewrite the app in the new framework (open)');
		expect(text).toContain('  (all) — 3 open / 3 total');
		expect(text).toContain('  auth — 1 open / 1 total');
		expect(text).toContain('  dossier — 1 open / 1 total');
		expect(rendered.at(-1)).toContain('q: quit');
	});

	test('renders without a goal: no goal row, lists first', () => {
		const { lines } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		const text = lines().join('\n');
		expect(text).not.toContain('Goal:');
		expect(text).not.toContain('No goal');
		expect(text).toContain('> (all) — 2 open / 2 total');
		expect(text).toContain('  dossier — 1 open / 1 total');
		// The goal-only keys are not advertised.
		expect(text).not.toContain('O: goal detail');
		expect(text).not.toContain('S: start goal loop');
		expect(text).not.toContain('D: delete goal');
		expect(text).toContain('A: add/edit goal');
	});

	test('colors the goal row by status', () => {
		const marked: RalphViewTheme = {
			fg: (color, text) => (color === 'dim' ? `⟨${text}⟩` : color === 'accent' ? `⟨a:${text}⟩` : text),
			bold: (text) => `⟨b:${text}⟩`
		};
		const make = (status: 'open' | 'claimed' | 'done') => {
			const backlog = Backlog.parse(SAMPLE);
			if (status === 'claimed') backlog.claimGoal('evidence');
			else if (status === 'done') {
				backlog.claimGoal('evidence');
				backlog.confirmGoal();
			}
			const view = createRalphHome({
				backlog,
				tui: stubTui,
				title: 'TODO.ralph',
				theme: marked,
				requestRender: () => {},
				onClose: () => {},
				onOpenList: () => {}
			});
			return view.render(100).find((line) => line.includes('Goal:'))!;
		};
		expect(make('open')).toContain('●');
		expect(make('open')).toContain('⟨a: (open)⟩');
		expect(make('claimed')).toContain('◐');
		expect(make('claimed')).toContain('⟨b: (claimed)⟩');
		const done = make('done');
		expect(done).toContain('✓');
		expect(done).toContain('⟨ (done)⟩');
	});

	test('truncates long lines to the width', () => {
		const { lines } = createHome();
		for (const line of lines(20)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});
});

describe('home view goal detail', () => {
	test('O expands the goal to criteria, evidence, and checkpoint rows', () => {
		const { view, lines } = createHome();
		expect(view.expanded()).toBe(false);
		const collapsed = lines().join('\n');
		expect(collapsed).not.toContain('criteria:');
		expect(collapsed).not.toContain('evidence:');
		view.handleInput('O');
		expect(view.expanded()).toBe(true);
		const text = lines().join('\n');
		expect(text).toContain('criteria: - Port the routes.');
		expect(text).toContain('      - Port the state.');
		expect(text).toContain('evidence: All routes render; bun test green.');
		expect(text).toContain('checkpoint (iteration 4): Completed: routes. Next step: state.');
		// O collapses again.
		view.handleInput('O');
		expect(view.expanded()).toBe(false);
		expect(lines().join('\n')).not.toContain('criteria:');
	});

	test('enter on the goal row toggles expansion', () => {
		const { view, lines } = createHome();
		expect(view.cursor()).toBe(0); // the goal row
		view.handleInput('\r');
		expect(view.expanded()).toBe(true);
		expect(lines().join('\n')).toContain('criteria:');
		view.handleInput('\r');
		expect(view.expanded()).toBe(false);
	});

	test('O is inert without a goal', () => {
		const { view, lines } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		const before = lines().join('\n');
		view.handleInput('O');
		expect(view.expanded()).toBe(false);
		expect(lines().join('\n')).toBe(before);
	});
});

describe('home view navigation', () => {
	test('j/k move the cursor over goal and list rows with clamping', () => {
		const { view } = createHome();
		// Rows: goal, (all), auth, dossier.
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
	});

	test('g/G jump to first and last row', () => {
		const { view } = createHome();
		view.handleInput('G');
		expect(view.cursor()).toBe(3);
		view.handleInput('g');
		expect(view.cursor()).toBe(0);
	});

	test('enter on a list row opens the task view for that list', () => {
		const { view, opened } = createHome();
		view.handleInput('j'); // (all)
		view.handleInput('\r');
		expect(opened).toEqual([undefined]);
		view.handleInput('j'); // dossier (lists follow task order)
		view.handleInput('\r');
		expect(opened).toEqual([undefined, 'dossier']);
		// Opening a list does not close the home view.
		expect(view.cursor()).toBe(2);
	});

	test('r reloads the backlog from disk', () => {
		const fresh = Backlog.parse(NO_GOAL_SAMPLE);
		const { view, lines } = createHome({ reload: () => fresh });
		expect(lines().join('\n')).toContain('Goal:');
		view.handleInput('r');
		const text = lines().join('\n');
		expect(text).not.toContain('Goal:');
		expect(text).toContain('(all) — 2 open / 2 total');
	});

	test('q and Escape close the view', () => {
		const { view, closed } = createHome();
		view.handleInput('q');
		expect(closed()).toBe(true);
		const second = createHome();
		second.view.handleInput('\x1b');
		expect(second.closed()).toBe(true);
	});

	test('unknown keys are ignored without re-rendering', () => {
		const { view, renderRequests } = createHome();
		const before = renderRequests();
		view.handleInput('z');
		expect(renderRequests()).toBe(before);
	});
});

describe('home view goal form', () => {
	test('A without a goal opens the form; saving adds an open goal', async () => {
		const { view, lines, lastBacklog } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		view.handleInput('A');
		expect(view.mode()).toBe('form');
		const popup = lines().join('\n');
		expect(popup).toContain('┌');
		expect(popup).toContain('New goal');
		expect(popup).toContain('Title:');
		expect(popup).toContain('Body:');
		view.handleInput('\r'); // enter starts editing
		for (const ch of 'Ship the rewrite') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(view.mode()).toBe('browse');
		const text = lines().join('\n');
		expect(text).toContain('> ● Goal: Ship the rewrite (open)');
		expect(lastBacklog()!.goal()?.status).toBe('open');
	});

	test('A with a goal opens the form prefilled; editing the title saves', async () => {
		const { view, lines, lastBacklog } = createHome();
		view.handleInput('A');
		expect(view.mode()).toBe('form');
		const form = lines().join('\n');
		expect(form).toContain('Edit goal');
		expect(form).toContain('Rewrite the app in the new framework');
		view.handleInput('\r'); // enter starts editing
		for (const ch of ' (edited)') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(lines().join('\n')).toContain('Goal: Rewrite the app in the new framework (edited)');
		// Editing preserves the status and the state machine fields.
		expect(lastBacklog()!.goal()?.status).toBe('open');
		expect(lastBacklog()!.goal()?.evidence).toBe('All routes render; bun test green.');
	});

	test('A with an empty title refuses to save and keeps the form open', async () => {
		const { view, lines } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		view.handleInput('A');
		view.handleInput('\r');
		view.handleInput('\x13'); // Ctrl+S with no title
		expect(view.mode()).toBe('form');
		expect(lines().join('\n')).toContain('a goal title is required');
	});

	test('Esc cancels the form without changing the goal', async () => {
		const { view, lines } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		view.handleInput('A');
		for (const ch of 'Nope') view.handleInput(ch);
		view.handleInput('\x1b');
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).not.toContain('Goal:');
	});

	test('a failed goal save keeps the previous data and shows a notice', async () => {
		const { view, lines } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE), fail: true });
		view.handleInput('A');
		view.handleInput('\r');
		for (const ch of 'Nope') view.handleInput(ch);
		view.handleInput('\x13'); // Ctrl+S
		await flush();
		expect(lines().join('\n')).toContain('not saved');
		expect(lines().join('\n')).not.toContain('Goal:');
	});
});

describe('home view goal confirms', () => {
	test('D deletes the goal after confirmation', async () => {
		const { view, lines, lastBacklog } = createHome();
		view.handleInput('D');
		expect(view.mode()).toBe('confirm');
		expect(lines().join('\n')).toContain('Delete the goal "Rewrite the app in the new framework"?');
		view.handleInput('y');
		await flush();
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).not.toContain('Goal:');
		expect(lastBacklog()!.goal()).toBeUndefined();
	});

	test('D with n keeps the goal', async () => {
		const { view, lines } = createHome();
		view.handleInput('D');
		view.handleInput('n');
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).toContain('Goal:');
	});

	test('D is inert without a goal', () => {
		const { view } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		view.handleInput('D');
		expect(view.mode()).toBe('browse');
	});

	test('S starts the goal loop after confirmation and closes the view', () => {
		const { view, lines, started, closed } = createHome();
		view.handleInput('S');
		expect(view.mode()).toBe('confirm');
		expect(lines().join('\n')).toContain('Start the Ralph goal loop?');
		view.handleInput('y');
		expect(started).toEqual([true]);
		expect(closed()).toBe(true);
	});

	test('S with n does not start the loop', () => {
		const { view, started, closed } = createHome();
		view.handleInput('S');
		view.handleInput('n');
		expect(started).toEqual([]);
		expect(closed()).toBe(false);
	});

	test('S is inert without a goal', () => {
		const { view, started } = createHome({ backlog: Backlog.parse(NO_GOAL_SAMPLE) });
		view.handleInput('S');
		expect(view.mode()).toBe('browse');
		expect(started).toEqual([]);
	});
});

describe('home view list management', () => {
	test('R renames the highlighted list', async () => {
		const { view, lines, lastBacklog } = createHome();
		view.handleInput('j'); // (all)
		view.handleInput('j'); // dossier
		view.handleInput('j'); // auth
		view.handleInput('R');
		expect(view.mode()).toBe('input');
		for (const ch of 'identity') view.handleInput(ch);
		view.handleInput('\r');
		await flush();
		expect(view.mode()).toBe('browse');
		const text = lines().join('\n');
		// The input is prefilled with the old name; typing appends to it.
		expect(text).toContain('authidentity — 1 open / 1 total');
		expect(text).not.toContain('  auth —');
		expect(lastBacklog()!.categories()).toEqual(['dossier', 'authidentity']);
	});

	test('R on the (all) row or the goal row does nothing', () => {
		const { view } = createHome();
		view.handleInput('R'); // goal row
		expect(view.mode()).toBe('browse');
		view.handleInput('j'); // (all)
		view.handleInput('R');
		expect(view.mode()).toBe('browse');
	});

	test('management keys are inert without a mutate callback', () => {
		const { view, lines } = createHomeWith({ mutate: undefined });
		view.handleInput('A');
		expect(view.mode()).toBe('browse');
		view.handleInput('D');
		expect(view.mode()).toBe('browse');
		view.handleInput('R');
		expect(view.mode()).toBe('browse');
		expect(lines().join('\n')).toContain('Goal:');
	});

	test('the footer advertises the goal keys only when available', () => {
		const { lines } = createHomeWith({ mutate: undefined });
		const text = lines().join('\n');
		expect(text).not.toContain('A: add/edit goal');
		expect(text).not.toContain('R: rename list');
		expect(text).toContain('S: start goal loop');
	});
});

describe('home view popup layout', () => {
	const MANY_LISTS = `# ralph v2

G "Ship the rewrite" open

T 1 a "t."
T 2 b "t."
T 3 c "t."
T 4 d "t."
T 5 e "t."
T 6 f "t."
`;

	test('the form popup floats over a cleared body with attached hints', () => {
		const { view, lines } = createHome({ backlog: Backlog.parse(MANY_LISTS) });
		view.handleInput('A');
		const rendered = lines();
		const top = rendered.findIndex((l) => l.includes('┌'));
		expect(rendered[top]).toContain('Edit goal');
		const bottom = rendered.findIndex((l) => l.includes('└'));
		expect(rendered[bottom + 1]).toContain('ctrl+s: save · esc: cancel');
		// The body around the popup is cleared (blanked).
		expect(rendered[top - 1].trim()).toBe('');
	});

	test('renders a fixed-height window that keeps header and footer', () => {
		const view = createRalphHome({
			backlog: Backlog.parse(SAMPLE),
			tui: stubTui,
			title: 'TODO.ralph',
			theme,
			height: () => 8,
			requestRender: () => {},
			onClose: () => {},
			onOpenList: () => {}
		});
		const rendered = view.render(100);
		expect(rendered.length).toBeLessThanOrEqual(8);
		expect(rendered[0]).toContain('Ralph home');
		expect(rendered.at(-1)).toContain('q: quit');
	});
});
