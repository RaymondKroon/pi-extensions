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
// The add/edit form's fields (title, done, body) are edited in
// place: jk/arrows or tab navigate the fields, enter edits the focused
// field (it toggles Done), enter confirms a field, and Ctrl+S saves (Esc
// cancels). The body field is edited in place in the same popup with the
// built-in multi-line Editor (word wrap, undo, kill ring): enter inserts a
// newline, Ctrl+S saves the body back into the form, Esc returns to the
// read-only preview. Title entry is inline — the host's dialog components
// would replace the container that hosts this view.

import { Editor, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from '@earendil-works/pi-tui';
import { Backlog, type Task } from './backlog.ts';

/** The subset of the pi theme the view needs (fg/bold are stable API). */
export interface TodosViewTheme {
	fg: (color: 'dim' | 'accent', text: string) => string;
	bold: (text: string) => string;
}

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

/** Single-line text entry (list rename). */
interface InputMode {
	kind: 'input';
	label: string;
	input: Input;
	onValue: (value: string) => void;
}

/** A single-line reason prompt (done/reopen), shown as a bordered popup. */
interface ReasonMode {
	kind: 'reason';
	label: string;
	input: Input;
	onValue: (value: string) => void;
}

/** A single-line form field backed by an Input component. */
interface FormField {
	label: string;
	input: Input;
}

/**
 * The add/edit task form, shown as a bordered popup dialog. It opens in a
 * read-only state; enter starts editing. title is a single-line field and
 * body a multi-line buffer. focus indexes the fields in the order
 * [Title, Body]. Done is not edited here: space toggles it (with a reason).
 * The task's list (category) is fixed and never editable.
 */
interface FormMode {
	kind: 'form';
	title: string;
	fields: FormField[];
	body: string[];
	focus: number;
	/** True while the focused single-line field (title) is being edited. */
	editing: boolean;
	/** Set when editing an existing task. */
	taskId?: number;
	/** Fixed list the new task is added to (never editable in the form). */
	category?: string;
}

/** A yes/no confirmation (delete, start loop). */
interface ConfirmMode {
	kind: 'confirm';
	message: string;
	onYes: () => void;
	onNo: () => void;
}

/** Body editing inside the form popup with the built-in Editor component. */
interface EditorMode {
	kind: 'editor';
	/** The form to return to when the body is saved or cancelled. */
	form: FormMode;
	editor: Editor;
}

type Mode = { kind: 'browse' } | InputMode | ReasonMode | FormMode | ConfirmMode | EditorMode;

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
	 * the overlay blacks out the chat behind it, like the list picker); when
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

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const ESCAPE = '\x1b';
const ENTER_KEYS = ['\r', '\n'];


/** Today's date as YYYY-MM-DD (local time), for completion log entries. */
const todayDate = (): string => {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}
/**
 * Lay out footer key-hint segments: one line when they fit, otherwise split
 * as evenly as possible onto two lines so neither line overflows.
 */
