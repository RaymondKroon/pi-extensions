// Shared TUI view kit for the ralph-loop views.
//
// The popup machinery shared by the todos view (task list) and the home
// view: a full-width bordered popup box, the form/confirm/input/reason/
// editor modes that float in it, and the footer key-hint layout. The
// views own their browse rendering, scrolling, and mutations; the kit
// owns everything that happens while a popup is open.
//
// Every prompt (add/edit form, reason, confirm, input) shares one
// floating popup: a full-width bordered box, centered over the cleared
// body area, with its key hint attached below the box. The body editor
// floats the same way but keeps the dimmed list visible behind it. The
// form's fields are edited in place: jk/arrows or tab navigate the
// fields, enter edits the focused single-line field, enter confirms a
// field, and Ctrl+S saves (Esc cancels). The body field is edited in
// place in the same popup with the built-in multi-line Editor (word
// wrap, undo, kill ring): enter inserts a newline, Ctrl+S saves the
// body back into the form, Esc returns to the read-only preview.

import { Editor, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from '@earendil-works/pi-tui';

export const ARROW_UP = '\x1b[A';
export const ARROW_DOWN = '\x1b[B';
export const PAGE_UP = '\x1b[5~';
export const PAGE_DOWN = '\x1b[6~';
export const ESCAPE = '\x1b';
export const ENTER_KEYS = ['\r', '\n'];

/** The subset of the pi theme the views need (fg/bold are stable API). */
export interface RalphViewTheme {
	fg: (color: 'dim' | 'accent', text: string) => string;
	bold: (text: string) => string;
}

/** A dimmed variant of a theme, for the list behind an open popup. */
export const dimmedTheme = (theme: RalphViewTheme): RalphViewTheme => ({
	fg: (_color, text) => theme.fg('dim', text),
	bold: (text) => theme.fg('dim', text)
});

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

// --- popup modes -------------------------------------------------------------

/** Single-line text entry (list rename). */
export interface InputMode {
	kind: 'input';
	label: string;
	input: Input;
	onValue: (value: string) => void;
}

/** A single-line reason prompt (done/reopen), shown as a bordered popup. */
export interface ReasonMode {
	kind: 'reason';
	label: string;
	input: Input;
	onValue: (value: string) => void;
}

/** A single-line form field backed by an Input component. */
export interface FormField {
	label: string;
	input: Input;
}

/**
 * The add/edit form, shown as a bordered popup dialog. It opens in a
 * read-only state; enter starts editing. The single-line fields are
 * edited in place and body is a multi-line buffer. focus indexes the
 * fields in the order [fields…, Body]. The task's list (category) is
 * fixed and never editable.
 */
export interface FormMode {
	kind: 'form';
	title: string;
	fields: FormField[];
	body: string[];
	focus: number;
	/** True while the focused single-line field is being edited. */
	editing: boolean;
	/** Set when editing an existing task. */
	taskId?: number;
	/** Fixed list the new task is added to (never editable in the form). */
	category?: string;
}

/** A yes/no confirmation (delete, start loop). */
export interface ConfirmMode {
	kind: 'confirm';
	message: string;
	onYes: () => void;
	onNo: () => void;
}

/** Body editing inside the form popup with the built-in Editor component. */
export interface EditorMode {
	kind: 'editor';
	/** The form to return to when the body is saved or cancelled. */
	form: FormMode;
	editor: Editor;
}

export type Mode = { kind: 'browse' } | InputMode | ReasonMode | FormMode | ConfirmMode | EditorMode;

// --- popup box -----------------------------------------------------------------

/** Content width of a popup box: as wide as the list. */
export const popupInnerWidth = (width: number): number => Math.max(20, width - 6);

/**
 * The shared popup box: bordered, left-aligned with the list entries
 * (2-space indent), with the key hint attached below the bottom border.
 * Every floating mode (reason, form, confirm, input) renders through this.
 */
export function popupBox(width: number, title: string, content: string[], hint: string, theme: RalphViewTheme): string[] {
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
		borderLine(theme.fg('dim', hint))
	];
}

/** The focused Input's line, without its "> " prompt, sized for the box. */
export const inputPromptLine = (input: Input, width: number): string =>
	(input.render(Math.max(1, popupInnerWidth(width) - 2))[0] ?? '').slice(2);

/**
 * The popup content for the given mode: every mode returns a popupBox
 * (the editor mode embeds the body editor in the form box). maxHeight
 * windows the form's body preview so the box fits the body area.
 */
