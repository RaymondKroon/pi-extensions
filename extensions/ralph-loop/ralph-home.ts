// The Ralph home view for the pi TUI.
//
// The landing view for bare /ralph: a pinned goal row (status-colored,
// expandable with O to its criteria/evidence/checkpoint) above the list
// rows (one per category plus an (all) row), each with open/total counts.
// Enter on a list opens the task view for it (Escape there returns here).
//
// Key convention (SPEC §8): uppercase = goal ops, lowercase = list ops.
// A add/edit goal (form popup: title + body), D delete goal (confirm),
// S start the goal loop (confirm), O goal detail; R renames the
// highlighted list, enter opens it, r reloads, q quits.
//
// The popup machinery (box, form/confirm/input modes, footer layout)
// comes from view-kit.ts, shared with the todos view; this view owns the
// browse rendering, scrolling, and the goal/list mutations the popups
// trigger. Goal mutations flow through the host's mutate callback, the
// same parse → mutate → render → write discipline as the todos view.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from '@earendil-works/pi-tui';
import { Backlog, type Goal } from './backlog.ts';
import {
	ARROW_DOWN,
	ARROW_UP,
	createModeController,
	dimmedTheme,
	ESCAPE,
	ENTER_KEYS,
	layoutFooter,
	PAGE_DOWN,
	PAGE_UP,
	renderModeBody,
	type FormMode,
	type RalphViewTheme
} from './view-kit.ts';

export interface RalphHomeOptions {
	backlog: Backlog;
	/** The host TUI (used to construct the built-in Editor for body editing). */
	tui: TUI;
	/** Display name of the source (e.g. the backlog file path). */
	title: string;
	theme: RalphViewTheme;
	/**
	 * Total view height in lines (header + body + footer). When provided the
	 * body is a scroll window padded with blank lines up to the full height
	 * (so the overlay blacks out the chat behind it); when omitted every row
	 * is rendered (tests). A function so the host can track terminal resizes.
	 */
	height?: () => number;
	/** Re-render the TUI after state changes. */
	requestRender: () => void;
	/** Close the view (called on q / Escape). */
	onClose: () => void;
	/** Reload the backlog from disk (r key); return undefined to keep current data. */
	reload?: () => Backlog | undefined;
	/**
	 * Persist a backlog mutation: run fn on the view's current backlog
	 * instance and write the result to disk. Return false when the change was
	 * not saved (the view keeps showing the previous data).
	 */
	mutate?: (backlog: Backlog, fn: (b: Backlog) => void) => Promise<boolean> | boolean;
	/** Open the task view for a list (undefined = the whole backlog). */
	onOpenList: (category?: string) => void;
	/** Start the goal loop (S key, after confirmation). */
	onStartGoalLoop?: () => void | Promise<void>;
}

export interface RalphHome {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
	/** Index of the highlighted row (test hook). */
	cursor(): number;
	/** Whether the goal row is expanded (test hook). */
	expanded(): boolean;
	/** Current input mode: browse | input | reason | form | confirm | editor (test hook). */
	mode(): string;
}

/** A selectable row of the home view (the goal row and the list rows). */
interface SelectableRow {
	kind: 'goal' | 'list';
	/** List name; undefined for the (all) row. */
	category?: string;
}

/** A line inside the expanded goal row (criteria, evidence, checkpoint). */
interface DetailRow {
	kind: 'goal-detail';
	flavor: 'criteria' | 'evidence' | 'checkpoint';
	text: string;
}

type Row = SelectableRow | DetailRow;

/** The goal's status marker and coloring (only dim/accent/bold exist). */
const goalStatusStyle = (status: Goal['status']): { marker: string; color: 'accent' | 'dim' | 'bold' } => {
	if (status === 'open') return { marker: '●', color: 'accent' };
	if (status === 'claimed') return { marker: '◐', color: 'bold' };
	return { marker: '✓', color: 'dim' };
};

/**
 * Create the home view component. Rows are derived from the backlog on
 * creation and on reload; the cursor indexes the selectable rows (goal +
 * lists) only.
 */
