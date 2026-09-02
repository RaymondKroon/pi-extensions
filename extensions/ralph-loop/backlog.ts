// Ralph backlog: a SQLite-backed, text-file-persisted task store.
//
// The durable, git-friendly representation is a single line-oriented text
// file whose first non-blank line is the versioned ralph header. The file
// is parsed into an in-memory SQLite database (node:sqlite); queries and
// mutations run as SQL; the result is serialized back to the same text
// format. No .db file is ever written to disk.
//
// Text format (one record per line; multi-line fields are indented blocks
// that end at the next top-level record):
//
//   # ralph v2
//
//   M <key> "<value>"                meta record (e.g. M source "TODO.md"
//                                       tracks which files were imported)
//   T <id> <category|-> "<title>"
//   B <id>                             task; optional body block
//   D <id>                             task is done
//   C <id> <iteration>                 task context checkpoint block
//   L <id> <taskId> <date|-> <kind|->  completion log entry; note block.
//                                       kind is 'done' (default) or
//                                       'reopen' and picks the log marker.
//                                       Entries always belong to a task.
//
// Quoted strings use backslash escaping (" and \). Blank lines and lines
// starting with "#" outside blocks are ignored.
//
// The backlog is a single flat list. Tasks have no keys: each is addressed
// by its position number in the list ("1", "2", …). Grouping (e.g. by
// priority) is done with categories (lists), not sections.
//
// Versioning: the header carries the format version. v2 is parsed
// strictly. v1 files are accepted for auto-migration only: their extra T
// fields (parent id, section id, task key), S/SB section records, and key
// or "-" references in L records are dropped, old key references are
// resolved against the remembered keys, and the next render() writes the
// v2 form. Once no v1 files remain, the v1 branch can be removed.

import { createRequire } from 'node:module';

// The store runs on whichever runtime hosts the extension: Node (pi) exposes
// node:sqlite, while the test runner (Bun) exposes bun:sqlite. Both expose a
// compatible prepare/run/get/all surface.
type SqliteStatement = {
	run: (...params: unknown[]) => unknown;
	get: (...params: unknown[]) => unknown;
	all: (...params: unknown[]) => unknown[];
};
type SqliteDb = {
	exec: (sql: string) => void;
	prepare: (sql: string) => SqliteStatement;
};

function createSqlite(): SqliteDb {
	const require = createRequire(import.meta.url);
	try {
		const mod = require('node:sqlite') as { DatabaseSync: new (path?: string) => SqliteDb };
		return new mod.DatabaseSync(':memory:');
	} catch {
		const mod = require('bun:sqlite') as { Database: new (path: string) => SqliteDb };
		return new mod.Database(':memory:');
	}
}

export const RALPH_HEADER = '# ralph v2';
/** v1 header: accepted for auto-migration; render() writes the v2 form. */
export const LEGACY_RALPH_HEADER = '# ralph v1';

export interface Task {
	id: number;
	/** Feature/list grouping used to work on a subset of the backlog. */
	category: string | null;
	title: string;
	body: string | null;
	done: boolean;
	/** The single most recent context checkpoint (replaced, never stacked). */
	checkpoint: string | null;
	checkpointIteration: number | null;
	position: number;
}

export interface CompletionEntry {
	id: number;
	/** The task this entry belongs to. */
	taskId: number;
	/** YYYY-MM-DD; null when the source had no date. */
	date: string | null;
	note: string;
	/** 'done' (completed) or 'reopen' (reopened); drives the log marker. */
	kind: 'done' | 'reopen';
	position: number;
}

export interface MetaEntry {
	id: number;
	key: string;
	value: string;
	position: number;
}

export interface BacklogCounts {
	open: number;
	total: number;
	completed: number;
}

export class BacklogParseError extends Error {
	constructor(line: number, problem: string) {
		super(`line ${line}: ${problem}`);
		this.name = 'BacklogParseError';
	}
}

const SCHEMA = `
CREATE TABLE tasks (
	id INTEGER PRIMARY KEY,
	category TEXT,
	title TEXT NOT NULL,
	body TEXT,
	done INTEGER NOT NULL DEFAULT 0,
	checkpoint TEXT,
	checkpoint_iteration INTEGER,
	position INTEGER NOT NULL
);
CREATE TABLE completion_entries (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks(id),
	date TEXT,
	note TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'done',
	position INTEGER NOT NULL
);
CREATE TABLE meta (
	id INTEGER PRIMARY KEY,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	position INTEGER NOT NULL
);
`;

function newDatabase(): SqliteDb {
	const db = createSqlite();
	// node:sqlite enforces foreign keys, bun:sqlite does not by default;
	// turn the pragma on so both runtimes reject invalid references.
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(SCHEMA);
	return db;
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function indentBlock(text: string): string[] {
	return text.split('\n').map((line) => (line === '' ? '' : `  ${line}`));
}

interface OpenBlock {
	kind: 'legacy-section-body' | 'task-body' | 'checkpoint' | 'log-note';
	id: number;
	iteration?: number;
	ref?: string | null;
	date?: string | null;
	logKind?: 'done' | 'reopen';
	lines: string[];
}

/** True when the first non-blank line of the text is a ralph backlog header (v1 or v2). */
export function isRalphBacklog(text: string): boolean {
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === '') continue;
		const trimmed = line.trim();
		return trimmed === RALPH_HEADER || trimmed === LEGACY_RALPH_HEADER;
	}
	return false;
}

export class Backlog {
	readonly db: SqliteDb;

	private constructor(db: SqliteDb) {
		this.db = db;
	}

	// --- construction -------------------------------------------------------