export function layoutFooter(segments: string[], width: number, dim: (text: string) => string): string[] {
	const joined = segments.join(' · ');
	if (visibleWidth(joined) <= width) return [dim(joined)];
	const first: string[] = [];
	const second: string[] = [];
	const half = Math.floor(visibleWidth(joined) / 2);
	for (const segment of segments) {
		if (first.length === 0 || visibleWidth([...first, segment].join(' · ')) <= half) first.push(segment);
		else second.push(segment);
	}
	return [
		truncateToWidth(dim(first.join(' · ')), width),
		truncateToWidth(dim(second.join(' · ')), width)
	];
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
	let mode: Mode = { kind: 'browse' };
	// The host theme, swapped for a dimmed variant while the reason popup is
	// open so the list behind it recedes.
	let theme = options.theme;
	// True while the reason popup is open: every list line is dimmed, not
	// just the segments the theme colors.
	let dimmed = false;
	const dimTheme: TodosViewTheme = {
		fg: (_color, text) => options.theme.fg('dim', text),
		bold: (text) => options.theme.fg('dim', text)
	};
	// Theme for the built-in Editor used by the body editor. Autocomplete is
	// never enabled, so the select-list functions are never called.
	const editorTheme = {
		borderColor: (text: string) => options.theme.fg('dim', text),
		selectList: {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text
		}
	};
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

	const beginInput = (label: string, initial: string, onValue: (value: string) => void) => {
		const input = new Input();
		// Feed the initial value through Input so its edit cursor starts at the end.
		if (initial !== '') input.handleInput(initial);
		// The view (not the Input) holds TUI focus; keep the edit cursor visible.
		input.focused = true;
		mode = { kind: 'input', label, input, onValue };
		options.requestRender();
	};

	/** Open the bordered reason popup (done/reopen) with an empty single-line input. */
	const beginReason = (label: string, onValue: (value: string) => void) => {
		const input = new Input();
		// The view (not the Input) holds TUI focus; keep the edit cursor visible.
		input.focused = true;
		mode = { kind: 'reason', label, input, onValue };
		options.requestRender();
	};

	const makeFormField = (label: string, initial: string): FormField => {
		const input = new Input();
		if (initial !== '') input.handleInput(initial);
		input.focused = true;
		return { label, input };
	};

	/** Open the add/edit form, prefilled from the task (edit) or ambient scope (add). */
	const beginForm = (init: { title: string; task?: Task; category?: string }) => {
		const task = init.task;
		mode = {
			kind: 'form',
			title: init.title,
			fields: [makeFormField('Title', task?.title ?? '')],
			body: (task?.body ?? '').split('\n'),
			focus: 0,
			editing: false,
			taskId: task?.id,
			category: init.category
		};
		options.requestRender();
	};

	/** Open the body editor (built-in Editor) for the form's body. */
	const openBodyEditor = (form: FormMode) => {
		const editor = new Editor(options.tui, editorTheme);
		editor.disableSubmit = true; // enter inserts a newline; ctrl+s saves
		editor.focused = true; // emit the hardware-cursor marker for IME
		editor.setText(form.body.join('\n'));
		mode = { kind: 'editor', form, editor };
		options.requestRender();
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
						newId = b
							.addTask(
								{
									title: values.title,
									body: values.body === '' ? undefined : values.body,
									category: form.category
								},
								category
							)
							.id;
					}
				});
			} catch {
				ok = false;
			}
			if (ok) {
				mode = { kind: 'browse' };
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

	// --- popups ------------------------------------------------------------------

	/** Content width of a popup box: as wide as the list. */
	const popupInnerWidth = (width: number): number => Math.max(20, width - 6);

	/**
	 * The shared popup box: bordered, left-aligned with the list entries
	 * (2-space indent), with the key hint attached below the bottom border.
	 * Every floating mode (reason, form, confirm, input) renders through this.
	 */
	const popupBox = (width: number, title: string, content: string[], hint: string): string[] => {
		const innerWidth = popupInnerWidth(width);
		const padTo = (text: string, w: number): string => {
			const vw = visibleWidth(text);
			return vw >= w ? truncateToWidth(text, w, '…') : text + ' '.repeat(w - vw);
		};
		const borderLine = (fill: string): string => '  ' + fill;
		const contentLine = (text: string): string =>
			borderLine('│ ' + padTo(text, innerWidth - 2) + ' │');
		// The title sits in the top border; the rest of the line stays a
		// solid border line (at least one cell before the corner).
		const titlePart = truncateToWidth(` ${title}`, innerWidth - 1, '…');
		return [
			borderLine('┌' + titlePart + '─'.repeat(innerWidth - visibleWidth(titlePart)) + '┐'),
			...content.map(contentLine),
			borderLine('└' + '─'.repeat(innerWidth) + '┘'),
			// Key hint attached to the popup, not in the view footer.
			borderLine(options.theme.fg('dim', hint))
		];
	};

	/** The focused Input's line, without its "> " prompt, sized for the box. */
	const inputPromptLine = (input: Input, width: number): string =>
		(input.render(Math.max(1, popupInnerWidth(width) - 2))[0] ?? '').slice(2);

	/**
	 * The popup content for the current mode: every mode returns a popupBox
	 * (the editor mode embeds the body editor in the form box). maxHeight
	 * windows the form's body preview so the box fits the body area.
	 */
	const modeBodyLines = (width: number, maxHeight?: number): string[] => {
		if (mode.kind === 'input') {
			return popupBox(width, options.theme.bold(mode.label), [inputPromptLine(mode.input, width)], 'enter: save · esc: cancel');
		}
		if (mode.kind === 'reason') {
			return popupBox(width, options.theme.bold(mode.label), [inputPromptLine(mode.input, width)], 'enter: save · esc: cancel');
		}
		if (mode.kind === 'form') {
			const form = mode;
			const labelWidth = 10;
			const innerWidth = popupInnerWidth(width);
			const content: string[] = [];
			form.fields.forEach((field, index) => {
				const focused = form.focus === index;
				const editingField = focused && form.editing;
				const label = focused ? options.theme.bold(`${field.label}:`) : options.theme.fg('dim', `${field.label}:`);
				const value = editingField
					? (field.input.render(Math.max(1, innerWidth - 2 - labelWidth))[0] ?? '').slice(2) // drop Input's "> " prompt
					: field.input.getValue();
				content.push(label.padEnd(labelWidth) + value);
			});
			const bodyIndex = form.fields.length;
			const bodyFocused = form.focus === bodyIndex;
			const bodyLabel = bodyFocused ? options.theme.bold('Body:') : options.theme.fg('dim', 'Body:');
			content.push(bodyLabel.padEnd(labelWidth));
			// Word-wrap the body preview (read-only — enter opens the
			// body editor) so long lines are readable; the box height
			// budgets the wrapped lines so the whole box (title,
			// fields, border, hint) fits the available height.
			const bodyIndent = '   ';
			const wrappedBody = form.body.map((line) =>
				wrapTextWithAnsi(line, Math.max(1, innerWidth - 2 - bodyIndent.length))
			);
			const fixedLines = form.fields.length + 3; // title, body label, bottom border
			const budget = maxHeight === undefined ? undefined : Math.max(1, maxHeight - fixedLines - 1);
			let used = 0;
			for (const wrapped of wrappedBody) {
				for (const line of wrapped) {
					if (budget !== undefined && used >= budget) break;
					const bodyLine = bodyIndent + line;
					content.push(bodyFocused ? bodyLine : options.theme.fg('dim', bodyLine));
					used += 1;
				}
				if (budget !== undefined && used >= budget) break;
			}
			const hint = !form.editing
				? form.focus === form.fields.length
					? 'enter: edit body · tab/↑↓: field · ctrl+s: save · esc: cancel'
					: 'jk/↑↓: field · enter: edit · ctrl+s: save · esc: cancel'
				: 'enter: confirm · tab/↑↓: field · ctrl+s: save · esc: cancel';
			return popupBox(width, options.theme.bold(form.title), content, hint);
		}
		if (mode.kind === 'confirm') {
			return popupBox(width, options.theme.bold('Confirm'), [mode.message], 'y: yes · n/esc: no');
		}
		if (mode.kind === 'editor') {
			// The body editor lives inside the form popup: the box stays, and
			// the editor replaces the body preview. The editor keeps its own
			// top/bottom borders (with scroll indicators) as the frame of the
			// editable region, indented like the body preview.
			const form = mode.form;
			const labelWidth = 10;
			const innerWidth = popupInnerWidth(width);
			const content: string[] = [];
			const titleField = form.fields[0]!;
			content.push(options.theme.fg('dim', 'Title:').padEnd(labelWidth) + titleField.input.getValue());
			content.push(options.theme.fg('dim', 'Body:').padEnd(labelWidth));
			const bodyIndent = '   ';
			const editorLines = mode.editor
				.render(Math.max(1, innerWidth - 2 - bodyIndent.length))
				.map((line) => bodyIndent + line);
			content.push(...editorLines);
			return popupBox(width, options.theme.bold(form.title), content, 'enter: newline · ctrl+s: save body · esc: back to form');
		}
		return [];
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
			// chat behind it even for short lists (the list picker does the same).
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
		theme = dimTheme;
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
		mode: () => mode.kind,
		render(width: number): string[] {
			if (mode.kind === 'browse') return browseLines(width);
			// reason / form / confirm / input / editor: the popup floats centered
			// over a cleared body so the box and its key hint stand out.
			return compositePopup(width, (maxHeight) => modeBodyLines(width, maxHeight), true);
		},
		handleInput(data: string): void {
			if (mode.kind !== 'browse') {
				handleModeInput(data);
				return;
			}
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
				beginReason(
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
				beginForm({ title: 'New task', category: category ?? undefined });
			} else if (data === 'e') {
				if (!options.mutate) return;
				const task = state.tasks[cursor];
				if (!task) return;
				beginForm({ title: `Edit ${state.numbers.get(task.id) ?? task.id} ${task.title}`, task });
			} else if (data === 'x') {
				if (!options.mutate) return;
				const task = state.tasks[cursor];
				if (!task) return;
				mode = {
					kind: 'confirm',
					message: `Delete task ${state.numbers.get(task.id) ?? task.id} "${task.title}"?`,
					onYes: () => {
						void applyMutation((b) => b.deleteTaskById(task.id));
					},
					onNo: () => {}
				};
				options.requestRender();
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
				beginInput('Rename list', oldName, (value) => {
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
				mode = {
					kind: 'confirm',
					message: `Start a Ralph loop on ${scope}?`,
					onYes: () => {
						options.onClose();
						void options.onStartLoop?.(category);
					},
					onNo: () => {}
				};
				options.requestRender();
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

	// --- inline input modes ------------------------------------------------------

	/**
	 * Body editor input: esc returns to the form without saving, ctrl+s saves
	 * the body back into the form, enter inserts a newline (the built-in
	 * Editor treats enter as submit, which is disabled); everything else is
	 * delegated to the Editor (cursor, wrapping, undo, kill ring, paste).
	 */
	const handleEditorInput = (data: string): void => {
		if (mode.kind !== 'editor') return;
		const { form, editor } = mode;
		if (data === ESCAPE) {
			mode = form;
			options.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl('s'))) {
			// matchesKey covers legacy and Kitty-protocol encodings.
			form.body = editor.getExpandedText().split('\n');
			form.editing = false;
			mode = form;
			options.requestRender();
			return;
		}
		if (ENTER_KEYS.includes(data)) {
			editor.insertTextAtCursor('\n');
			options.requestRender();
			return;
		}
		editor.handleInput(data);
		options.requestRender();
	};

	const handleModeInput = (data: string): void => {
		if (mode.kind === 'input' || mode.kind === 'reason') {
			if (data === ESCAPE) {
				mode = { kind: 'browse' };
				options.requestRender();
				return;
			}
			if (ENTER_KEYS.includes(data)) {
				const current = mode;
				const value = current.input.getValue();
				mode = { kind: 'browse' };
				options.requestRender();
				current.onValue(value);
				return;
			}
			mode.input.handleInput(data);
			options.requestRender();
			return;
		}
		if (mode.kind === 'form') {
			const form = mode;
			if (data === ESCAPE || data === 'q') {
				mode = { kind: 'browse' };
				options.requestRender();
				return;
			}
			if (matchesKey(data, Key.ctrl('s'))) {
				saveForm(form);
				return;
			}
			const fieldCount = form.fields.length + 1; // + Body
			const onBody = form.focus === fieldCount - 1;
			// Moving between fields always confirms any in-progress field edit.
			const move = (delta: number) => {
				form.editing = false;
				form.focus = Math.max(0, Math.min(fieldCount - 1, form.focus + delta));
				form.fields.forEach((field, index) => {
					field.input.focused = form.focus === index;
				});
				options.requestRender();
			};
			if (!form.editing) {
				// Read-only: navigate the fields; enter edits the focused one
				// (opens the body editor or edits the title).
				if (data === 'j' || data === ARROW_DOWN || data === '\t') {
					move(1);
					return;
				}
				if (data === 'k' || data === ARROW_UP || data === '\x1b[Z') {
					move(-1);
					return;
				}
				if (ENTER_KEYS.includes(data)) {
					if (onBody) openBodyEditor(form);
					else form.editing = true;
					options.requestRender();
				}
				return;
			}
			// Editing the focused single-line field (Body opens the editor from
			// the read-only state, so only the title reaches the editing state).
			const field = form.fields[form.focus];
			if (!field) return;
			if (ENTER_KEYS.includes(data)) {
				form.editing = false; // confirm the field, stay on it
				options.requestRender();
				return;
			}
			if (data === '\t' || data === ARROW_DOWN) {
				move(1);
				return;
			}
			if (data === '\x1b[Z' || data === ARROW_UP) {
				move(-1);
				return;
			}
			field.input.handleInput(data);
			options.requestRender();
			return;
		}
		if (mode.kind === 'confirm') {
			const current = mode;
			if (data === 'y' || ENTER_KEYS.includes(data)) {
				mode = { kind: 'browse' };
				options.requestRender();
				current.onYes();
				return;
			}
			if (data === 'n' || data === ESCAPE) {
				mode = { kind: 'browse' };
				options.requestRender();
				current.onNo();
				return;
			}
			return;
		}
		if (mode.kind === 'editor') {
			handleEditorInput(data);
		}
	};

	return view;
}