export function createRalphHome(options: RalphHomeOptions): RalphHome {
	let backlog = options.backlog;
	let cursor = 0;
	let scrollTop = 0;
	let expanded = false;
	// Transient feedback for the last mutation, cleared on the next key.
	let notice: string | undefined;
	// The host theme, swapped for a dimmed variant while a popup is open so
	// the rows behind it recede.
	let theme = options.theme;
	let dimmed = false;

	// Scroll layout of the current rows: the start line of every row plus the
	// total line count. Word wrapping makes the layout width-dependent, so it
	// is derived at render time and cached; handleInput recomputes it at the
	// last rendered width when the rows changed since the last render.
	let lastWidth: number | undefined;
	let layout: { rowLineStart: number[]; totalLines: number } | undefined;

	const rebuild = (): { rows: Row[]; selectable: SelectableRow[]; rowLineOf: Map<SelectableRow, number> } => {
		layout = undefined; // rows changed: the width-dependent layout is stale
		const rows: Row[] = [];
		const selectable: SelectableRow[] = [];
		const rowLineOf = new Map<SelectableRow, number>();
		const goal = backlog.goal();
		if (goal) {
			const goalRow: SelectableRow = { kind: 'goal' };
			selectable.push(goalRow);
			rowLineOf.set(goalRow, rows.length);
			rows.push(goalRow);
			if (expanded) {
				if (goal.body) {
					rows.push({ kind: 'goal-detail', flavor: 'criteria', text: goal.body });
				}
				if (goal.evidence !== null) {
					rows.push({ kind: 'goal-detail', flavor: 'evidence', text: goal.evidence });
				}
				if (goal.checkpoint !== null) {
					rows.push({
						kind: 'goal-detail',
						flavor: 'checkpoint',
						text: `checkpoint (iteration ${goal.checkpointIteration ?? '?'}): ${goal.checkpoint}`
					});
				}
			}
		}
		const allRow: SelectableRow = { kind: 'list' };
		selectable.push(allRow);
		rowLineOf.set(allRow, rows.length);
		rows.push(allRow);
		for (const name of backlog.categories()) {
			const listRow: SelectableRow = { kind: 'list', category: name };
			selectable.push(listRow);
			rowLineOf.set(listRow, rows.length);
			rows.push(listRow);
		}
		return { rows, selectable, rowLineOf };
	};

	let state = rebuild();
	const clampCursor = () => {
		cursor = Math.max(0, Math.min(cursor, Math.max(0, state.selectable.length - 1)));
	};
	clampCursor();

	// --- scrolling -------------------------------------------------------------

	const bodyHeight = (): number | undefined => {
		const total = options.height?.();
		if (total === undefined) return undefined;
		return Math.max(1, total - 3); // header + two footer lines
	};

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
		const row = state.selectable[cursor];
		const rowIndex = row === undefined ? undefined : state.rowLineOf.get(row);
		const line = rowIndex === undefined ? undefined : currentLayout().rowLineStart[rowIndex];
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

	/** Save the goal form: apply the fields to the backlog, staying open on failure. */
	const saveGoalForm = (form: FormMode) => {
		const values = {
			title: form.fields[0]!.input.getValue().trim(),
			body: form.body.join('\n')
		};
		if (!values.title) {
			notice = 'a goal title is required';
			options.requestRender();
			return;
		}
		void (async () => {
			let ok = false;
			try {
				ok = await options.mutate!(backlog, (b) => b.setGoal({ title: values.title, body: values.body }));
			} catch {
				ok = false;
			}
			if (ok) {
				modes.setMode({ kind: 'browse' });
				notice = 'saved';
				state = rebuild();
			} else {
				notice = 'not saved';
			}
			clampCursor();
			clampScroll();
			options.requestRender();
		})();
	};

	// The popup modes (input, form, confirm) are owned by the shared view kit;
	// the view persists goal form saves through saveGoalForm.
	const modes = createModeController({
		tui: options.tui,
		theme: options.theme,
		requestRender: options.requestRender,
		onSaveForm: saveGoalForm
	});

	// --- rendering -------------------------------------------------------------

	const headerLine = (width: number): string => {
		const counts = backlog.counts();
		const title = theme.bold(`Ralph home — ${options.title}`);
		const summary = theme.fg('dim', `${counts.open} of ${counts.total} open (${counts.completed} done)`);
		const noticePart = notice ? `  ${theme.fg('accent', notice)}` : '';
		return truncateToWidth(`${title}  ${summary}${noticePart}`, width, '…');
	};

	const footerSegments = (): string[] => {
		const segments = ['jk: move', 'enter: open list'];
		const hasGoal = backlog.goal() !== undefined;
		if (hasGoal) segments.push('O: goal detail');
		if (options.mutate) {
			segments.push('A: add/edit goal');
			if (hasGoal) segments.push('D: delete goal');
			segments.push('R: rename list');
		}
		if (hasGoal && options.onStartGoalLoop) segments.push('S: start goal loop');
		segments.push('r: reload', 'q: quit');
		return segments;
	};

	const footerLines = (width: number): string[] =>
		layoutFooter(footerSegments(), width, (text) => theme.fg('dim', text));

	const renderGoalRow = (highlighted: boolean, width: number): string[] => {
		const goal = backlog.goal()!;
		const { marker, color } = goalStatusStyle(goal.status);
		const cursorMark = highlighted ? '> ' : '  ';
		const prefix = `  ${cursorMark}${marker} `;
		const prefixText = dimmed ? theme.fg('dim', prefix) : prefix;
		const statusText =
			color === 'bold'
				? theme.bold(` (${goal.status})`)
				: theme.fg(dimmed ? 'dim' : color, ` (${goal.status})`);
		// Word-wrap the title instead of truncating it; continuation lines
		// align under the title start. The status suffix stays on the first
		// line, so the wrap budget leaves room for it.
		const titleIndent = ' '.repeat(visibleWidth(prefixText));
		const titleText = dimmed ? theme.fg('dim', `Goal: ${goal.title}`) : `Goal: ${goal.title}`;
		const lines = wrapTextWithAnsi(
			titleText,
			Math.max(1, width - titleIndent.length - visibleWidth(statusText))
		).map((line, index) => (index === 0 ? prefixText + line : titleIndent + line));
		lines[0] = lines[0]! + statusText;
		return lines;
	};

	const renderListRow = (row: SelectableRow, highlighted: boolean, width: number): string[] => {
		const counts = backlog.counts(row.category);
		const name = row.category ?? '(all)';
		const label = `${name} — ${counts.open} open / ${counts.total} total`;
		const text = highlighted ? `> ${label}` : theme.fg('dim', `  ${label}`);
		return [truncateToWidth(text, width, '…')];
	};

	const renderRow = (row: Row, width: number): string[] => {
		switch (row.kind) {
			case 'goal-detail': {
				// Word-wrap long lines; the label only the first line carries,
				// continuation lines align under the text start.
				const label =
					row.flavor === 'criteria'
						? 'criteria: '
						: row.flavor === 'evidence'
							? 'evidence: '
							: '';
				const indent = `      ${label}`;
				const continuation = ' '.repeat(visibleWidth(indent));
				const out: string[] = [];
				let first = true;
				for (const line of row.text.split('\n')) {
					wrapTextWithAnsi(line, Math.max(1, width - visibleWidth(indent))).forEach((wrapped, i) => {
						out.push(theme.fg('dim', (first && i === 0 ? indent : continuation) + wrapped));
					});
					first = false;
				}
				return out;
			}
			case 'goal':
				return renderGoalRow(row === state.selectable[cursor], width);
			case 'list':
				return renderListRow(row, row === state.selectable[cursor], width);
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
				const fit = bh - body.length;
				if (fit <= 0) break;
				body.push(...lines.slice(0, fit));
			}
			// Pad the remainder with blank lines so the overlay blacks out the
			// chat behind it even for short lists.
			const totalHeight = options.height?.();
			if (totalHeight !== undefined) {
				const target = totalHeight - 1 - footer.length;
				while (body.length < target) body.push('');
			}
		}
		return [header, ...body, ...footer];
	};
	// Initial clamp (deferred: the scroll layout needs renderRow).
	clampScroll();

	/**
	 * Composite a floating popup over the browse view: the body area is
	 * cleared and the popup centered so the box and its key hint stand out
	 * on a clean backdrop (the same layout as the todos view's popups).
	 */
	const compositePopup = (width: number, makePopup: (maxHeight: number) => string[]): string[] => {
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
		for (let i = bodyTop; i <= bodyBottom; i += 1) lines[i] = '';
		const start = bodyTop + Math.floor((areaHeight - popup.length) / 2);
		popup.forEach((popupLine, i) => {
			lines[start + i] = pad(popupLine);
		});
		return lines;
	};

	const view: RalphHome = {
		cursor: () => cursor,
		expanded: () => expanded,
		mode: () => modes.mode().kind,
		render(width: number): string[] {
			if (modes.mode().kind === 'browse') return browseLines(width);
			return compositePopup(width, (maxHeight) => renderModeBody(width, modes.mode(), options.theme, maxHeight));
		},
		handleInput(data: string): void {
			if (modes.handleInput(data)) return;
			notice = undefined;
			if (data === 'q' || data === ESCAPE) {
				options.onClose();
				return;
			}
			let movedCursor = false;
			if (data === 'j' || data === ARROW_DOWN) {
				const before = cursor;
				cursor = Math.min(state.selectable.length - 1, cursor + 1);
				if (cursor === before) {
					// The cursor is on the last row: scroll the window down so
					// content below it (an expanded goal) stays reachable.
					scrollTop = Math.min(maxScroll(), scrollTop + 1);
				} else {
					movedCursor = true;
				}
			} else if (data === 'k' || data === ARROW_UP) {
				const before = cursor;
				cursor = Math.max(0, cursor - 1);
				if (cursor === before) {
					// The cursor is on the first row: scroll the window up.
					scrollTop = Math.max(0, scrollTop - 1);
				} else {
					movedCursor = true;
				}
			} else if (data === 'G') {
				cursor = Math.max(0, state.selectable.length - 1);
				scrollTop = maxScroll();
				movedCursor = true;
			} else if (data === 'g') {
				cursor = 0;
				scrollTop = 0;
				movedCursor = true;
			} else if (data === PAGE_DOWN) {
				const bh = bodyHeight();
				if (bh !== undefined) scrollTop = Math.min(maxScroll(), scrollTop + bh - 1);
			} else if (data === PAGE_UP) {
				const bh = bodyHeight();
				if (bh !== undefined) scrollTop = Math.max(0, scrollTop - (bh - 1));
			} else if (data === 'O') {
				if (!backlog.goal()) return;
				expanded = !expanded;
				state = rebuild();
				clampCursor();
				clampScroll();
				// Reveal the newly expanded content: when it extends below the
				// visible window, scroll down as far as possible while keeping
				// the goal row visible.
				if (expanded) {
					const bh = bodyHeight();
					const goalRow = state.selectable.find((row) => row.kind === 'goal');
					const goalRowIndex = goalRow === undefined ? undefined : state.rowLineOf.get(goalRow);
					const line = goalRowIndex === undefined ? undefined : currentLayout().rowLineStart[goalRowIndex];
					if (bh !== undefined && line !== undefined && currentLayout().totalLines - 1 >= scrollTop + bh) {
						scrollTop = Math.min(maxScroll(), line);
					}
				}
			} else if (ENTER_KEYS.includes(data)) {
				const row = state.selectable[cursor];
				if (!row) return;
				if (row.kind === 'goal') {
					expanded = !expanded;
					state = rebuild();
					clampScroll();
				} else {
					options.onOpenList(row.category);
					return;
				}
			} else if (data === 'R') {
				if (!options.mutate) return;
				const row = state.selectable[cursor];
				if (!row || row.kind !== 'list' || row.category === undefined) return;
				const oldName = row.category;
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
			} else if (data === 'A') {
				if (!options.mutate) return;
				const goal = backlog.goal();
				if (goal) {
					modes.beginForm({
						title: 'Edit goal',
						task: { title: goal.title, body: goal.body ?? '' }
					});
				} else {
					modes.beginForm({ title: 'New goal' });
				}
			} else if (data === 'D') {
				if (!options.mutate) return;
				const goal = backlog.goal();
				if (!goal) return;
				modes.setMode({
					kind: 'confirm',
					message: `Delete the goal "${goal.title}"?`,
					onYes: () => {
						void applyMutation((b) => b.deleteGoal());
					},
					onNo: () => {}
				});
			} else if (data === 'S') {
				if (!options.onStartGoalLoop) return;
				if (!backlog.goal()) return;
				modes.setMode({
					kind: 'confirm',
					message: 'Start the Ralph goal loop?',
					onYes: () => {
						options.onClose();
						void options.onStartGoalLoop?.();
					},
					onNo: () => {}
				});
			} else if (data === 'r' && options.reload) {
				const fresh = options.reload();
				if (fresh) {
					backlog = fresh;
					state = rebuild();
					clampCursor();
					clampScroll();
				}
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