	/** Parse a ralph-format backlog file into an in-memory SQLite store. */
	static parse(text: string): Backlog {
		const db = newDatabase();
		const backlog = new Backlog(db);
		const lines = text.split(/\r?\n/);
		// The header carries the format version: v1 files are parsed leniently
		// for auto-migration (legacy fields are dropped, render writes v2).
		let legacy = false;
		let headerSeen = false;
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]!.trim();
			if (line === '') continue;
			if (line === RALPH_HEADER) {
				headerSeen = true;
				break;
			}
			if (line === LEGACY_RALPH_HEADER) {
				legacy = true;
				headerSeen = true;
				break;
			}
			throw new BacklogParseError(index + 1, `unsupported ralph header "${line}" (expected ${RALPH_HEADER} or ${LEGACY_RALPH_HEADER})`);
		}
		if (!headerSeen) {
			throw new BacklogParseError(1, `missing ralph header (expected ${RALPH_HEADER} as the first non-blank line)`);
		}
		let block: OpenBlock | null = null;
		// v1 task keys (from 6/7-token T records) so old L references still
		// resolve during migration; v2 files reference tasks by id directly.
		const legacyKeys = new Map<string, number>();
		const pendingLogs: PendingLogEntry[] = [];

		const closeBlock = (line: number) => {
			if (!block) return;
			const body = block.lines.join('\n').replace(/\n+$/, '');
			const current = block;
			block = null;
			switch (current.kind) {
				case 'legacy-section-body':
					break; // v1 section bodies are dropped on migration
				case 'task-body': {
					const existing = db.prepare('SELECT body FROM tasks WHERE id = ?').get(current.id) as
						| { body: string | null }
						| undefined;
					if (existing && existing.body !== null) {
						throw new BacklogParseError(line, `task ${current.id} already has a body block`);
					}
					db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(body, current.id);
					break;
				}
				case 'checkpoint':
					db.prepare('UPDATE tasks SET checkpoint = ?, checkpoint_iteration = ? WHERE id = ?').run(
						body,
						current.iteration ?? 0,
						current.id
					);
					break;
				case 'log-note':
					// Collected, not inserted: the final pass links the entry to
					// its task or drops it (entries always belong to a task).
					pendingLogs.push({ id: current.id, ref: current.ref ?? null, date: current.date ?? null, kind: current.logKind ?? 'done', note: body });
					break;
			}
		};

		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			const lineNo = index + 1;
			if (line.trim() === '') {
				if (block) block.lines.push('');
				continue;
			}
			if (/^\s/.test(line)) {
				if (!block) throw new BacklogParseError(lineNo, 'indented line outside a block');
				block.lines.push(line.startsWith('  ') ? line.slice(2) : line.trimStart());
				continue;
			}

			closeBlock(lineNo);
			const trimmed = line.trim();
			if (trimmed.startsWith('#')) continue; // comment / header

			const fail = (problem: string): never => {
				throw new BacklogParseError(lineNo, problem);
			};
			const intField = (value: string, what: string): number => {
				if (!/^[1-9][0-9]*$/.test(value)) fail(`${what} must be a positive integer, got "${value}"`);
				return Number.parseInt(value, 10);
			};
			// Quote-aware tokenizer: a quoted token may contain spaces; the
			// returned tokens are unescaped values.
			const tokens: string[] = [];
			{
				let i = 0;
				while (i < trimmed.length) {
					while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;
					if (i >= trimmed.length) break;
					if (trimmed[i] === '"') {
						let out = '';
						i += 1;
						let closed = false;
						while (i < trimmed.length) {
							const ch = trimmed[i];
							if (ch === '\\' && i + 1 < trimmed.length) {
								out += trimmed[i + 1];
								i += 2;
							} else if (ch === '"') {
								closed = true;
								i += 1;
								break;
							} else {
								out += ch;
								i += 1;
							}
						}
						if (!closed) throw new BacklogParseError(lineNo, 'unterminated quoted string');
						tokens.push(out);
					} else {
						let j = i;
						while (j < trimmed.length && !/\s/.test(trimmed[j])) j += 1;
						tokens.push(trimmed.slice(i, j));
						i = j;
					}
				}
			}
			const tag = tokens[0];

			if (tag === 'M') {
				if (tokens.length !== 3) fail('meta record is: M <key> "<value>"');
				const key = tokens[1];
				if (!/^[a-z][a-z0-9-]*$/.test(key)) fail(`invalid meta key "${key}"`);
				const id = ((db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM meta').get() as { next: number }).next) + 1;
				const position = ((db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM meta').get() as { next: number }).next) + 1;
				db.prepare('INSERT INTO meta (id, key, value, position) VALUES (?, ?, ?, ?)').run(id, key, tokens[2], position);
			} else if (tag === 'S') {
				if (!legacy) fail('section records are v1-only; v2 files have no sections');
				// v1 section record: dropped on migration.
			} else if (tag === 'SB') {
				if (!legacy) fail('section body records are v1-only; v2 files have no sections');
				// v1 section body: consume the block and drop it.
				if (tokens.length !== 2) fail('section body record is: SB <id>');
				block = { kind: 'legacy-section-body', id: intField(tokens[1], 'section id'), lines: [] };
			} else if (tag === 'T') {
				// v2: T <id> <category|-> "<title>". v1 files may carry a
				// parent id, a task key and/or a section id as extra fields;
				// all are dropped on migration, but legacy keys are remembered
				// for old L references.
				if (legacy ? tokens.length < 4 || tokens.length > 7 : tokens.length !== 4) {
					fail('task record is: T <id> <category|-> "<title>"');
				}
				const id = intField(tokens[1], 'task id');
				const key = legacy && tokens.length >= 6 && tokens[tokens.length - 3] !== '-' ? tokens[tokens.length - 3] : null;
				const category = tokens[tokens.length - 2] === '-' ? null : tokens[tokens.length - 2];
				const title = tokens[tokens.length - 1];
				if (key !== null) legacyKeys.set(key, id);
				if ((db.prepare('SELECT id FROM tasks WHERE id = ?').get(id) as { id: number } | undefined)) {
					fail(`duplicate task id ${id}`);
				}
				db.prepare(
					'INSERT INTO tasks (id, category, title, position) VALUES (?, ?, ?, ?)'
				).run(
					id,
					category,
					title,
					(db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM tasks').get() as { next: number }).next
				);
			} else if (tag === 'B') {
				if (tokens.length !== 2) fail('task body record is: B <id>');
				const id = intField(tokens[1], 'task id');
				const task = db.prepare('SELECT id, body FROM tasks WHERE id = ?').get(id) as
					| { id: number; body: string | null }
					| undefined;
				if (!task) throw new BacklogParseError(lineNo, `unknown task id ${id}`);
				if (task.body !== null) fail(`task ${id} already has a body block`);
				block = { kind: 'task-body', id, lines: [] };
			} else if (tag === 'D') {
				if (tokens.length !== 2) fail('done record is: D <id>');
				const id = intField(tokens[1], 'task id');
				const task = db.prepare('SELECT id, done FROM tasks WHERE id = ?').get(id) as
					| { id: number; done: number }
					| undefined;
				if (!task) throw new BacklogParseError(lineNo, `unknown task id ${id}`);
				if (task.done) fail(`task ${id} is already marked done`);
				db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(id);
			} else if (tag === 'C') {
				if (tokens.length !== 3) fail('checkpoint record is: C <id> <iteration>');
				const id = intField(tokens[1], 'task id');
				const iteration = intField(tokens[2], 'iteration');
				const task = db.prepare('SELECT id, checkpoint FROM tasks WHERE id = ?').get(id) as
					| { id: number; checkpoint: string | null }
					| undefined;
				if (!task) throw new BacklogParseError(lineNo, `unknown task id ${id}`);
				if (task.checkpoint !== null) fail(`task ${id} already has a checkpoint block`);
				block = { kind: 'checkpoint', id, iteration, lines: [] };
			} else if (tag === 'L') {
				if (tokens.length < 3 || tokens.length > 5) fail('log record is: L <id> <taskId> <date|-> <kind|->');
				const id = intField(tokens[1], 'log id');
				const ref = tokens[2] === '-' ? null : tokens[2];
				if (!legacy && ref === null) fail('log entries always belong to a task: L <id> <taskId> <date|-> <kind|->');
				if (!legacy && ref !== null && !/^[1-9][0-9]*$/.test(ref)) fail(`log task reference must be a task id, got "${ref}"`);
				let date: string | null = null;
				if (tokens.length >= 4) {
					date = tokens[3] === '-' ? null : tokens[3];
					if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`invalid date "${date}" (expected YYYY-MM-DD)`);
				}
				let logKind: 'done' | 'reopen' = 'done';
				if (tokens.length === 5) {
					if (tokens[4] !== 'done' && tokens[4] !== 'reopen') fail(`invalid log kind "${tokens[4]}" (expected done or reopen)`);
					logKind = tokens[4];
				}
				block = { kind: 'log-note', id, ref, date, logKind, lines: [] };
			} else {
				fail(`unknown record tag "${tag}"`);
			}
		}
		closeBlock(lines.length);
		insertLogEntries(db, pendingLogs, legacyKeys);
		return backlog;
	}

	// --- queries --------------------------------------------------------------

	listTasks(category?: string): Task[] {
		const rows =
			category === undefined
				? this.db.prepare('SELECT * FROM tasks ORDER BY position').all()
				: this.db.prepare('SELECT * FROM tasks WHERE category = ? ORDER BY position').all(category);
		return (rows as Array<Record<string, unknown>>).map((row) => ({
			id: row.id as number,
			category: (row.category as string | null) ?? null,
			title: row.title as string,
			body: (row.body as string | null) ?? null,
			done: (row.done as number) === 1,
			checkpoint: (row.checkpoint as string | null) ?? null,
			checkpointIteration: (row.checkpoint_iteration as number | null) ?? null,
			position: row.position as number
		}));
	}

	listLogEntries(): CompletionEntry[] {
		return (this.db.prepare('SELECT * FROM completion_entries ORDER BY position').all() as Array<
			Record<string, unknown>
		>).map(mapLogEntry);
	}

	/** Completion log entries linked to the given task, in file order. */
	listLogEntriesForTask(taskId: number): CompletionEntry[] {
		return (this.db.prepare('SELECT * FROM completion_entries WHERE task_id = ? ORDER BY position').all(taskId) as Array<
			Record<string, unknown>
		>).map(mapLogEntry);
	}

	counts(category?: string): BacklogCounts {
		const row = (
			category === undefined
				? this.db.prepare('SELECT COUNT(*) AS total, SUM(done) AS completed FROM tasks')
				: this.db.prepare('SELECT COUNT(*) AS total, SUM(done) AS completed FROM tasks WHERE category = ?')
		).get(...(category === undefined ? [] : [category])) as { total: number; completed: number | null };
		const completed = row.completed ?? 0;
		return { open: row.total - completed, total: row.total, completed };
	}

	/**
	 * Position numbers for the tasks: "1", "2", … in list order. These
	 * numbers are the tasks' addresses in the file, the tool, and the view.
	 */
	taskNumbers(category?: string): Map<number, string> {
		const numbers = new Map<number, string>();
		let index = 0;
		for (const task of this.listTasks(category)) {
			index += 1;
			numbers.set(task.id, String(index));
		}
		return numbers;
	}

	/** Find a task by its position number (e.g. "3"), optionally scoped. */
	findTaskByNumber(number: string, category?: string): Task | undefined {
		const numbers = this.taskNumbers(category);
		return this.listTasks(category).find((task) => numbers.get(task.id) === number);
	}

	private requireTask(number: string, category?: string): Task {
		const task = this.findTaskByNumber(number, category);
		if (!task) {
			const known = [...this.taskNumbers(category).values()].join(', ');
			throw new Error(`no task ${number} (tasks: ${known || 'none'})`);
		}
		return task;
	}

	/** The first open task in backlog order (optionally scoped to a category). */
	nextOpenTask(category?: string): Task | undefined {
		return this.listTasks(category).find((task) => !task.done);
	}

	/**
	 * Tasks whose title, body, or checkpoint contains the query
	 * (case-insensitive substring). Completion log notes are matched
	 * separately by the search renderer.
	 */
	searchTasks(query: string, category?: string): Task[] {
		const needle = query.toLowerCase();
		return this.listTasks(category).filter(
			(task) =>
				task.title.toLowerCase().includes(needle) ||
				(task.body ?? '').toLowerCase().includes(needle) ||
				(task.checkpoint ?? '').toLowerCase().includes(needle)
		);
	}

	listMeta(): MetaEntry[] {
		return (this.db.prepare('SELECT * FROM meta ORDER BY position').all() as Array<Record<string, unknown>>).map(
			(row) => ({
				id: row.id as number,
				key: row.key as string,
				value: row.value as string,
				position: row.position as number
			})
		);
	}

	/** Source files that were imported into this backlog (M source records). */
	sources(): string[] {
		return this.listMeta()
			.filter((meta) => meta.key === 'source')
			.map((meta) => meta.value);
	}

	addSource(source: string): void {
		const id = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM meta').get() as { next: number }).next) + 1;
		const position = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM meta').get() as { next: number }).next) + 1;
		this.db.prepare('INSERT INTO meta (id, key, value, position) VALUES (?, ?, ?, ?)').run(id, 'source', source, position);
	}
	/**
	 * Create an empty list (category). Lists are normally implied by the tasks
	 * they contain; this records an explicit `M list` meta entry so a freshly
	 * created list shows up even before it has any tasks.
	 */
	createList(name: string): void {
		const target = name.trim();
		if (!target) throw new Error('a list name is required');
		if (target === '-' || /\s/.test(target)) throw new Error('a list name cannot be empty or contain spaces');
		if (this.categories().includes(target)) throw new Error(`a list named "${target}" already exists`);
		const id = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM meta').get() as { next: number }).next) + 1;
		const position = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM meta').get() as { next: number }).next) + 1;
		this.db.prepare('INSERT INTO meta (id, key, value, position) VALUES (?, ?, ?, ?)').run(id, 'list', target, position);
	}
	/** The names of explicitly created (M list) lists. */
	createdLists(): string[] {
		return this.listMeta().filter((meta) => meta.key === 'list').map((meta) => meta.value);
	}

	// --- mutations --------------------------------------------------------------

	/** Mark the task with the given position number done. Throws when unknown. */
	complete(number: string, category?: string): Task {
		const task = this.requireTask(number, category);
		this.db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
		return { ...task, done: true };
	}

	/** Replace the single context checkpoint of the task with the given number. */
	setCheckpoint(number: string, note: string, iteration: number, category?: string): Task {
		const task = this.requireTask(number, category);
		this.db.prepare('UPDATE tasks SET checkpoint = ?, checkpoint_iteration = ? WHERE id = ?').run(note, iteration, task.id);
		return { ...task, checkpoint: note, checkpointIteration: iteration };
	}

	addTask(
		options: {
			title: string;
			body?: string;
			category?: string;
		},
	): Task {
		const title = options.title.trim();
		if (!title) throw new Error('a task title is required');
		const id = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM tasks').get() as { next: number }).next) + 1;
		const position = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM tasks').get() as { next: number }).next) + 1;
		this.db.prepare(
			'INSERT INTO tasks (id, category, title, body, position) VALUES (?, ?, ?, ?, ?)'
		).run(id, options.category ?? null, title, options.body?.trim() || null, position);
		return this.listTasks().find((task) => task.id === id)!;
	}

	/** The distinct task categories (lists) in first-appearance order. */
	categories(): string[] {
		const seen: string[] = [];
		for (const task of this.listTasks()) {
			if (task.category !== null && !seen.includes(task.category)) seen.push(task.category);
		}
		// Explicitly created lists (M list) show up even when they have no tasks.
		for (const name of this.createdLists()) {
			if (!seen.includes(name)) seen.push(name);
		}
		return seen;
	}

	/**
	 * Rename a list (category). Completion log entries stay linked because
	 * they reference tasks by id, and the recorded import sources are meta
	 * records, not categories.
	 */
	renameCategory(oldName: string, newName: string): number {
		const target = newName.trim();
		if (!target) throw new Error('a list name is required');
		const renamed = this.listTasks().filter((task) => task.category === oldName);
		const hasMeta = this.createdLists().includes(oldName);
		if (renamed.length === 0 && !hasMeta) {
			throw new Error(`no list named "${oldName}" (lists: ${this.categories().join(', ') || 'none'})`);
		}
		if (target === oldName) return 0;
		if (this.categories().includes(target)) {
			throw new Error(`a list named "${target}" already exists`);
		}
		this.db.prepare('UPDATE tasks SET category = ? WHERE category = ?').run(target, oldName);
		const meta = this.listMeta().find((m) => m.key === 'list' && m.value === oldName);
		if (meta) this.db.prepare('UPDATE meta SET value = ? WHERE id = ?').run(target, meta.id);
		return renamed.length;
	}

	/** Mark the task with the given id done or open again. */
	setDoneById(id: number, done: boolean): Task {
		const task = this.listTasks().find((t) => t.id === id);
		if (!task) throw new Error(`no task with id ${id}`);
		this.db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(done ? 1 : 0, id);
		return { ...task, done };
	}

	/** Mark the task with the given position number done or open again. */
	setDone(number: string, done: boolean, category?: string): Task {
		const task = this.requireTask(number, category);
		return this.setDoneById(task.id, done);
	}

	/**
	 * Update a task's title, body, and/or category. An empty string (or null)
	 * clears body/category.
	 */
	updateTaskById(id: number, changes: { title?: string; body?: string | null; category?: string | null }): Task {
		const task = this.listTasks().find((t) => t.id === id);
		if (!task) throw new Error(`no task with id ${id}`);
		let { title, body, category } = task;
		if (changes.title !== undefined) {
			title = changes.title.trim();
			if (!title) throw new Error('a task title is required');
		}
		if (changes.body !== undefined) {
			const nextBody = changes.body ?? '';
			body = nextBody.trim() === '' ? null : nextBody.trim();
		}
		if (changes.category !== undefined) {
			const nextCategory = changes.category ?? '';
			category = nextCategory.trim() === '' ? null : nextCategory.trim();
		}
		this.db.prepare('UPDATE tasks SET title = ?, body = ?, category = ? WHERE id = ?').run(title, body, category, id);
		return this.listTasks().find((t) => t.id === id)!;
	}

	/** Update the task with the given position number. See updateTaskById. */
	updateTask(number: string, changes: { title?: string; body?: string | null; category?: string | null }, category?: string): Task {
		const task = this.requireTask(number, category);
		return this.updateTaskById(task.id, changes);
	}
	/**
	 * Move the task with the given position number up or down by `by` steps
	 * (default 1) within the list. Throws when the task is already at the
	 * edge of the list.
	 */
	moveTask(number: string, direction: 'up' | 'down', by = 1, category?: string): Task {
		if (!Number.isInteger(by) || by < 1) throw new Error('move steps must be a positive integer');
		const task = this.requireTask(number, category);
		const tasks = this.listTasks(category);
		const index = tasks.findIndex((t) => t.id === task.id);
		const target = index + (direction === 'up' ? -by : by);
		if (target < 0 || target >= tasks.length) {
			throw new Error(`task ${number} is already ${direction === 'up' ? 'first' : 'last'} in the list`);
		}
		const [moved] = tasks.splice(index, 1);
		tasks.splice(target, 0, moved);
		// Reassign positions: the scoped tasks keep the slots they occupied
		// (first scoped slot through last) in their new order; unscoped tasks
		// keep their relative positions.
		const all = this.listTasks();
		const scopedIds = new Set(tasks.map((t) => t.id));
		const newOrder: Task[] = [];
		let filled = false;
		for (const t of all) {
			if (scopedIds.has(t.id)) {
				if (!filled) {
					newOrder.push(...tasks);
					filled = true;
				}
			} else {
				newOrder.push(t);
			}
		}
		const movedPosition = newOrder.findIndex((t) => t.id === task.id) + 1;
		newOrder.forEach((t, i) => this.db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(i + 1, t.id));
		// The old number now addresses a different task, so report the moved
		// task itself with its new position.
		return { ...task, position: movedPosition };
	}

	/**
	 * Delete the task with the given id. Completion log entries that referred
	 * to the task are deleted with it: an entry always belongs to a task.
	 */
	deleteTaskById(id: number): void {
		const task = this.listTasks().find((t) => t.id === id);
		if (!task) throw new Error(`no task with id ${id}`);
		// Completion log entries belong to the task: delete them with it.
		this.db.prepare('DELETE FROM completion_entries WHERE task_id = ?').run(id);
		this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
	}

	/** Delete the task with the given position number. See deleteTaskById. */
	deleteTask(number: string, category?: string): void {
		const task = this.requireTask(number, category);
		this.deleteTaskById(task.id);
	}

	addLogEntry(options: { task: string; date?: string; note: string; kind?: 'done' | 'reopen' }, category?: string): CompletionEntry {
		const note = options.note.trim();
		if (!note) throw new Error('a log note is required');
		if (options.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
			throw new Error(`invalid date "${options.date}" (expected YYYY-MM-DD)`);
		}
		const task = this.requireTask(options.task, category);
		const id = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM completion_entries').get() as { next: number }).next) + 1;
		const position = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM completion_entries').get() as { next: number }).next) + 1;
		const kind = options.kind ?? 'done';
		this.db.prepare('INSERT INTO completion_entries (id, task_id, date, note, kind, position) VALUES (?, ?, ?, ?, ?, ?)').run(
			id,
			task.id,
			options.date ?? null,
			note,
			kind,
			position
		);
		return { id, taskId: task.id, date: options.date ?? null, note, kind, position };
	}

	/**
	 * Merge another backlog's tasks and log entries into this one. Tasks and
	 * log entries get new ids (task links are remapped). When a category is
	 * given it is stamped on every merged task.
	 */
	mergeFrom(other: Backlog, options: { category?: string } = {}): { tasks: number; logEntries: number } {
		const category = options.category ?? null;
		const otherTasks = other.listTasks();
		let nextTaskId = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM tasks').get() as { next: number }).next) + 1;
		let nextTaskPosition = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM tasks').get() as { next: number }).next) + 1;
		const idBySource = new Map<number, number>();
		let mergedTasks = 0;
		for (const task of otherTasks) {
			this.db
				.prepare(
					'INSERT INTO tasks (id, category, title, body, done, checkpoint, checkpoint_iteration, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
				)
				.run(
					nextTaskId,
					category,
					task.title,
					task.body,
					task.done ? 1 : 0,
					task.checkpoint,
					task.checkpointIteration,
					nextTaskPosition
				);
			idBySource.set(task.id, nextTaskId);
			nextTaskId += 1;
			nextTaskPosition += 1;
			mergedTasks += 1;
		}
		let nextLogId = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS next FROM completion_entries').get() as { next: number }).next) + 1;
		let nextLogPosition = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS next FROM completion_entries').get() as { next: number }).next) + 1;
		let mergedLogEntries = 0;
		for (const entry of other.listLogEntries()) {
			// Every entry belongs to a task, and every source task was merged
			// above, so the mapping is guaranteed.
			const taskId = idBySource.get(entry.taskId)!;
			this.db
				.prepare('INSERT INTO completion_entries (id, task_id, date, note, kind, position) VALUES (?, ?, ?, ?, ?, ?)')
				.run(nextLogId, taskId, entry.date, entry.note, entry.kind, nextLogPosition);
			nextLogId += 1;
			nextLogPosition += 1;
			mergedLogEntries += 1;
		}
		return { tasks: mergedTasks, logEntries: mergedLogEntries };
	}

	// --- serialization -----------------------------------------------------------

	/** Serialize the store back to the ralph text format. */
	render(): string {
		const out: string[] = [RALPH_HEADER];
		for (const meta of this.listMeta()) {
			out.push(`M ${meta.key} ${quote(meta.value)}`);
		}
		out.push('');
		for (const task of this.listTasks()) {
			const category = task.category === null || !/\s/.test(task.category) ? (task.category ?? '-') : quote(task.category);
			out.push(`T ${task.id} ${category} ${quote(task.title)}`);
			if (task.body !== null && task.body !== '') {
				out.push(`B ${task.id}`);
				out.push(...indentBlock(task.body));
			}
			if (task.done) out.push(`D ${task.id}`);
			if (task.checkpoint !== null) {
				out.push(`C ${task.id} ${task.checkpointIteration ?? 1}`);
				out.push(...indentBlock(task.checkpoint));
			}
			out.push('');
		}
		for (const entry of this.listLogEntries()) {
			out.push(`L ${entry.id} ${entry.taskId} ${entry.date ?? '-'}${entry.kind === 'reopen' ? ' reopen' : ''}`);
			out.push(...indentBlock(entry.note));
			out.push('');
		}
		return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
	}

	// --- Markdown import -----------------------------------------------------------
	//
	// Import the two observed TODO.md dialects:
	//  - APGLoket: "## Priority N — …" sections, "- [ ] **P0.1 Title.**" tasks
	//    with indented sub-bullet bodies (boundaries, Evidence:, Acceptance:),
	//    and a "## Completion log" of "- YYYY-MM-DD **KEY** — note" entries.
	//  - ralph-playground: "## Name" sections, "- [x] **Title.** inline body"
	//    tasks with optional indented "_Completion note: …_" lines.
	//
	// The backlog is a single flat list: Markdown headings only mark the
	// completion log; their text (protocol steps, baseline facts, section
	// intros) is not imported.

	/**
	 * Parse a Markdown Ralph backlog (TODO.md) into a Backlog store. When a
	 * category is given it is stamped on every imported task, so several
	 * Markdown files can be merged into one backlog (see mergeFrom).
	 */
	static fromMarkdown(md: string, options: { category?: string } = {}): Backlog {
		const db = newDatabase();
		const backlog = new Backlog(db);
		const category = options.category ?? null;
		const lines = md.split(/\r?\n/);

		interface MdOpenTask extends MdTask {
			id: number;
			position: number;
			inCheckpoint: boolean;
		}
		const st = { task: null as MdOpenTask | null };
		let nextTaskId = 1;
		let nextLogId = 1;
		let taskPosition = 0;
		// True while the current h2 heading is the completion log: its bullets
		// are log entries, not tasks.
		let inLogSection = false;
		// Source task keys (stripped from titles) so completion log references
		// like "**P0.1**" still resolve to the imported tasks.
		const keyToId = new Map<string, number>();
		const pendingLogs: PendingLogEntry[] = [];

		const flushTask = () => {
			if (!st.task) return;
			const current = st.task;
			st.task = null;
			const body = current.bodyLines.join('\n').replace(/\n+$/, '');
			const checkpoint = current.checkpointLines.join('\n').replace(/\n+$/, '');
			if (current.key !== null) keyToId.set(current.key, current.id);
			db.prepare(
				'INSERT INTO tasks (id, category, title, body, done, checkpoint, checkpoint_iteration, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			).run(
				current.id,
				category,
				current.title,
				body === '' ? null : body,
				current.done ? 1 : 0,
				checkpoint === '' ? null : checkpoint,
				current.checkpointIteration,
				current.position
			);
		};

		const addLogEntry = (ref: string | null, date: string | null, note: string) => {
			// Collected, not inserted: the final pass links the entry to its
			// task or drops it (entries always belong to a task).
			pendingLogs.push({ id: nextLogId, ref, date, kind: 'done', note });
			nextLogId += 1;
		};

		for (const rawLine of lines) {
			const line = rawLine.replace(/\s+$/, '');
			if (line.trim() === '') continue;

			const heading = line.match(/^(#{1,6})\s+(.*)$/);
			if (heading) {
				if (heading[1].length === 2) {
					flushTask();
					inLogSection = /completion log/i.test(heading[2]);
				}
				continue; // h1 title and deeper headings are ignored
			}

			const checkbox = line.match(/^\s*- \[([ xX])\]\s+(.*)$/);
			if (checkbox) {
				const done = checkbox[1].toLowerCase() === 'x';
				const { task: parsed, rest } = parseMdTaskLine(checkbox[2], done);
				// Indented checkboxes are imported as regular tasks: the
				// backlog is a single flat list in file order.
				flushTask();
				taskPosition += 1;
				st.task = {
					...parsed,
					id: nextTaskId++,
					position: taskPosition,
					inCheckpoint: false
				};
				if (rest !== '') st.task.bodyLines.push(rest);
				continue;
			}

			// Completion log entries: "- 2026-08-12 **D4** — note" bullets.
			if (inLogSection) {
				const bullet = line.match(/^\s*-\s+(.*)$/);
				if (bullet) {
					let text = bullet[1];
					let date: string | null = null;
					const dateMatch = text.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
					if (dateMatch && DATE_RE.test(dateMatch[1])) {
						date = dateMatch[1];
						text = dateMatch[2];
					}
					const ref = text.match(/^\*\*(.+?)\*\*\s*[—–-]?\s*(.*)$/);
					if (ref) {
						addLogEntry(ref[1].trim(), date, ref[2].trim());
					} else {
						addLogEntry(null, date, text.trim());
					}
				}
				continue;
			}

			// Indented (or blank) lines belong to the open st.task: body or the
			// single context checkpoint.
			if (st.task && /^\s/.test(line)) {
				const content = line.startsWith('  ') ? line.slice(2) : line.trimStart();
				const checkpointMatch = content.match(CHECKPOINT_RE);
				if (checkpointMatch && !st.task.inCheckpoint) {
					st.task.inCheckpoint = true;
					st.task.checkpointIteration = Number.parseInt(checkpointMatch[1], 10);
					// Keep the text after the label ("…: completed X; next step Y").
					const after = content
						.slice(checkpointMatch.index! + checkpointMatch[0].length)
						.replace(/^[\s:—–-]+/, '')
						.replace(/_+$/, '')
						.trim();
					if (after !== '') st.task.checkpointLines.push(after);
				} else if (st.task.inCheckpoint) {
					st.task.checkpointLines.push(content);
				} else {
					st.task.bodyLines.push(content);
				}
				continue;
			}

			// Top-level non-checkbox content (protocol steps, baseline facts,
			// section intros) is not part of the flat task list.
			flushTask();
		}
		flushTask();
		// Numeric Markdown references are position numbers, not ids: remap them
		// to ids so the final pass (which treats numeric refs as ids) links them.
		const numbers = backlog.taskNumbers();
		for (const entry of pendingLogs) {
			if (entry.ref !== null && /^[1-9][0-9]*$/.test(entry.ref)) {
				const match = [...numbers.entries()].find(([, number]) => number === entry.ref);
				if (match) entry.ref = String(match[0]);
			}
		}
		insertLogEntries(db, pendingLogs, keyToId);
		return backlog;
	}
}

// --- completion-entry helpers ---------------------------------------------------------

function mapLogEntry(row: Record<string, unknown>): CompletionEntry {
	return {
		id: row.id as number,
	taskId: row.task_id as number,
		date: (row.date as string | null) ?? null,
		note: row.note as string,
		kind: (row.kind as string) === 'reopen' ? 'reopen' : 'done',
		position: row.position as number
	};
}

/** A completion entry collected while parsing, before its ref resolves. */
interface PendingLogEntry {
	id: number;
	ref: string | null;
	date: string | null;
	kind: 'done' | 'reopen';
	note: string;
}

/**
 * Insert the collected completion entries, linked to their tasks: a numeric
 * ref is a task id, any other ref is looked up in the legacy/source key map.
 * Entries whose ref does not resolve are dropped: an entry always belongs
 * to a task. Log records may appear before the tasks they reference, so
 * this runs as a final pass, and positions follow the file order.
 */
function insertLogEntries(
	db: SqliteDb,
	entries: PendingLogEntry[],
	legacyKeys: Map<string, number> = new Map()
): void {
	const findTask = db.prepare('SELECT id FROM tasks WHERE id = ?');
	const insert = db.prepare('INSERT INTO completion_entries (id, task_id, date, note, kind, position) VALUES (?, ?, ?, ?, ?, ?)');
	entries.forEach((entry, index) => {
		let taskId: number | null = null;
		if (entry.ref !== null) {
			if (/^[1-9][0-9]*$/.test(entry.ref)) {
				const task = findTask.get(Number.parseInt(entry.ref, 10)) as { id: number } | undefined;
				taskId = task?.id ?? null;
			} else {
				taskId = legacyKeys.get(entry.ref) ?? null;
			}
		}
		if (taskId !== null) insert.run(entry.id, taskId, entry.date, entry.note, entry.kind, index + 1);
	});
}

// --- Markdown import helpers --------------------------------------------------------

const TASK_KEY_RE = /^([A-Z][A-Za-z0-9]*(?:\.[0-9]+)+[a-z]?|[A-Z][0-9]+[a-z]?)(?=\s)/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKPOINT_RE = /Context checkpoint \(iteration (\d+)\)/;

interface MdTask {
	key: string | null;
	title: string;
	done: boolean;
	bodyLines: string[];
	checkpointLines: string[];
	checkpointIteration: number | null;
}

function parseMdTaskLine(text: string, done: boolean): { task: MdTask; rest: string } {
	const bold = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
	const head = bold ? bold[1] : text;
	const rest = bold ? bold[2] : '';
	const keyMatch = head.match(TASK_KEY_RE);
	const key = keyMatch ? keyMatch[1] : null;
	const title = (keyMatch ? head.slice(keyMatch[0].length).trim() : head).trim();
	return {
		task: { key, title, done, bodyLines: [], checkpointLines: [], checkpointIteration: null },
		rest: rest.trim()
	};
}

// --- Readable rendering (for the ralph_todo tool output) -------------------------

/** View options for formatBacklog. */
export interface BacklogViewOptions {
	/**
	 * Full view: every task with checkpoints and completion log entries.
	 * The default compact view shows only open tasks plus completed tasks
	 * that still lack a completion log entry, so a routine list call stays small.
	 */
	verbose?: boolean;
}

/**
 * Render the backlog as readable text for the ralph_todo tool. Compact by
 * default (counts, per-list counts, open tasks, unrecorded completions) so
 * the model does not load the whole history into context; pass verbose for
 * the full backlog with checkpoints and completion log entries.
 */
export function formatBacklog(backlog: Backlog, category?: string, options: BacklogViewOptions = {}): string {
	const verbose = options.verbose === true;
	const all = backlog.counts();
	const lines: string[] = [];
	const counts = backlog.counts(category);
	lines.push(
		category === undefined
			? `Backlog: ${all.open} open / ${all.total} total (${all.completed} done)`
			: `Backlog: ${all.open} open / ${all.total} total · category "${category}": ${counts.open} open / ${counts.total} total (${counts.completed} done)`
	);
	if (category === undefined) {
		const parts = backlog.categories().map((name) => {
			const c = backlog.counts(name);
			return `${name} ${c.open}/${c.total}`;
		});
		const uncategorized = backlog.listTasks().filter((task) => task.category === null);
		if (uncategorized.length > 0) {
			parts.push(`uncategorized ${uncategorized.filter((task) => !task.done).length}/${uncategorized.length}`);
		}
		if (parts.length > 0) lines.push(`Lists: ${parts.join(' · ')}`);
	}
	lines.push('');
	const tasks = backlog.listTasks(category);
	const numbers = backlog.taskNumbers(category);
	for (const task of tasks) {
		const entries = backlog.listLogEntriesForTask(task.id);
		if (!verbose && task.done && entries.length > 0) continue;
		const marker = task.done ? '[x]' : '[ ]';
		const number = `${numbers.get(task.id) ?? '?'} `;
		const cat = task.category ? ` [${task.category}]` : '';
		lines.push(`- ${marker} ${number}${task.title}${cat}`);
		if (verbose) {
			if (task.checkpoint !== null) {
				lines.push(`  checkpoint (iteration ${task.checkpointIteration ?? '?'}): ${task.checkpoint}`);
			}
			for (const entry of entries) {
				const date = entry.date ? `${entry.date} ` : '';
				const entryMarker = entry.kind === 'reopen' ? '✗' : '✓';
				lines.push(`  ${entryMarker} ${date}${entry.note}`);
			}
		}
	}
	if (!verbose) {
		lines.push('');
		lines.push('Compact view: open tasks plus completed tasks without a completion log entry. Pass verbose: true for the full backlog with checkpoints and log entries.');
	}
	return lines.join('\n');
}

/**
 * Compact single-task view for the ralph_todo "next" action: just enough for
 * the model to start work on the next open task without loading the whole
 * backlog into context.
 */
export function formatNextTask(backlog: Backlog, task: Task, category?: string): string {
	const numbers = backlog.taskNumbers(category);
	const number = numbers.get(task.id) ?? String(task.id);
	const lines: string[] = [];
	lines.push(`Next task: ${number} ${task.title}`);
	const meta: string[] = [];
	if (task.category) meta.push(`list: ${task.category}`);
	if (meta.length > 0) lines.push(meta.join(' · '));
	if (task.body !== null) {
		lines.push('', 'Task body:', task.body);
	}
	if (task.checkpoint !== null) {
		lines.push('', `Checkpoint (iteration ${task.checkpointIteration ?? '?'}):`, task.checkpoint);
	}
	return lines.join('\n');
}
/**
 * Single-task detail view for the ralph_todo "list" action with a task
 * number: the task's body, checkpoint, and full completion log, without
 * loading the rest of the backlog into context.
 */
export function formatTaskDetail(backlog: Backlog, task: Task, category?: string): string {
	const numbers = backlog.taskNumbers(category);
	const number = numbers.get(task.id) ?? String(task.id);
	const lines: string[] = [];
	lines.push(`Task ${number}: ${task.title} ${task.done ? '[x]' : '[ ]'}`);
	const meta: string[] = [];
	if (task.category) meta.push(`list: ${task.category}`);
	if (meta.length > 0) lines.push(meta.join(' · '));
	if (task.body !== null) {
		lines.push('', 'Task body:', task.body);
	}
	if (task.checkpoint !== null) {
		lines.push('', `Checkpoint (iteration ${task.checkpointIteration ?? '?'}):`, task.checkpoint);
	}
	const entries = backlog.listLogEntriesForTask(task.id);
	if (entries.length > 0) {
		lines.push('', 'Completion log:');
		for (const entry of entries) {
			const date = entry.date ? `${entry.date} ` : '';
			const entryMarker = entry.kind === 'reopen' ? '✗' : '✓';
			lines.push(`  ${entryMarker} ${date}${entry.note}`);
		}
	}
	return lines.join('\n');
}

/**
 * Render the ralph_todo "search" action results: every matching task with
 * the lines that matched (title, body, checkpoint, completion log notes),
 * so the model can find tasks by keyword without reading the backlog file
 * directly.
 */
export function formatSearchResults(backlog: Backlog, query: string, category?: string): string {
	const needle = query.toLowerCase();
	const tasks = backlog.searchTasks(query, category);
	const total = backlog.counts(category).total;
	const scope = category === undefined ? 'all lists' : `list "${category}"`;
	if (tasks.length === 0) {
		return `No matches for "${query}" (${total} tasks in ${scope}).`;
	}
	const numbers = backlog.taskNumbers(category);
	const lines: string[] = [`Search "${query}": ${tasks.length} of ${total} tasks match in ${scope}.`];
	for (const task of tasks) {
		const number = numbers.get(task.id) ?? '?';
		const marker = task.done ? '[x]' : '[ ]';
		const cat = task.category ? ` [${task.category}]` : '';
		lines.push(`- ${marker} ${number} ${task.title}${cat}`);
		if (task.body !== null && task.body.toLowerCase().includes(needle)) {
			for (const line of task.body.split('\n')) {
				if (line.trim().toLowerCase().includes(needle)) lines.push(`  ~ body: ${line.trim()}`);
			}
		}
		if (task.checkpoint !== null && task.checkpoint.toLowerCase().includes(needle)) {
			for (const line of task.checkpoint.split('\n')) {
				if (line.trim().toLowerCase().includes(needle)) {
					lines.push(`  ~ checkpoint (iteration ${task.checkpointIteration ?? '?'}): ${line.trim()}`);
				}
			}
		}
		for (const entry of backlog.listLogEntriesForTask(task.id)) {
			if (!entry.note.toLowerCase().includes(needle)) continue;
			const date = entry.date ? `${entry.date} ` : '';
			const entryMarker = entry.kind === 'reopen' ? '✗' : '✓';
			for (const line of entry.note.split('\n')) {
				if (line.trim().toLowerCase().includes(needle)) lines.push(`  ~ log ${entryMarker} ${date}${line.trim()}`);
			}
		}
	}
	return lines.join('\n');
}
