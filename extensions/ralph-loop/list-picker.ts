// Interactive list (category) picker for the pi TUI.
//
// Rendered through ExtensionUIContext.custom() as a small component that
// lists the backlog's categories with their open/total counts. It follows
// the todos view's conventions: a highlighted cursor, footer key hints, and
// inline text entry — R turns the highlighted row into an input prefilled
// with the list name (enter saves, esc cancels).

import { Input, truncateToWidth } from '@earendil-works/pi-tui';
import { layoutFooter, type TodosViewTheme } from './todos-view.ts';

export interface ListPickerEntry {
	name: string;
	open: number;
	total: number;
}

export interface ListPickerOptions {
	/** Display name of the source (e.g. the backlog file path). */
	title: string;
	lists: ListPickerEntry[];
	theme: TodosViewTheme;
	/**
	 * Total height in lines. The list is pinned to the top, the key hints sit
	 * on the bottom line, and the lines in between are blank, blacking out the
	 * chat behind the overlay (the same layout as the todos view). When omitted
	 * every content line is rendered (tests).
	 * A function so the host can track terminal resizes.
	 */
	height?: () => number;
	/** Re-render the TUI after state changes. */
	requestRender: () => void;
	/** Open the highlighted list (enter). */
	onOpen: (name: string) => void;
	/** Close the picker (q / Escape). */
	onClose: () => void;
	/**
	 * Rename a list. Return false when the rename was not applied (the
	 * picker keeps the old name and shows a notice).
	 */
	onRename: (oldName: string, newName: string) => Promise<boolean> | boolean;
}

export interface ListPicker {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
	/** Index of the highlighted list (test hook). */
	cursor(): number;
	/** Current mode: browse | rename (test hook). */
	mode(): string;
}

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ESCAPE = '\x1b';
const ENTER_KEYS = ['\r', '\n'];

export function createListPicker(options: ListPickerOptions): ListPicker {
	let lists = [...options.lists];
	let cursor = 0;
	// Transient feedback for the last rename, cleared on the next key.
	let notice: string | undefined;
	let renameInput: Input | undefined;

	const rowLabel = (entry: ListPickerEntry): string =>
		`${entry.name} — ${entry.open} open / ${entry.total} total`;

	return {
		cursor: () => cursor,
		mode: () => (renameInput ? 'rename' : 'browse'),
		render(width: number): string[] {
			const title = options.theme.bold(`Ralph lists — ${options.title}`);
			const noticePart = notice ? `  ${options.theme.fg('accent', notice)}` : '';
			const content = [truncateToWidth(`${title}${noticePart}`, width, '…'), ''];
			lists.forEach((entry, index) => {
				const highlighted = index === cursor;
				if (highlighted && renameInput) {
					// Inline rename: the highlighted row becomes the input.
					content.push(
						...renameInput
							.render(width)
							.map((line, i) => truncateToWidth(i === 0 ? `> ${line}` : `  ${line}`, width, '…'))
					);
				} else {
					const text = highlighted
						? `> ${rowLabel(entry)}`
						: options.theme.fg('dim', `  ${rowLabel(entry)}`);
					content.push(truncateToWidth(text, width, '…'));
				}
			});
			// Same layout as the todos view: the key hints sit on the bottom
			// line and the lines in between are blank, blacking out the chat
			// behind the overlay.
			const hints = renameInput
				? ['enter: save', 'esc: cancel']
				: ['jk: move', 'enter: open', 'R: rename', 'q: quit'];
			const footer = layoutFooter(hints, width, (text) => options.theme.fg('dim', text));
			const total = options.height?.();
			if (total === undefined) return [...content, ...footer];
			const lines = [...content];
			while (lines.length < total - footer.length) lines.push('');
			return [...lines, ...footer].slice(0, total);
		},
		handleInput(data: string): void {
			if (renameInput) {
				if (data === ESCAPE) {
					renameInput = undefined;
					options.requestRender();
					return;
				}
				if (ENTER_KEYS.includes(data)) {
					const input = renameInput;
					const oldName = lists[cursor]!.name;
					const name = input.getValue().trim();
					renameInput = undefined;
					if (name && name !== oldName) {
						void Promise.resolve(options.onRename(oldName, name)).then((ok) => {
							if (ok) {
								lists[cursor] = { ...lists[cursor]!, name };
								notice = 'saved';
							} else {
								notice = 'not saved';
							}
							options.requestRender();
						});
					} else {
						options.requestRender();
					}
					return;
				}
				renameInput.handleInput(data);
				options.requestRender();
				return;
			}
			notice = undefined;
			if (data === 'q' || data === ESCAPE) {
				options.onClose();
				return;
			}
			let moved = false;
			if (data === 'j' || data === ARROW_DOWN) {
				cursor = Math.min(lists.length - 1, cursor + 1);
				moved = true;
			} else if (data === 'k' || data === ARROW_UP) {
				cursor = Math.max(0, cursor - 1);
				moved = true;
			} else if (ENTER_KEYS.includes(data)) {
				const entry = lists[cursor];
				if (entry) options.onOpen(entry.name);
				return;
			} else if (data === 'R') {
				const entry = lists[cursor];
				if (!entry) return;
				const input = new Input();
				// Feed the current name through Input so its edit cursor starts at the end.
				input.handleInput(entry.name);
				input.focused = true;
				renameInput = input;
			} else {
				return;
			}
			options.requestRender();
		},
		invalidate(): void {},
		dispose(): void {}
	};
}
