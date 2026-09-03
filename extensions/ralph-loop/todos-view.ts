// Interactive backlog view for the pi TUI.
//
// Rendered through ExtensionUIContext.custom() as a fullscreen component with
// a fixed-height, scrollable body. It shows the Ralph backlog (a single flat
// list of tasks) with a highlighted cursor. Tasks can be expanded (o) to
// show their body and the completion log entries linked to them, and space
// toggles a task done/reopen after prompting for a reason (recorded as a
// completion log entry).
//
// When the host provides a mutate callback, entries are managed from the view:
// a add, e edit, x delete, J/K move the current task down/up, R rename the
// current list, s start a Ralph loop on it.
//
// Every prompt (add/edit form, reason, delete/start confirm, list rename)
// shares one floating popup: a full-width bordered box, centered over the
// cleared body area, with its key hint attached below the box. The body
// editor floats the same way but keeps the dimmed list visible behind it.
// The popup machinery (the box, the form/confirm/input/reason/editor
// modes, and the footer layout) lives in view-kit.ts, shared with the
// home view; this view owns the browse rendering, scrolling, and the
// task mutations the popups trigger.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from '@earendil-works/pi-tui';
import { Backlog, type Task } from './backlog.ts';
import {
	ARROW_DOWN,
	ARROW_UP,
	createModeController,
	dimmedTheme,
	ESCAPE,
	layoutFooter,
	PAGE_DOWN,
	PAGE_UP,
	renderModeBody,
	type FormMode,
	type RalphViewTheme
} from './view-kit.ts';

/** The subset of the pi theme the view needs (fg/bold are stable API). */
export type TodosViewTheme = RalphViewTheme;

export { layoutFooter } from './view-kit.ts';

interface TaskRow {
	kind: 'task';
	task: Task;
}

/** A line inside an expanded task (body text or a linked log entry). */
interface DetailRow {
	kind: 'detail';
	flavor: 'body' | 'log';
	/** Log entry kind (log flavor only); picks the ✓/✗ marker. */
	logKind?: 'done' | 'reopen';
	text: string;
}

type Row = TaskRow | DetailRow;

export interface TodosViewOptions {
	backlog: Backlog;
	/** The host TUI (used to construct the built-in Editor for body editing). */
	tui: TUI;
	/** Display name of the source (e.g. the backlog file path). */
	title: string;
	/** Scope the view to one category. */
	category?: string;
	theme: TodosViewTheme;
	/**
	 * Total view height in lines (header + body + footer). When provided the
	 * body is a scroll window padded with blank lines up to the full height (so
	 * the overlay blacks out the chat behind it, like the home view); when
	 * omitted every row is rendered (tests).
	 * A function so the host can track terminal resizes.
	 */
	height?: () => number;
	/** Re-render the TUI after state changes. */
	requestRender: () => void;
	/** Close the view (called on q). */
	onClose: () => void;
	/** Go back to the list overview (called on Escape); falls back to onClose. */
	onBack?: () => void;
	/** Reload the backlog from disk (r key); return undefined to keep current data. */
	reload?: () => Backlog | undefined;
	/**
	 * Persist a backlog mutation: run fn on the view's current backlog
	 * instance and write the result to disk. Return false when the change was
	 * not saved (the view keeps showing the previous data).
	 */
	mutate?: (backlog: Backlog, fn: (b: Backlog) => void) => Promise<boolean> | boolean;
	/** Start a Ralph loop scoped to the given category (undefined = whole backlog). */
	onStartLoop?: (category?: string) => void | Promise<void>;
}