export function renderModeBody(width: number, mode: Mode, theme: RalphViewTheme, maxHeight?: number): string[] {
	if (mode.kind === 'input') {
		return popupBox(width, theme.bold(mode.label), [inputPromptLine(mode.input, width)], 'enter: save · esc: cancel', theme);
	}
	if (mode.kind === 'reason') {
		return popupBox(width, theme.bold(mode.label), [inputPromptLine(mode.input, width)], 'enter: save · esc: cancel', theme);
	}
	if (mode.kind === 'form') {
		const form = mode;
		const labelWidth = 10;
		const innerWidth = popupInnerWidth(width);
		const content: string[] = [];
		form.fields.forEach((field, index) => {
			const focused = form.focus === index;
			const editingField = focused && form.editing;
			const label = focused ? theme.bold(`${field.label}:`) : theme.fg('dim', `${field.label}:`);
			const value = editingField
				? (field.input.render(Math.max(1, innerWidth - 2 - labelWidth))[0] ?? '').slice(2) // drop Input's "> " prompt
				: field.input.getValue();
			content.push(label.padEnd(labelWidth) + value);
		});
		const bodyIndex = form.fields.length;
		const bodyFocused = form.focus === bodyIndex;
		const bodyLabel = bodyFocused ? theme.bold('Body:') : theme.fg('dim', 'Body:');
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
				content.push(bodyFocused ? bodyLine : theme.fg('dim', bodyLine));
				used += 1;
			}
			if (budget !== undefined && used >= budget) break;
		}
		const hint = !form.editing
			? form.focus === form.fields.length
				? 'enter: edit body · tab/↑↓: field · ctrl+s: save · esc: cancel'
				: 'jk/↑↓: field · enter: edit · ctrl+s: save · esc: cancel'
			: 'enter: confirm · tab/↑↓: field · ctrl+s: save · esc: cancel';
		return popupBox(width, theme.bold(form.title), content, hint, theme);
	}
	if (mode.kind === 'confirm') {
		return popupBox(width, theme.bold('Confirm'), [mode.message], 'y: yes · n/esc: no', theme);
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
		content.push(theme.fg('dim', 'Title:').padEnd(labelWidth) + titleField.input.getValue());
		content.push(theme.fg('dim', 'Body:').padEnd(labelWidth));
		const bodyIndent = '   ';
		const editorLines = mode.editor
			.render(Math.max(1, innerWidth - 2 - bodyIndent.length))
			.map((line) => bodyIndent + line);
		content.push(...editorLines);
		return popupBox(width, theme.bold(form.title), content, 'enter: newline · ctrl+s: save body · esc: back to form', theme);
	}
	return [];
}

// --- mode controller -------------------------------------------------------------

/** The task a form is prefilled from (edit mode). */
export interface FormInit {
	title: string;
	/** Existing task to prefill from (edit mode). */
	task?: { id?: number; title?: string; body?: string | null };
	/** Fixed list the new task is added to (never editable in the form). */
	category?: string;
}

export interface ModeControllerOptions {
	/** The host TUI (used to construct the built-in Editor for body editing). */
	tui: TUI;
	theme: RalphViewTheme;
	/** Re-render the TUI after state changes. */
	requestRender: () => void;
	/** Save the form (Ctrl+S). The view persists and updates its own state. */
	onSaveForm: (form: FormMode) => void;
}

export interface ModeController {
	/** Current mode (browse while no popup is open). */
	mode(): Mode;
	/** Switch the mode, re-rendering (the view opens confirm popups this way). */
	setMode(mode: Mode): void;
	/** Open a single-line text entry popup, prefilled with initial. */
	beginInput(label: string, initial: string, onValue: (value: string) => void): void;
	/** Open the bordered reason popup with an empty single-line input. */
	beginReason(label: string, onValue: (value: string) => void): void;
	/** Open the add/edit form, prefilled from the task (edit) or ambient scope (add). */
	beginForm(init: FormInit): void;
	/** Handle input for the open popup; false while in browse mode. */
	handleInput(data: string): boolean;
}

/**
 * Own the popup modes of a view: the current mode, the input handling of
 * every mode, and the helpers to open them. The view renders the open
 * mode through renderModeBody and persists form saves through
 * onSaveForm.
 */
export function createModeController(options: ModeControllerOptions): ModeController {
	let mode: Mode = { kind: 'browse' };
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

	const makeFormField = (label: string, initial: string): FormField => {
		const input = new Input();
		if (initial !== '') input.handleInput(initial);
		input.focused = true;
		return { label, input };
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

	const beginReason = (label: string, onValue: (value: string) => void) => {
		const input = new Input();
		// The view (not the Input) holds TUI focus; keep the edit cursor visible.
		input.focused = true;
		mode = { kind: 'reason', label, input, onValue };
		options.requestRender();
	};

	const beginForm = (init: FormInit) => {
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
				options.onSaveForm(form);
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
			// the read-only state, so only single-line fields reach the editing
			// state).
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

	return {
		mode: () => mode,
		setMode: (next) => {
			mode = next;
			options.requestRender();
		},
		beginInput,
		beginReason,
		beginForm,
		handleInput: (data: string): boolean => {
			if (mode.kind === 'browse') return false;
			handleModeInput(data);
			return true;
		}
	};
}