/** Today's date as YYYY-MM-DD (local time), for completion log entries. */
const todayDate = (): string => {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

export interface TodosView {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
	/** Index of the highlighted task (test hook). */
	cursor(): number;
	/** Index of the first visible body line (test hook). */
	scrollTop(): number;
	/** Ids of the expanded tasks (test hook). */
	expandedIds(): number[];
	/** Current input mode: browse | input | reason | form | confirm | editor (test hook). */
	mode(): string;
}

/**
 * Create the backlog view component. Rows are derived from the backlog on
 * creation and on reload; the cursor indexes the task rows only.
 */
export function createTodosView(options: TodosViewOptions): TodosView {
	let backlog = options.backlog;
	let cursor = 0;
	let scrollTop = 0;
	// Mutable: R renames the scoped list in place.
	let category: string | undefined = options.category;
	// Transient feedback for the last mutation, cleared on the next key.
	let notice: string | undefined;
	// The host theme, swapped for a dimmed variant while a popup is open so
	// the list behind it recedes.
	let theme = options.theme;
	// True while a popup is open: every list line is dimmed, not just the
	// segments the theme colors.
	let dimmed = false;
	const expanded = new Set<number>();

	// Scroll layout of the current rows: the start line of every row plus the
	// total line count. Word wrapping makes the layout width-dependent, so it
	// is derived at render time and cached; handleInput recomputes it at the
	// last rendered width when the rows changed since the last render.
	let lastWidth: number | undefined;
	let layout: { rowLineStart: number[]; totalLines: number } | undefined;

	const rebuild = (): {
		rows: Row[];
		tasks: Task[];
		numbers: Map<number, string>;
		taskRowIndex: Map<number, number>;
	} => {
		layout = undefined; // rows changed: the width-dependent layout is stale
		const tasks = backlog.listTasks(category);
		const numbers = backlog.taskNumbers(category);
		const rows: Row[] = [];
		const taskRowIndex = new Map<number, number>();
		for (const task of tasks) {
			taskRowIndex.set(task.id, rows.length);
			rows.push({ kind: 'task', task });
			if (expanded.has(task.id)) {
				if (task.body !== null) {
					for (const line of task.body.split('\n')) {
						rows.push({ kind: 'detail', flavor: 'body', text: line });
					}
				}
				for (const entry of backlog.listLogEntriesForTask(task.id)) {
					const date = entry.date ? `${entry.date} ` : '';
					rows.push({ kind: 'detail', flavor: 'log', logKind: entry.kind, text: `${date}${entry.note}` });
				}
			}
		}
		// Drop expansions for tasks that no longer exist (e.g. after reload).
		for (const id of [...expanded]) {
			if (!taskRowIndex.has(id)) expanded.delete(id);
		}
		return { rows, tasks, numbers, taskRowIndex };
	};

	let state = rebuild();
	const clampCursor = () => {
		cursor = Math.max(0, Math.min(cursor, Math.max(0, state.tasks.length - 1)));
	};
	clampCursor();

	// --- scrolling -------------------------------------------------------------

	const bodyHeight = (): number | undefined => {
		const total = options.height?.();
		if (total === undefined) return undefined;
		return Math.max(1, total - 3); // header + two footer lines
	};

	/**
	 * Compute the scroll layout of the current rows at the given width (by
	 * rendering each row to count its wrapped lines) and cache it for
	 * handleInput.
	 */
	const computeLayout = (width: number) => {
		const rowLineStart: number[] = [];
		let total = 0;
		for (const row of state.rows) {
			rowLineStart.push(total);
			total += renderRow(row, width).length;
		}
		lastWidth = width;
		layout = { rowLineStart, totalLines: total };
		return layout;
	};

	/** The cached layout, or a fresh one at the last rendered width. */
	const currentLayout = () => (layout !== undefined ? layout : computeLayout(lastWidth ?? 80));

	const maxScroll = (): number => {
		const bh = bodyHeight();
		if (bh === undefined) return 0;
		return Math.max(0, currentLayout().totalLines - bh);
	};

	const clampScroll = () => {
		scrollTop = Math.max(0, Math.min(scrollTop, maxScroll()));
	};

	const keepCursorVisible = () => {
		const bh = bodyHeight();
		if (bh === undefined) return;
		const task = state.tasks[cursor];
		const row = task ? state.taskRowIndex.get(task.id) : undefined;
		const line = row === undefined ? undefined : currentLayout().rowLineStart[row];
		if (line === undefined) return;
		if (line < scrollTop) scrollTop = line;
		else if (line >= scrollTop + bh) scrollTop = line - bh + 1;
		clampScroll();
	};

	// --- mutations -------------------------------------------------------------

	/**
	 * Run fn on the view's backlog through the host's mutate callback and
	 * refresh the rows on success. On failure the view re-reads from disk so
	 * in-memory and on-disk state cannot drift.
	 */
	const applyMutation = async (fn: (b: Backlog) => void): Promise<boolean> => {
		if (!options.mutate) return false;
		let ok = false;
		try {
			ok = await options.mutate(backlog, fn);
		} catch {
			ok = false;
		}
		if (ok) {
			notice = 'saved';
			state = rebuild();
		} else {
			notice = 'not saved';
			const fresh = options.reload?.();
			if (fresh) {
				backlog = fresh;
				state = rebuild();
			}
		}
		clampCursor();
		clampScroll();
		options.requestRender();
		return ok;
	};

	/** Move the cursor to the task with the given id (after a mutation). */
	const focusTaskId = (id: number) => {
		const index = state.tasks.findIndex((task) => task.id === id);
		if (index >= 0) {
			cursor = index;
			keepCursorVisible();
		}
	};

	/** Save the form: apply the fields to the backlog, staying open on failure. */
	const saveForm = (form: FormMode) => {
		const values = {
			title: form.fields[0]!.input.getValue().trim(),
			body: form.body.join('\n')
		};
		if (!values.title) {
			notice = 'a task title is required';
			options.requestRender();
			return;
		}
		let newId: number | undefined;
		void (async () => {
			let ok = false;
			try {
				ok = await options.mutate!(backlog, (b) => {
					if (form.taskId !== undefined) {
						b.updateTaskById(form.taskId, {
							title: values.title,
							body: values.body
						});
					} else {
						newId = b.addTask({
							title: values.title,
							body: values.body === '' ? undefined : values.body,
							category: form.category
						}).id;
					}
				});
			} catch {
				ok = false;
			}
			if (ok) {
				modes.setMode({ kind: 'browse' });
				notice = 'saved';
				state = rebuild();
				if (form.taskId !== undefined) focusTaskId(form.taskId);
				else if (newId !== undefined) focusTaskId(newId);
			} else {
				notice = 'not saved';
			}
			clampCursor();
			clampScroll();
			options.requestRender();
		})();
	};

	// The popup modes (input, reason, form, confirm, editor) are owned by the
	// shared view kit; the view persists form saves through saveForm.
	const modes = createModeController({
		tui: options.tui,
		theme: options.theme,
		requestRender: options.requestRender,
		onSaveForm: saveForm
	});

	// --- rendering -------------------------------------------------------------

	const headerLine = (width: number): string => {
		const counts = backlog.counts(category);
		const scope = category ? ` · category "${category}"` : '';
		const title = theme.bold(`Ralph backlog — ${options.title}`);
		const summary = theme.fg('dim', `${counts.open} of ${counts.total} open${scope} (${counts.completed} done)`);
		const noticePart = notice ? `  ${theme.fg('accent', notice)}` : '';
		return truncateToWidth(`${title}  ${summary}${noticePart}`, width, '…');
	};

	const footerSegments = (): string[] => {
		const segments = ['jk: move', 'pgup/dn: page', 'u: next open', 'g/G: ends', 'o: expand', 'r: reload'];
		if (options.mutate) {
			segments.push('space: toggle done', 'a: add', 'e: edit', 'x: delete', 'J/K: move task');
			if (category !== undefined) segments.push('R: rename');
		}
		if (options.onStartLoop) segments.push('s: start');
		segments.push('q: quit');
		return segments;
	};

	const footerLines = (width: number): string[] =>
		layoutFooter(footerSegments(), width, (text) => theme.fg('dim', text));

	const renderTaskRow = (row: TaskRow, highlighted: boolean, width: number): string[] => {
		const { task } = row;
	const indent = '  ';
		const marker = task.done ? '[x]' : '[ ]';
		const number = `${state.numbers.get(task.id) ?? '?'} `;
		const expandMark = expanded.has(task.id) ? '−' : '+';
		const cursorMark = highlighted ? '> ' : '  ';
		// Color each segment individually: theme.fg() resets the foreground
		// after its text, so wrapping an already-colored segment (the number)
		// would un-dim everything after it. Only the popup dims the list;
		// done tasks keep the regular colors (the [x] marker shows their state).
		const prefix = `${indent}${cursorMark}${marker} ${expandMark} `;
		const prefixText = dimmed ? theme.fg('dim', prefix) : prefix;
		const numberText = theme.fg(dimmed ? 'dim' : 'accent', number);
		const titleText =
			(dimmed ? theme.fg('dim', task.title) : task.title) +
			(task.category ? theme.fg('dim', ` [${task.category}]`) : '');
		// Word-wrap the title instead of truncating it; continuation lines
		// align under the title start.
		const titleIndent = ' '.repeat(visibleWidth(prefixText) + visibleWidth(numberText));
		const lines = wrapTextWithAnsi(titleText, Math.max(1, width - titleIndent.length)).map(
			(line, index) => (index === 0 ? prefixText + numberText + line : titleIndent + line)
		);
		if (task.checkpoint !== null) {
			const checkpointIndent = `${indent}    `;
			lines.push(
				...wrapTextWithAnsi(
					`⚑ checkpoint (iteration ${task.checkpointIteration ?? '?'}): ${task.checkpoint}`,
					Math.max(1, width - checkpointIndent.length)
				).map((line) => theme.fg('dim', checkpointIndent + line))
			);
		}
		return lines;
	};

	const renderRow = (row: Row, width: number): string[] => {
		switch (row.kind) {
			case 'detail': {
				// Word-wrap long body/log lines; continuation lines align under
				// the text start (after the log marker, which only the first line
				// carries).
				const mark = row.flavor === 'log' ? (row.logKind === 'reopen' ? '✗ ' : '✓ ') : '';
				const indent = `      ${mark}`;
				const continuation = ' '.repeat(visibleWidth(indent));
				return wrapTextWithAnsi(row.text, Math.max(1, width - visibleWidth(indent))).map(
					(line, index) => theme.fg('dim', (index === 0 ? indent : continuation) + line)
				);
			}
			case 'task':
				return renderTaskRow(row, row.task.id === state.tasks[cursor]?.id, width);
		}
	};

	// The browse view: header + visible body window + footer. When a height is
	// configured the body is a scroll window sized so the total never exceeds
	// the popup height (the overlay would otherwise clip the footer).
	const browseLines = (width: number): string[] => {
		const header = headerLine(width);
		const footer = footerLines(width);
		const bh = bodyHeight();
		// Render every row once; the per-row line counts double as the scroll
		// layout (cached for handleInput).
		const rowLines = state.rows.map((row) => renderRow(row, width));
		const rowLineStart: number[] = [];
		let total = 0;
		for (const lines of rowLines) {
			rowLineStart.push(total);
			total += lines.length;
		}
		lastWidth = width;
		layout = { rowLineStart, totalLines: total };
		const body: string[] = [];
		if (bh === undefined) {
			for (const lines of rowLines) body.push(...lines);
		} else {
			// Line-based window: start at the row containing line scrollTop
			// (skipping its already-scrolled-past lines) and stop once the
			// window is full or the rows run out.
			let i = 0;
			while (i < rowLines.length && rowLineStart[i]! + rowLines[i]!.length <= scrollTop) i += 1;
			for (; i < rowLines.length; i += 1) {
				const start = rowLineStart[i]!;
				if (start >= scrollTop + bh) break;
				const lines = rowLines[i]!.slice(Math.max(0, scrollTop - start));
				// Scrolling is line-based, so a row may be partially visible
				// at the bottom edge (its remaining lines are on the next page).
				const fit = bh - body.length;
				if (fit <= 0) break;
				body.push(...lines.slice(0, fit));
			}
			// Pad the remainder with blank lines so the overlay blacks out the
			// chat behind it even for short lists (the home view does the same).
			const total = options.height?.();
			if (total !== undefined) {
				const target = total - 1 - footer.length;
				while (body.length < target) body.push('');
			}
		}
		return [header, ...body, ...footer];
	};
	// Initial clamp (deferred: the scroll layout needs renderRow).
	clampScroll();

	/**
	 * Composite a floating popup over the browse view. With blankBody the
	 * whole body area is cleared so the popup and its key hint stand out on
	 * a clean backdrop; otherwise the dimmed list stays visible around the
	 * popup. The popup is centered (blank body) or anchored at the cursor
	 * task's line (dimmed list), shifted up so it stays inside the body
	 * area; when it is taller than the body area it is pinned to the top
	 * and may grow past the footer (the host clips at the overlay height).
	 */
	const compositePopup = (width: number, makePopup: (maxHeight: number) => string[], blankBody: boolean): string[] => {
		dimmed = true;
		theme = dimmedTheme(options.theme);
		const lines = browseLines(width);
		dimmed = false;
		theme = options.theme;
		const bodyTop = 1;
		const bodyBottom = lines.length - 1 - footerLines(width).length;
		const areaHeight = bodyBottom - bodyTop + 1;
		const popup = makePopup(areaHeight);
		const pad = (line: string) => line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
		if (popup.length > areaHeight) {
			// The popup is taller than the body area (tiny window): pin it to
			// the top of the body and let it grow past the footer.
			const out: string[] = [lines[0]!];
			for (const line of popup) out.push(pad(line));
			out.push(...footerLines(width));
			return out;
		}
		let start: number;
		if (blankBody) {
			// Clean backdrop: clear the body area and center the popup.
			for (let i = bodyTop; i <= bodyBottom; i += 1) lines[i] = '';
			start = bodyTop + Math.floor((areaHeight - popup.length) / 2);
		} else {
			const lowest = Math.max(bodyTop, bodyBottom - popup.length + 1);
			const task = state.tasks[cursor];
			const row = task ? state.taskRowIndex.get(task.id) : undefined;
			const taskLine = row === undefined ? undefined : currentLayout().rowLineStart[row];
			start =
				taskLine === undefined
					? bodyTop + Math.floor((areaHeight - popup.length) / 2)
					: Math.max(bodyTop, Math.min(bodyTop + (taskLine - scrollTop), lowest));
		}
		popup.forEach((popupLine, i) => {
			lines[start + i] = pad(popupLine);
		});
		return lines;
	};

	const view: TodosView = {
		cursor: () => cursor,
		scrollTop: () => scrollTop,
		expandedIds: () => [...expanded],
		mode: () => modes.mode().kind,
		render(width: number): string[] {
			if (modes.mode().kind === 'browse') return browseLines(width);
			// reason / form / confirm / input / editor: the popup floats centered
			// over a cleared body so the box and its key hint stand out.
			return compositePopup(width, (maxHeight) => renderModeBody(width, modes.mode(), options.theme, maxHeight), true);
		},
		handleInput(data: string): void {
			if (modes.handleInput(data)) return;
			notice = undefined;
			if (data === 'q') {
				options.onClose();
				return;
			}
			if (data === ESCAPE) {
				(options.onBack ?? options.onClose)();
				return;
			}
			let movedCursor = false;
			if (data === 'j' || data === ARROW_DOWN) {
				const before = cursor;
				cursor = Math.min(state.tasks.length - 1, cursor + 1);
				if (cursor === before) {
					// The cursor is on the last task: scroll the window down so
					// content below it (an expanded body/log) stays reachable.
					scrollTop = Math.min(maxScroll(), scrollTop + 1);
				} else {
					movedCursor = true;
				}
			} else if (data === 'k' || data === ARROW_UP) {
				const before = cursor;
				cursor = Math.max(0, cursor - 1);
				if (cursor === before) {
					// The cursor is on the first task: scroll the window up.
					scrollTop = Math.max(0, scrollTop - 1);
				} else {
					movedCursor = true;
				}
			} else if (data === 'G') {
				cursor = Math.max(0, state.tasks.length - 1);
				scrollTop = maxScroll();
				movedCursor = true;
			} else if (data === 'g') {
				cursor = 0;
				scrollTop = 0;
				movedCursor = true;
			} else if (data === 'u') {
				// Next open task after the cursor (wraps around).
				const count = state.tasks.length;
				for (let step = 1; step <= count; step += 1) {
					const candidate = state.tasks[(cursor + step) % count];
					if (candidate && !candidate.done) {
						cursor = (cursor + step) % count;
						break;
					}
				}
				movedCursor = true;
			} else if (data === PAGE_DOWN) {
				const bh = bodyHeight();
				if (bh !== undefined) scrollTop = Math.min(maxScroll(), scrollTop + bh - 1);
			} else if (data === PAGE_UP) {
				const bh = bodyHeight();
				if (bh !== undefined) scrollTop = Math.max(0, scrollTop - (bh - 1));
			} else if (data === ' ') {
				if (!options.mutate) return;
				const task = state.tasks[cursor];
				if (!task) return;
				const number = state.numbers.get(task.id) ?? String(task.id);
				const done = !task.done;
				// Check when completing, cross when reopening (opening).
				const marker = done ? '✓' : '✗';
				modes.beginReason(
					`${marker} ${done ? 'Complete' : 'Reopen'} task ${number} — reason:`,
					(value) => {
						const reason = value.trim();
						if (!reason) {
							notice = 'a reason is required';
							options.requestRender();
							return;
						}
						void applyMutation((b) => {
							b.setDoneById(task.id, done);
							b.addLogEntry({ task: number, date: todayDate(), note: reason, kind: done ? 'done' : 'reopen' }, category);
						});
					}
				);
			} else if (data === 'o') {
				const task = state.tasks[cursor];
				if (task) {
					const expanding = !expanded.has(task.id);
					if (expanded.has(task.id)) expanded.delete(task.id);
					else expanded.add(task.id);
					// Rebuild so the detail lines appear/disappear immediately.
					state = rebuild();
					clampScroll();
					// Reveal the newly expanded content: when it extends below the
					// visible window, scroll down as far as possible while keeping
					// the task line visible (the task moves to the top of the
					// window; j then scrolls through the rest).
					if (expanding) {
						const bh = bodyHeight();
						const row = state.taskRowIndex.get(task.id);
						if (bh !== undefined && row !== undefined) {
							const current = currentLayout();
							const line = current.rowLineStart[row]!;
							// Last line of the expanded content: the line before the
							// next task row (or the end of the list).
							let end = current.totalLines - 1;
							for (let r = row + 1; r < state.rows.length; r += 1) {
								if (state.rows[r]!.kind === 'task') {
									end = current.rowLineStart[r]! - 1;
									break;
								}
							}
							if (end >= scrollTop + bh) {
								scrollTop = Math.min(maxScroll(), line);
							}
						}
					}
				}
			} else if (data === 'r' && options.reload) {
				const fresh = options.reload();
				if (fresh) {
					backlog = fresh;
					state = rebuild();
					clampCursor();
					clampScroll();
				}
			} else if (data === 'a') {
				if (!options.mutate) return;
				modes.beginForm({ title: 'New task', category: category ?? undefined });
			} else if (data === 'e') {
				if (!options.mutate) return;
				const task = state.tasks[cursor];
				if (!task) return;
				modes.beginForm({ title: `Edit ${state.numbers.get(task.id) ?? task.id} ${task.title}`, task });
			} else if (data === 'x') {
				if (!options.mutate) return;
				const task = state.tasks[cursor];
				if (!task) return;
				modes.setMode({
					kind: 'confirm',
					message: `Delete task ${state.numbers.get(task.id) ?? task.id} "${task.title}"?`,
					onYes: () => {
						void applyMutation((b) => b.deleteTaskById(task.id));
					},
					onNo: () => {}
				});
			} else if (data === 'J' || data === 'K') {
				if (!options.mutate) return;
				const task = state.tasks[cursor];
				if (!task) return;
				const number = state.numbers.get(task.id) ?? String(task.id);
				const direction: 'up' | 'down' = data === 'K' ? 'up' : 'down';
				// Dry-run on a copy: moving past the edge of the task's group is
				// refused with a notice instead of a failed save.
				try {
					Backlog.parse(backlog.render()).moveTask(number, direction, 1, category);
				} catch (error) {
					notice = error instanceof Error ? error.message : String(error);
					options.requestRender();
					return;
				}
				void (async () => {
					const ok = await applyMutation((b) => b.moveTask(number, direction, 1, category));
					if (ok) focusTaskId(task.id);
				})();
			} else if (data === 'R') {
				if (!options.mutate || category === undefined) return;
				const oldName = category;
				modes.beginInput('Rename list', oldName, (value) => {
					const name = value.trim();
					if (!name) return;
					void (async () => {
						let ok = false;
						try {
							ok = await options.mutate!(backlog, (b) => b.renameCategory(oldName, name));
						} catch {
							ok = false;
						}
						if (ok) {
							category = name;
							notice = 'saved';
							state = rebuild();
						} else {
							notice = 'not saved';
						}
						clampCursor();
						clampScroll();
						options.requestRender();
					})();
				});
			} else if (data === 's') {
				if (!options.onStartLoop) return;
				const scope = category ? `list "${category}"` : 'the whole backlog';
				modes.setMode({
					kind: 'confirm',
					message: `Start a Ralph loop on ${scope}?`,
					onYes: () => {
						options.onClose();
						void options.onStartLoop?.(category);
					},
					onNo: () => {}
				});
			} else {
				return;
			}
			// Keep the cursor visible after cursor moves, but not after page
			// keys (which intentionally scroll away from the cursor).
			if (movedCursor) keepCursorVisible();
			options.requestRender();
		},
		invalidate(): void {
			// Rows are derived on demand; reloading from disk is explicit (r).
		},
		dispose(): void {}
	};

	return view;
}
