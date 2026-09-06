import {
	CONFIG_DIR_NAME,
	getMarkdownTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext
} from '@earendil-works/pi-coding-agent';
import {
	Container,
	Input,
	Markdown,
	type AutocompleteItem,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth
} from '@earendil-works/pi-tui';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import {
	Backlog,
	formatBacklog,
	formatGoal,
	formatNextTask,
	formatSearchResults,
	formatTaskDetail,
	isRalphBacklog,
	type CompletionEntry,
	type Goal,
	type GoalStatus
} from './backlog.ts';
import { createTodosView, type TodosView } from './todos-view.ts';
import { createRalphHome, type RalphHome } from './ralph-home.ts';

const STATE_TYPE = 'ralph-loop-state';
const CONFIG_TYPE = 'ralph-loop-config';
const CONFIG_FILE_NAME = 'ralph-loop.json';
/** Marks the beginning of an independent Ralph iteration in the same session. */
const CONTEXT_BOUNDARY_TYPE = 'ralph-loop-context-boundary';
/** Completion-summary message injected at the start of each fresh Ralph iteration. */
const COMPLETION_SUMMARY_TYPE = 'ralph-loop-completion-summary';
/** Marker in a ralph-provided compaction entry's details (distinguishes it from pi's LLM compactions). */
const COMPACTION_SOURCE = 'ralph-loop';
const DEFAULT_TODO = 'TODO.ralph';
const DEFAULT_SPEC = 'SPEC.md';
/** Fixed state file of the auto mode: loop state and session todos live here. */
const AUTO_TODO_FILE = '_auto_.ralph';
/** Generic planning document bundled with this extension for /ralph-init to adapt. */
const INIT_TEMPLATE_SPEC = join(import.meta.dirname, 'SPEC.template.md');
const DEFAULT_CONTEXT_THRESHOLD = 0.5;
const DEFAULT_AUTO_APPROVE_DECISIONS = false;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_COMPACTION_MODE = true;
const DEFAULT_MODEL_CONFIG_KEY = '__default__';
/**
 * The auto mode setting: off — nothing automatic; on — the auto loop starts
 * at session start; auto — the auto loop arms itself when the context crosses
 * the budget (at session start or mid-session) and records todos for the next
 * iteration.
 */
type AutoMode = 'off' | 'on' | 'auto';
const DEFAULT_AUTO_MODE: AutoMode = 'off';
/** Tools activated additively (defer_loading) by ralph_enable or /ralph start; disabled again on session start when no loop is active. Once in context they stay in context for the rest of the session. */
const RALPH_TOOL_NAMES = ['ralph_todo', 'ralph_goal', 'ralph_request_decision', 'ralph_resolve_decision'];
/** The dedicated tool of the auto mode; an active auto loop activates only this one. */
const AUTO_TOOL_NAME = 'ralph_auto';
/** On-demand action reference; the compact tool descriptions point here instead of always-in-context text. */
const REFERENCE_DOC = join(import.meta.dirname, 'docs', 'ralph-backlog.md');

type RotationReason = 'completed-task' | 'plan-updated' | 'context-limit';

interface RalphConfig {
	/**
	 * Fresh-context thresholds keyed by provider/model. The default keeps
	 * existing projects working until a model receives an explicit setting.
	 */
	contextThresholds: Record<string, number>;
	autoApproveDecisions: boolean;
	maxIterations: number;
	/**
	 * Hide each finished iteration from the TUI at every rotation via an
	 * extension-provided compaction (no LLM call).
	 */
	compactionMode: boolean;
	/**
	 * The auto loop (state in _auto_.ralph, auto-created session category,
	 * ralph_auto tool, rotation on the context budget): off — nothing
	 * automatic; on — the loop starts at session start; auto — the loop arms
	 * itself when the context crosses the budget (at session start or
	 * mid-session) and records todos for the next iteration. A plain
	 * /ralph start uses the auto loop unless the mode is off (an explicit
	 * --goal start is unaffected).
	 */
	autoMode: AutoMode;
}

interface LegacyRalphConfig {
	contextThreshold: number;
	autoApproveDecisions: boolean;
	maxIterations?: number;
}

interface RalphState {
	/** The active model's threshold, retained for this Ralph session. */
	contextThreshold: number;
	autoApproveDecisions: boolean;
	enabled: boolean;
	/** Loop policy: the finite task backlog, the single goal, or the auto loop. */
	mode: 'tasks' | 'goal' | 'auto';
	todoPath: string;
	specPath: string;
	/** Backlog snapshot at the start of the current loop (never rotated). */
	loopStartTodo: string;
	baselineTodo: string;
	/** 1-based count of Ralph iterations started in this session. */
	iteration: number;
	/** 1-based count of iterations spent on the current TODO task. */
	taskIteration: number;
	/** The TODO task number (from countTodoTasks) that taskIteration refers to. */
	taskNumber?: number;
	maxIterations: number;
	rotationQueued: boolean;
	/** Why a fresh iteration is pending. Retained while a context checkpoint runs. */
	rotationReason?: RotationReason;
	/** The model is recording a durable checkpoint before the fresh iteration starts. */
	rotationCheckpointing: boolean;
	/** A stop was requested while the current iteration is still running. */
	stopRequested: boolean;
	/** The loop is paused (e.g. the user pressed Escape) and waits for /ralph resume. */
	paused: boolean;
	/** A decision requested through this session is awaiting the user's answer. */
	blocked: boolean;
	/** The precise decision question shown to the user and retained across reloads. */
	blockedItem?: string;
	/** Only tasks in this category count as open/complete (ralph-format backlogs). */
	category?: string;
	/** Task numbers that flipped to done for the pending completed-task rotation. */
	completedTasks?: string[];
}

function isRalphState(value: unknown): value is RalphState {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<RalphState>;
	return (
		typeof state.enabled === 'boolean' &&
		(state.mode === undefined || state.mode === 'tasks' || state.mode === 'goal' || state.mode === 'auto') &&
		typeof state.todoPath === 'string' &&
		typeof state.specPath === 'string' &&
		(state.loopStartTodo === undefined || typeof state.loopStartTodo === 'string') &&
		typeof state.baselineTodo === 'string' &&
		(state.iteration === undefined || (typeof state.iteration === 'number' && state.iteration >= 1)) &&
		(state.taskIteration === undefined || (typeof state.taskIteration === 'number' && state.taskIteration >= 1)) &&
		(state.taskNumber === undefined || (typeof state.taskNumber === 'number' && state.taskNumber >= 1)) &&
		(state.maxIterations === undefined || (typeof state.maxIterations === 'number' && state.maxIterations >= 1)) &&
		typeof state.contextThreshold === 'number' &&
		(state.autoApproveDecisions === undefined || typeof state.autoApproveDecisions === 'boolean') &&
		typeof state.rotationQueued === 'boolean' &&
		(state.rotationReason === undefined ||
			state.rotationReason === 'completed-task' ||
			state.rotationReason === 'plan-updated' ||
			state.rotationReason === 'context-limit') &&
		(state.rotationCheckpointing === undefined || typeof state.rotationCheckpointing === 'boolean') &&
		(state.stopRequested === undefined || typeof state.stopRequested === 'boolean') &&
		(state.paused === undefined || typeof state.paused === 'boolean') &&
		(state.blocked === undefined || typeof state.blocked === 'boolean') &&
		(state.blockedItem === undefined || typeof state.blockedItem === 'string') &&
			(state.category === undefined || typeof state.category === 'string') &&
			(state.completedTasks === undefined ||
				(Array.isArray(state.completedTasks) && state.completedTasks.every((value) => typeof value === 'string')))
	);
}

/** Keep sessions created before graceful stopping/blocking/configuration was added compatible. */
function normalizeState(state: RalphState): RalphState {
	return {
		...state,
		mode: state.mode ?? 'tasks',
		autoApproveDecisions: state.autoApproveDecisions ?? DEFAULT_AUTO_APPROVE_DECISIONS,
		iteration: state.iteration ?? 1,
		taskIteration: state.taskIteration ?? 1,
		maxIterations: state.maxIterations ?? DEFAULT_MAX_ITERATIONS,
		loopStartTodo: state.loopStartTodo ?? state.baselineTodo,
		rotationCheckpointing: state.rotationCheckpointing ?? false,
		stopRequested: state.stopRequested ?? false,
		paused: state.paused ?? false,
		blocked: state.blocked ?? false
	};
}

function isContextThreshold(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 1;
}

function isMaxIterations(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isAutoMode(value: unknown): value is AutoMode {
	return value === 'off' || value === 'on' || value === 'auto';
}

/** Accept the current string values plus the legacy boolean (true = auto, false = off). */
function normalizeAutoMode(value: unknown): AutoMode | undefined {
	if (isAutoMode(value)) return value;
	if (value === true) return 'auto';
	if (value === false) return 'off';
}

function isRalphConfig(value: unknown): value is RalphConfig {
	if (!value || typeof value !== 'object') return false;
	const config = value as Partial<RalphConfig>;
	return (
		!!config.contextThresholds &&
		typeof config.contextThresholds === 'object' &&
		Object.values(config.contextThresholds).every(isContextThreshold) &&
		typeof config.autoApproveDecisions === 'boolean' &&
		isMaxIterations(config.maxIterations) &&
		typeof config.compactionMode === 'boolean' &&
		isAutoMode(config.autoMode)
	);
}

/** A saved config missing newer optional fields; normalizeConfig fills the defaults. */
function isRalphConfigPartial(
	value: unknown
): value is Omit<RalphConfig, 'maxIterations' | 'compactionMode' | 'autoMode'> &
	Partial<Pick<RalphConfig, 'maxIterations' | 'compactionMode' | 'autoMode'>> {
	if (!value || typeof value !== 'object') return false;
	const config = value as Partial<RalphConfig>;
	return (
		!!config.contextThresholds &&
		typeof config.contextThresholds === 'object' &&
		Object.values(config.contextThresholds).every(isContextThreshold) &&
		typeof config.autoApproveDecisions === 'boolean' &&
		(config.maxIterations === undefined || isMaxIterations(config.maxIterations)) &&
		(config.compactionMode === undefined || typeof config.compactionMode === 'boolean') &&
		(config.autoMode === undefined || normalizeAutoMode(config.autoMode) !== undefined)
	);
}

function isLegacyRalphConfig(value: unknown): value is LegacyRalphConfig {
	if (!value || typeof value !== 'object') return false;
	const config = value as Partial<LegacyRalphConfig>;
	return (
		isContextThreshold(config.contextThreshold) &&
		typeof config.autoApproveDecisions === 'boolean' &&
		(config.maxIterations === undefined || isMaxIterations(config.maxIterations))
	);
}

function normalizeConfig(value: unknown): RalphConfig | undefined {
	if (isRalphConfig(value)) return value;
	if (isRalphConfigPartial(value)) {
		return {
			...value,
			maxIterations: value.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			compactionMode: value.compactionMode ?? DEFAULT_COMPACTION_MODE,
			autoMode: normalizeAutoMode(value.autoMode) ?? DEFAULT_AUTO_MODE
		};
	}
	if (isLegacyRalphConfig(value)) {
		return {
			contextThresholds: { [DEFAULT_MODEL_CONFIG_KEY]: value.contextThreshold },
			autoApproveDecisions: value.autoApproveDecisions,
			maxIterations: value.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			compactionMode: DEFAULT_COMPACTION_MODE,
			autoMode: DEFAULT_AUTO_MODE
		};
	}
}

function defaultConfig(): RalphConfig {
	return {
		contextThresholds: {},
		autoApproveDecisions: DEFAULT_AUTO_APPROVE_DECISIONS,
		maxIterations: DEFAULT_MAX_ITERATIONS,
		compactionMode: DEFAULT_COMPACTION_MODE,
		autoMode: DEFAULT_AUTO_MODE
	};
}

function modelConfigKey(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : DEFAULT_MODEL_CONFIG_KEY;
}

function contextThresholdFor(config: RalphConfig, ctx: ExtensionContext): number {
	return (
		config.contextThresholds[modelConfigKey(ctx)] ??
		config.contextThresholds[DEFAULT_MODEL_CONFIG_KEY] ??
		DEFAULT_CONTEXT_THRESHOLD
	);
}

function contextThresholdLabel(threshold: number): string {
	// Avoid showing insignificant floating-point precision while retaining a
	// user-entered fractional percentage.
	return `${Number((threshold * 100).toFixed(10))}%`;
}

function numericSettingSubmenu(
	label: string,
	currentValue: string,
	validate: (value: string) => string | undefined,
	done: (selectedValue?: string) => void
) {
	const input = new Input();
	// Feed the initial value through Input so its edit cursor starts at the end.
	input.handleInput(currentValue);
	// SettingsList delegates focus to its submenu, so keep the embedded input's
	// cursor visible while it is open.
	input.focused = true;
	input.onSubmit = (value) => {
		const normalized = validate(value);
		if (normalized === undefined) return;
		done(normalized);
	};
	input.onEscape = () => done(undefined);

	return {
		render: (width: number) => [
			...new Text(label, 0, 0).render(width),
			...input.render(width),
			...new Text('Enter to save · Esc to cancel', 0, 0).render(width)
		],
		invalidate: () => input.invalidate(),
		handleInput: (data: string) => input.handleInput(data)
	};
}

function contextUsageFraction(ctx: ExtensionContext): number | undefined {
	const percent = ctx.getContextUsage()?.percent;
	if (percent === null || percent === undefined) return undefined;
	// Pi reports percent as percentage points (e.g. 6.4 for 6.4%), while the
	// Ralph setting is stored as a fraction (e.g. 0.6 for 60%).
	return percent / 100;
}

function rightAlign(line: string, width: number): string {
	const fitted = truncateToWidth(line, width);
	return `${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`;
}

/**
 * Wrap the ' · '-separated status into lines that fit the width, keeping each
 * segment intact so the bar grows to multiple lines instead of truncating.
 */
function wrapStatusSegments(status: string, width: number): string[] {
	const lines: string[] = [];
	let current = '';
	for (const segment of status.split(' · ')) {
		const candidate = current ? `${current} · ${segment}` : segment;
		if (!current || visibleWidth(candidate) <= width) {
			current = candidate;
		} else {
			lines.push(current);
			current = segment;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function contextUsageLabel(ctx: ExtensionContext, threshold: number): string {
	const fraction = contextUsageFraction(ctx);
	if (fraction === undefined) return `calculating… / ${contextThresholdLabel(threshold)}`;
	const percentage = `${fraction * 100 < 10 ? (fraction * 100).toFixed(1) : Math.round(fraction * 100)}%`;
	return `${percentage} / ${contextThresholdLabel(threshold)}`;
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Number the task Ralph is currently working on so the status shows an
 * increasing counter (e.g. task 4/12 once three tasks are complete):
 * completed + 1, so the counter tracks work order even when tasks are
 * completed out of order or reference entries are interleaved.
 */
function countTodoTasks(todo: string, category?: string): { current: number; total: number } {
	const { open, total } = todoCounts(todo, category);
	return { current: open > 0 ? total - open + 1 : total, total };
}

/**
 * The current task number for RalphState, or undefined when no task is
 * current (goal mode with an exhausted plan): task numbers are 1-based.
 */
function currentTaskNumber(current: number): number | undefined {
	return current > 0 ? current : undefined;
}

function hasCompletedTodoItem(previousTodo: string, currentTodo: string, category?: string): boolean {
	return todoCounts(currentTodo, category).completed > todoCounts(previousTodo, category).completed;
}

/**
 * Identify the tasks that flipped from open to completed between two snapshots
 * of a ralph-format backlog, addressed by their position number in the newer
 * snapshot. Returns undefined for non-ralph formats or parse failures so
 * callers can fall back to the generic identification wording.
 */
function completedTaskNumbers(previousTodo: string, currentTodo: string, category?: string): string[] | undefined {
	if (!isRalphBacklog(previousTodo) || !isRalphBacklog(currentTodo)) return undefined;
	try {
		const previousDone = new Map(Backlog.parse(previousTodo).listTasks().map((task) => [task.id, task.done]));
		const current = Backlog.parse(currentTodo);
		const numbers = current.taskNumbers(category);
		const completed = current
			.listTasks(category)
			.filter((task) => task.done && previousDone.get(task.id) !== true)
			.map((task) => numbers.get(task.id))
			.filter((number): number is string => number !== undefined);
		return completed.length > 0 ? completed : undefined;
	} catch {
		return undefined;
	}
}

/** A Ralph backlog is finished when it has no open tasks (Markdown: no unchecked boxes). */
function isBacklogFinished(todo: string, category?: string): boolean {
	return todoCounts(todo, category).open === 0;
}

/**
 * The auto mode's reference entries: "Goal: " big-picture tracking tasks and
 * "Findings: " notes from earlier iterations are not work items. ralph_auto
 * "next" skips them so an iteration never stalls on a reference entry.
 */
function isReferenceTaskTitle(title: string): boolean {
	return title.startsWith('Goal: ') || title.startsWith('Findings: ');
}

/**
 * Open work tasks in a ralph backlog snapshot (reference entries excluded),
 * optionally scoped to a category. Non-ralph formats and parse failures
 * count as zero.
 */
function openWorkTaskCount(todo: string, category?: string): number {
	if (!isRalphBacklog(todo)) return 0;
	try {
		return Backlog.parse(todo)
			.listTasks(category)
			.filter((task) => !task.done && !isReferenceTaskTitle(task.title)).length;
	} catch {
		return 0;
	}
}

type GoalPhase = 'planning' | 'execution' | 're-evaluation';

/**
 * The goal-loop phase for the state's baseline backlog: planning (goal open,
 * zero tasks), execution (open tasks), or re-evaluation (goal open, tasks
 * exist, none open). Undefined outside a goal loop on a ralph backlog with a
 * goal, so callers fall back to the task-loop prompts.
 */
function goalPhase(state: RalphState): { phase: GoalPhase; goal: Goal } | undefined {
	if (state.mode !== 'goal' || !isRalphBacklog(state.baselineTodo)) return undefined;
	try {
		const backlog = Backlog.parse(state.baselineTodo);
		const goal = backlog.goal();
		if (!goal) return undefined;
		const counts = backlog.counts(state.category);
		if (counts.total === 0) return { phase: 'planning', goal };
		if (counts.open === 0) return { phase: 're-evaluation', goal };
		return { phase: 'execution', goal };
	} catch {
		return undefined;
	}
}

/** The goal contract shown to the model in every goal-loop prompt. */
function goalBlock(goal: Goal): string {
	const lines = [`The goal is "${goal.title}" (status: ${goal.status}).`];
	if (goal.body) lines.push(goal.body.trim());
	if (goal.checkpoint) {
		lines.push(`Goal checkpoint (iteration ${goal.checkpointIteration ?? '?'}): ${goal.checkpoint}`);
	}
	return lines.join('\n');
}

/**
 * The goal's status in a backlog snapshot, or undefined when the file is not a
 * ralph backlog, has no goal, or fails to parse. Used by the goal loop to
 * detect goal completion (done) and the stall state (open) from the file.
 */
function goalStatus(todo: string): GoalStatus | undefined {
	if (!isRalphBacklog(todo)) return undefined;
	try {
		return Backlog.parse(todo).goal()?.status;
	} catch {
		return undefined;
	}
}

/**
 * Whether the plan grew between two snapshots: a task that is open in the newer
 * snapshot but was not open in the older one (a new task, or a previously
 * completed task re-opened). The goal loop uses this to tell a progress turn
 * (the plan grew) from a stalled one, and to trigger a plan-updated rotation.
 */
function planGrew(previousTodo: string, currentTodo: string, category?: string): boolean {
	if (!isRalphBacklog(previousTodo) || !isRalphBacklog(currentTodo)) return false;
	try {
		const previousOpen = new Set(
			Backlog.parse(previousTodo)
				.listTasks(category)
				.filter((task) => !task.done)
				.map((task) => task.id)
		);
		return Backlog.parse(currentTodo)
			.listTasks(category)
			.some((task) => !task.done && !previousOpen.has(task.id));
	} catch {
		return false;
	}
}

/**
 * Backlog statistics for either supported TODO format (Markdown or the
 * ralph text format backed by SQLite), optionally scoped to one category.
 */
function todoCounts(todo: string, category?: string): { open: number; total: number; completed: number } {
	if (isRalphBacklog(todo)) {
		return Backlog.parse(todo).counts(category);
	}
	const open = (todo.match(/^\s*- \[ \]\s+/gm) ?? []).length;
	const total = (todo.match(/^\s*- \[[ xX]\]\s+/gm) ?? []).length;
	return { open, total, completed: total - open };
}

/**
 * The decision tool result already contains the full question and evidence.
 * Keep the persistent editor widget to a short state reminder rather than
 * duplicating that potentially large content.
 */
function decisionWidgetLines(): string[] {
	return [
		'Ralph is paused — awaiting your decision.',
		'Review the decision request above, then reply below to continue.',
		'Use /ralph stop to end the loop without deciding.'
	];
}

function formatDecisionMessage(question: string, context?: string): string {
	const quotedQuestion = question
		.trim()
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
		.join('\n');

	return [
		'# Ralph is paused',
		'',
		'## Decision required',
		'',
		quotedQuestion,
		...(context ? ['', '## Proposal, evidence, and options', '', context.trim()] : []),
		'',
		'---',
		'',
		'**Next step:** Reply below with your decision. Ralph will document it before continuing.'
	].join('\n');
}

function iterationPrompt(state: RalphState, reason?: RotationReason): string {
	if (state.mode === 'auto') {
		const contextNote =
			reason === 'context-limit'
				? 'The previous iteration reached its context budget and finished up: the remaining work is recorded as todo entries in your session category. Re-establish facts from the repository and the backlog before continuing; do not rely on the old conversation. The backlog also carries "Findings: " entries with what the previous iteration learned, and DEBUG.md at the project root may carry durable debug findings — read them before starting work instead of rediscovering what they already establish.'
				: 'This is the first iteration of the Ralph auto loop in this session. Start with a clean review of the repository.';
		// From the second iteration on, the backlog also carries the big-picture
		// layer ("Goal: " tracking tasks) and the findings layer ("Findings: "
		// reference notes from earlier iterations).
		const referenceTaskNote =
			state.iteration > 1
				? ' Tasks whose title starts with "Goal: " or "Findings: " are not work items, and "next" skips them: Goal tasks are big-picture tracking tasks (complete one only when its objective is actually met, with evidence), and Findings entries are reference notes from earlier iterations. Read the open Findings entries before starting work, then mark each one done with ralph_auto (action "complete") so the backlog does not accumulate open reference entries.'
				: '';
		const bigGoalMaintenance =
			state.iteration > 1
				? `
Keep the big picture in the backlog: if no open task in your category starts with "Goal: ", add the larger remaining objectives this work serves with ralph_auto (action "add", title "Goal: <objective>", body with the acceptance evidence to look for).`
				: '';
		return `Run the Ralph auto loop for this repository. ${contextNote}

The backlog is the SQLite-backed file ${state.todoPath} (ralph format). Read and update it only through the ralph_auto tool — never read or modify it by any other means (no file tools, no grep/cat/sed or other shell commands on the file). Your session's todos live in category "${state.category}".

1. Call ralph_auto with action "next" to get the next open work task in your session category.${referenceTaskNote}
2. If there is an open task: read the relevant code and source evidence, then implement exactly one coherent vertical slice. Add focused tests and run every quality command required by the backlog and ${state.specPath} (when present).
3. Only after all acceptance criteria pass, call ralph_auto with action "complete", the task's number, and a concise note: outcome, changed paths, evidence, and the verification commands that were run. The note becomes the completion log entry — the single completion record.
4. After completing a task, immediately go back to step 1 and start the next open task. Keep working task after task: this iteration only ends when you are told to finish up (context budget) or when no open tasks remain. Do not stop after a completed task while open tasks remain.
5. If there are no open tasks, do the work the user asks for in chat; do not invent backlog work.${bigGoalMaintenance}
Keep the project's knowledge current as you learn: append durable debug findings (root causes, failed approaches, environment quirks) to DEBUG.md at the project root (create it if missing), and update SPEC.md (create it if missing) when the project's requirements, architecture, or quality bar has changed or is not yet documented.

When this iteration reaches its context budget you will be told to finish up: it is OK to leave the code in a bad state — record the remaining work and the important findings as todo entries for the next iteration with ralph_auto (action "add"), and stop. The fresh iteration continues from the backlog.`;
	}

	const contextNote =
		reason === 'context-limit'
			? 'The previous iteration reached its context budget and recorded a durable TODO checkpoint. Re-establish facts from the repository and TODO before continuing; do not rely on the old conversation.'
			: reason === 'completed-task'
				? 'A previous TODO item was completed. Start the next independent iteration with a clean review of the repository.'
				: reason === 'plan-updated'
					? 'The plan was just updated with new tasks. Start the next independent iteration with a clean review of the repository and the updated plan.'
					: 'This is the first iteration of the Ralph loop in this session. Start with a clean review of the repository.';

	const decisionNote = `If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, do not guess and do not use ${state.todoPath} as an unblock mechanism. Call the ralph_request_decision tool with one precise question and the relevant evidence. ${state.autoApproveDecisions ? 'Decision auto-approval is enabled: the tool will not pause Ralph. Treat this as delegated approval to select a safe resolution, document the decision, approver (auto-approved), rationale, and evidence in versioned documentation, then continue the blocked work. Do not call ralph_resolve_decision.' : 'It pauses Ralph in this session and presents the question to the user. After the user answers, discuss any remaining ambiguity with them. When the decision is clear, record the decision, approver (the user), rationale, and evidence in the appropriate versioned documentation; update any related TODO decision item only as an audit record; then call ralph_resolve_decision with the recorded path and continue the blocked work.'}`;

	if (isRalphBacklog(state.baselineTodo)) {
		const goalInfo = goalPhase(state);
		if (goalInfo) {
			const { phase, goal } = goalInfo;
			const backlogNote = `The backlog is the SQLite-backed file ${state.todoPath} (ralph format). Read and update it only through the ralph_todo tool — never read or modify it by any other means (no file tools, no grep/cat/sed or other shell commands on the file). Use ralph_todo action "search" to find tasks by keyword.`;
			const categoryScope = state.category ? ` in category "${state.category}"` : '';
			const categoryGuard = state.category ? ' or on a task in another category' : '';

			if (phase === 'planning') {
				return `Run the Ralph goal loop for this repository. ${contextNote}

${backlogNote}

${goalBlock(goal)}

This is a planning iteration: the goal is open and the backlog has no tasks yet.

1. Read ${state.specPath} in full.
2. Decompose the goal into small, ordered tasks that together cover every acceptance criterion.
3. Create a list for the plan with ralph_todo (action "new-list"), then add the whole plan to that list (action "add-many" with the list as category, or "add" per task).
4. Do not implement the goal in this iteration: the plan is the deliverable. Do not edit ${state.todoPath} directly.

${decisionNote}`;
			}
			if (phase === 're-evaluation') {
				return `Run the Ralph goal loop for this repository. ${contextNote}

${backlogNote}

${goalBlock(goal)}

This is a re-evaluation iteration: the goal is open and every planned task is complete.

1. Read ${state.specPath} in full.
2. Re-check every acceptance criterion of the goal against the repository and run every verification command required by SPEC.md.
3. If any criterion is not met, add tasks for the missing work with ralph_todo (the plan's list as category) and stop after recording them.
4. If every criterion is met and verified, call ralph_goal with action "complete" and the evidence. Do not edit ${state.todoPath} directly.

${decisionNote}`;
			}
			return `Run the Ralph goal loop for this repository. ${contextNote}

${backlogNote}

${goalBlock(goal)}

You are executing the goal: keep the plan honest — when reality diverges from the plan, add or adjust tasks with ralph_todo (the plan's list as category) so the backlog always reflects the remaining work.

1. Read ${state.specPath} in full, then call ralph_todo with action "next" to get the next open task${categoryScope}: its number, body, and checkpoint. Use action "list" only when that task is blocked and you need the wider backlog to find an unblocked one.
2. Do not work on a later task${categoryGuard}.
3. Read the relevant code and source evidence, then implement exactly one coherent vertical slice.
4. Add focused tests and run every quality command required by SPEC.md and the backlog.
5. Only after all acceptance criteria pass, call ralph_todo with action "complete", the task's number, and a concise note: outcome, changed paths, evidence, and the verification commands that were run. The note becomes the completion log entry — the single completion record — so do not call action "log" separately. Do not edit ${state.todoPath} directly.
6. Finally, commit the completed iteration locally in a single commit that also includes the ${state.todoPath} update. Do not push. This is the last step of the iteration: stop working when the commit is made.

${decisionNote}`;
		}

		const categoryScope = state.category ? ` in category "${state.category}"` : '';
		return `Run the Ralph loop for this repository. ${contextNote}

The backlog is the SQLite-backed file ${state.todoPath} (ralph format). Read and update it only through the ralph_todo tool — never read or modify it by any other means (no file tools, no grep/cat/sed or other shell commands on the file). Use ralph_todo action "search" to find tasks by keyword.

1. Read ${state.specPath} in full, then call ralph_todo with action "next" to get the next open task${categoryScope}: its number, body, and checkpoint. Use action "list" only when that task is blocked and you need the wider backlog to find an unblocked one.
2. Do not work on a later task${state.category ? ' or on a task in another category' : ''}.
3. Read the relevant code and source evidence, then implement exactly one coherent vertical slice.
4. Add focused tests and run every quality command required by SPEC.md and the backlog.
5. Only after all acceptance criteria pass, call ralph_todo with action "complete", the task's number, and a concise note: outcome, changed paths, evidence, and the verification commands that were run. The note becomes the completion log entry — the single completion record — so do not call action "log" separately. Do not edit ${state.todoPath} directly.
6. Finally, commit the completed iteration locally in a single commit that also includes the ${state.todoPath} update. Do not push. This is the last step of the iteration: stop working when the commit is made.

${decisionNote}`;
	}

	return `Run the Ralph loop for this repository. ${contextNote}

1. Read ${state.specPath} and ${state.todoPath} in full.
2. Select the highest-priority unblocked unchecked TODO item. Do not work on a later item.
3. Read the relevant code and source evidence, then implement exactly one coherent vertical slice.
4. Add focused tests and run every quality command required by SPEC.md and TODO.md.
5. Only after all acceptance criteria pass, update ${state.todoPath}: check the completed item and add exactly one dated, concise entry for it to the completion log (outcome, changed paths, evidence, verification commands). The completion log is the single completion record: do not also add a completion note under the checked item itself.
6. Finally, commit the completed iteration locally in a single commit that also includes the ${state.todoPath} update. Do not push. This is the last step of the iteration: stop working when the commit is made.

${decisionNote}`;
}

/**
 * Compact summary of the progress made in the current loop, re-derived by
 * diffing the backlog against the snapshot taken when the loop started:
 * tasks completed in this loop (with the completion log entries added in this
 * loop), tasks checkpointed in this loop, and the goal checkpoint when it
 * changed. Tasks completed before the loop started stay out. Used as the text
 * of the ralph-provided compaction at each rotation and as the visible custom
 * message injected at the start of each fresh Ralph iteration. At rotations it
 * is sent before the context boundary, so it stays in the session (audit
 * trail, TUI) but is dropped from the model context — the model checks its own
 * progress with the ralph_todo/ralph_goal tools.
 */
function completionSummary(todo: string, loopStartTodo: string, category?: string): string | undefined {
	if (!isRalphBacklog(todo)) return undefined;
	const backlog = Backlog.parse(todo);
	const baseline = isRalphBacklog(loopStartTodo) ? Backlog.parse(loopStartTodo) : undefined;
	const baselineDone = new Map<number, boolean>();
	const baselineCheckpoints = new Map<number, string | null>();
	const baselineEntryIds = new Set<number>();
	const baselineGoalCheckpoint = baseline?.goal()?.checkpoint ?? null;
	if (baseline) {
		for (const task of baseline.listTasks(category)) {
			baselineDone.set(task.id, task.done);
			baselineCheckpoints.set(task.id, task.checkpoint);
		}
		for (const entry of baseline.listLogEntries()) baselineEntryIds.add(entry.id);
	}
	const newEntriesByTask = new Map<number, CompletionEntry[]>();
	for (const entry of backlog.listLogEntries()) {
		if (baselineEntryIds.has(entry.id)) continue;
		const list = newEntriesByTask.get(entry.taskId) ?? [];
		list.push(entry);
		newEntriesByTask.set(entry.taskId, list);
	}
	const numbers = backlog.taskNumbers(category);
	const completionLines: string[] = [];
	const checkpointLines: string[] = [];
	backlog.listTasks(category).forEach((task, index) => {
		const number = numbers.get(task.id) ?? String(index + 1);
		const newEntries = newEntriesByTask.get(task.id) ?? [];
		const wasDone = baseline ? (baselineDone.get(task.id) ?? false) : false;
		if (task.done && (!wasDone || newEntries.some((entry) => entry.kind === 'done'))) {
			if (newEntries.length === 0) {
				completionLines.push(`${number}. ${task.title}: completed (no completion log entry)`);
				return;
			}
			const notes = newEntries
				.map((entry) => `${entry.date ? `(${entry.date}) ` : ''}${entry.kind === 'reopen' ? 'reopened: ' : ''}${entry.note}`)
				.join('; ');
			completionLines.push(`${number}. ${task.title}: ${notes}`);
		}
		const previousCheckpoint = baseline ? (baselineCheckpoints.get(task.id) ?? null) : null;
		if (task.checkpoint !== null && task.checkpoint !== previousCheckpoint) {
			checkpointLines.push(
				`${number}. ${task.title}: checkpoint${task.checkpointIteration ? ` (iteration ${task.checkpointIteration})` : ''}: ${task.checkpoint}`
			);
		}
	});
	const goal = backlog.goal();
	const goalCheckpoint = goal?.checkpoint ?? null;
	if (goalCheckpoint !== null && goalCheckpoint !== baselineGoalCheckpoint) {
		checkpointLines.push(
			`Goal "${goal?.title ?? ''}": checkpoint${goal?.checkpointIteration ? ` (iteration ${goal.checkpointIteration})` : ''}: ${goalCheckpoint}`
		);
	}
	if (completionLines.length === 0 && checkpointLines.length === 0) return undefined;
	const parts = [
		completionLines.length > 0 ? `Completed in this loop:\n${completionLines.join('\n')}` : undefined,
		checkpointLines.length > 0 ? `Checkpoints in this loop:\n${checkpointLines.join('\n')}` : undefined
	].filter((part): part is string => part !== undefined);
	return `Ralph loop: progress in this loop, from the backlog's completion log and checkpoints:\n\n${parts.join('\n\n')}`;
}

/**
 * Sent when a paused loop is resumed without a pending rotation: the current
 * iteration continues from the durable state instead of starting over.
 */
function resumePrompt(state: RalphState): string {
	return `The Ralph loop was paused and is now resumed. Continue the current iteration exactly where the interrupted turn left off. Re-read ${state.todoPath} and the repository as the source of truth, verify what is already done, and proceed with the remaining work of the current task.`;
}

function contextCheckpointPrompt(state: RalphState): string {
	if (isRalphBacklog(state.baselineTodo)) {
		// Task-less goal iterations (planning/re-evaluation) have no task to
		// checkpoint: the goal carries the durable state instead.
		const goalInfo = goalPhase(state);
		if (goalInfo && goalInfo.phase !== 'execution') {
			return `The current Ralph goal iteration has reached its configured context budget. Create a durable checkpoint now, then stop working; a fresh Ralph iteration will continue from the files. This is iteration ${state.iteration} of ${state.maxIterations}.

1. Call ralph_goal with action "checkpoint" and a concise note: planning or re-evaluation evidence so far, relevant changed paths, known failures or risks, and the exact next step. The tool replaces any older checkpoint: keep only the single most recent one, because an older checkpoint's state and next step are stale.
2. Keep a single exact next step in the checkpoint note.
3. Do not change the goal's state, do not claim unverified work, do not modify product code, and do not commit. Do not continue work after recording the checkpoint.

Report the checkpoint and the next step succinctly.`;
		}
		return `The current Ralph iteration has reached its configured context budget. Create a durable checkpoint now, then stop working; a fresh Ralph iteration will continue from the files. This is iteration ${state.iteration} of ${state.maxIterations} (iteration ${state.taskIteration} for the current task).

1. Call ralph_todo with action "list" and identify the currently selected open task.
2. Call ralph_todo with action "checkpoint", the task's number, and a concise note: completed implementation/test evidence, relevant changed paths, known failures or risks, and the exact next step. The tool replaces any older checkpoint: keep only the single most recent one, because an older checkpoint's state and next step are stale. Do not record this in the completion log: the task is not complete.
3. Keep a single exact next step in the checkpoint note.
4. Do not mark the task complete, do not claim unverified work, do not modify product code, and do not commit. Do not continue implementation after recording the checkpoint.

Report the checkpoint and the next step succinctly.`;
	}
	return `The current Ralph iteration has reached its configured context budget. Create a durable checkpoint now, then stop working; a fresh Ralph iteration will continue from the files. This is iteration ${state.iteration} of ${state.maxIterations} (iteration ${state.taskIteration} for the current task).

1. Read ${state.todoPath} and identify the currently selected unchecked item.
2. Update that item in ${state.todoPath} with a concise, non-checkbox “Context checkpoint (iteration ${state.iteration})” note. Include completed implementation/test evidence, relevant changed paths, known failures or risks, and the exact next step. Use the actual iteration number shown above in the label — never a placeholder. If the item already has a “Context checkpoint” note, replace it with this one: keep only the single most recent checkpoint, because an older checkpoint’s state and next step is stale. Do not put this in the completion log: the item is not complete.
3. Keep a single exact next step in the checkpoint note.
4. Do not mark the item complete, do not claim unverified work, do not modify product code, and do not commit. Do not continue implementation after recording the checkpoint.

Report the checkpoint path and the next step succinctly.`;
}

/**
 * The auto-mode rotation prompt: sent as the dedicated finish-up turn when the
 * iteration reaches its context budget. Finishing the handoff matters more
 * than a clean state: the model may leave the code in a bad state and records
 * the remaining work as todo entries
 * for the next iteration in the auto-created session category; from the second
 * iteration on it also keeps the big-picture ("Goal: ") tracking tasks in the
 * backlog. The settled turn starts the fresh iteration.
 */
function autoFinishPrompt(state: RalphState): string {
	// From the second iteration on, the handoff also refreshes the big-picture
	// layer: the first round establishes what the work is about, the later
	// rounds keep the larger objectives visible in the backlog.
	const bigPicture =
		state.iteration > 1
			? `
4. Keep the big picture in the backlog: for each larger remaining objective this work serves (not the immediate next step), check whether an open task whose title starts with "Goal: " covers it; if it is missing, add it with ralph_auto (action "add", title "Goal: <objective>", body with the acceptance evidence to look for). Big-picture tasks are tracking tasks, not next steps.`
			: '';
	return `The current Ralph auto iteration has reached its configured context budget. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog. This is iteration ${state.iteration} of ${state.maxIterations}.

1. Wrap up what you are doing. Finishing this handoff matters more than a clean state: it is OK to leave the code in a bad state (half-applied edits, failing builds, untested changes) — the next iteration will re-establish the facts and fix it. Mark any finished task complete with ralph_auto (action "complete", with a concise note).
2. Record the remaining work for the next iteration: call ralph_auto with action "add" (title, optional body) for each todo entry in category "${state.category}". Each entry must be self-contained for a fresh session that has none of this conversation: what remains, why, relevant paths, the current state of the code (including anything broken or half-done), the debugging findings that bear on it (root causes found, approaches tried that failed, current build/test state), and the exact next step.
3. Log the important findings for the next iteration: call ralph_auto with action "add" (title "Findings: <short summary>", body as markdown bullets) for what this iteration learned that a fresh session would otherwise have to rediscover from scratch: root causes, approaches tried that failed and why, environment or tooling quirks, and key code locations with their current state. One entry per coherent cluster of findings; skip trivialities. Findings entries are reference notes, not work items. Findings of lasting value beyond the next iteration also belong in the repository: append them to DEBUG.md at the project root (create it if missing, organized by topic), and update SPEC.md (create it if missing) when the project's requirements, architecture, or quality bar has changed.
${bigPicture}
Finally: do not start new work after recording the todos.

Report the recorded todos and findings succinctly.`;
}

/**
 * Sent as the dedicated progress-recording turn before a fresh iteration after
 * a completed task: the completion record and the local commit must exist before
 * the next iteration starts.
 */
function completionRecordingPrompt(state: RalphState): string {
	if (isRalphBacklog(state.baselineTodo)) {
		const numbers = state.completedTasks ?? [];
		if (numbers.length > 0) {
			const singular = numbers.length === 1;
			const target = singular ? `task ${numbers[0]}` : `tasks ${numbers.join(', ')}`;
			return `A Ralph TODO task was just completed: ${target}. Verify its progress record now, then stop working; a fresh Ralph iteration will start after this turn.

1. Call ralph_todo with action "list" and ${singular ? 'the task\'s number' : 'each task\'s number'} to check the completion log. If ${singular ? 'the task' : 'a task'} already has a completion log entry (for example, recorded by the "complete" call), do not add another. Only if the entry is missing, call ralph_todo with action "log" for ${target}, today's date, and exactly one concise ${singular ? 'entry' : 'entry per task'}: outcome, changed paths, evidence, and the verification commands that were run. Do not modify any other task.
2. Check git status. If the completed work or the ${state.todoPath} update is not committed locally, commit it with a concise message. Do not push.
3. Do not start work on the next TODO task and do not modify product code beyond the completion record.

Report the completion log ${singular ? 'entry' : 'entries'} (existing or newly recorded) and the commit (if any) succinctly.`;
		}
		return `A Ralph TODO task was just completed. Verify its progress record now, then stop working; a fresh Ralph iteration will start after this turn.

1. Call ralph_todo with action "list" and identify the task that was just completed (the one you marked complete in the previous turn). Check its completion log: if it already has a completion log entry (for example, recorded by the "complete" call), do not add another. Only if the entry is missing, call ralph_todo with action "log", the task's number, today's date, and exactly one concise entry: outcome, changed paths, evidence, and the verification commands that were run. Do not modify any other task.
2. Check git status. If the completed work or the ${state.todoPath} update is not committed locally, commit it with a concise message. Do not push.
3. Do not start work on the next TODO task and do not modify product code beyond the completion record.

Report the completion log entry (existing or newly recorded) and the commit (if any) succinctly.`;
	}
	return `A Ralph TODO item was just completed. Record its progress now, then stop working; a fresh Ralph iteration will start after this turn.

1. Read ${state.todoPath} and identify the item that was just checked.
2. Ensure the completion log has exactly one dated, concise entry for it: outcome, changed paths, evidence, and the verification commands that were run. Add or correct the entry if it is missing or incomplete. The completion log is the single completion record: if a completion note was also added under the checked item itself, remove it. Do not modify any other TODO item.
3. Check git status. If the completed work or the ${state.todoPath} update is not committed locally, commit it with a concise message. Do not push.
4. Do not start work on the next TODO item and do not modify product code beyond the completion record.

Report the recorded entry and the commit (if any) succinctly.`;
}

/**
 * Sent as the dedicated recording turn before a fresh iteration after the goal
 * plan grew: the plan update must be committed locally before the next
 * iteration starts, but no completion log entry is written because no task
 * was completed in the turn.
 */
function planRecordingPrompt(state: RalphState): string {
	return `The Ralph plan was just updated: new tasks were added to the backlog. Commit the updated plan now, then stop working; a fresh Ralph iteration will start after this turn.

1. Check git status. If the updated plan (or any other uncommitted work from this iteration) is not committed locally, commit it with a concise message. Do not push.
2. Do not add a completion log entry: no task was completed in this iteration.
3. Do not start work on the new tasks and do not modify product code beyond the commit.

Report the commit (if any) succinctly.`;
}

async function readRequiredFile(path: string): Promise<string> {
	return readFile(path, 'utf8');
}

/** Parse command arguments, supporting quoted paths that contain spaces. */
function parseCommandArguments(args: string): string[] | undefined {
	const values: string[] = [];
	let index = 0;

	while (index < args.length) {
		while (/\s/.test(args[index] ?? '')) index += 1;
		if (index >= args.length) break;

		const quote = args[index];
		if (quote === '"' || quote === "'") {
			const end = args.indexOf(quote, index + 1);
			if (end === -1) return undefined;
			values.push(args.slice(index + 1, end));
			index = end + 1;
			if (index < args.length && !/\s/.test(args[index])) return undefined;
			continue;
		}

		const end = args.slice(index).search(/\s/);
		if (end === -1) {
			values.push(args.slice(index));
			break;
		}
		values.push(args.slice(index, index + end));
		index += end;
	}

	return values;
}

interface RalphStartFiles {
	specFile: string;
	todoFile: string;
	category?: string;
	/** Start the goal loop instead of the task loop. */
	goal: boolean;
}

interface RalphInitFiles {
	specFile?: string;
	todoFile?: string;
	force: boolean;
	prompt: string;
	/** Initialize for the goal loop: the backlog gets the goal from the brief. */
	goal: boolean;
}

/** Parse explicit file options so either default may be overridden independently. */
function parseStartFiles(args: string[]): RalphStartFiles | undefined {
	let specFile = DEFAULT_SPEC;
	let todoFile = DEFAULT_TODO;
	let category: string | undefined;
	let goal = false;

	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === '--goal') {
			if (goal) return undefined;
			goal = true;
			continue;
		}
		if (option !== '--spec' && option !== '--todo' && option !== '--category') return undefined;
		const path = args[index + 1];
		if (!path || path.startsWith('--')) return undefined;
		if (option === '--spec') specFile = path;
		else if (option === '--todo') todoFile = path;
		else category = path;
		index += 1;
	}

	return { specFile, todoFile, category, goal };
}

/**
 * Parse an init request. When neither output option is supplied, use both
 * conventional files; when one or both are supplied, use exactly those named
 * files. The specification is generated by the LLM from the project brief (a
 * brief is required whenever a spec is requested); the ralph-format backlog is
 * created directly as an empty backlog, or — with --goal — as a backlog whose
 * single goal is derived from the brief (so a brief is always required with
 * --goal). `--` permits a brief that starts with an option-looking word.
 */
function parseInitFiles(args: string[]): RalphInitFiles | undefined {
	let specFile: string | undefined;
	let todoFile: string | undefined;
	let force = false;
	let goal = false;
	let index = 0;

	for (; index < args.length; index += 1) {
		const option = args[index];
		if (option === '--') {
			index += 1;
			break;
		}
		if (!option.startsWith('--')) break;
		if (option === '--force') {
			if (force) return undefined;
			force = true;
			continue;
		}
		if (option === '--goal') {
			if (goal) return undefined;
			goal = true;
			continue;
		}
		if (option !== '--spec' && option !== '--todo') return undefined;
		const path = args[index + 1];
		if (!path || path.startsWith('--')) return undefined;
		if (option === '--spec') {
			if (specFile) return undefined;
			specFile = path;
		} else {
			if (todoFile) return undefined;
			todoFile = path;
		}
		index += 1;
	}

	const resolvedSpec = specFile ?? (todoFile ? undefined : DEFAULT_SPEC);
	const resolvedTodo = todoFile ?? (specFile ? undefined : DEFAULT_TODO);
	const prompt = args.slice(index).join(' ').trim();
	if ((resolvedSpec || goal) && !prompt) return undefined;
	return {
		specFile: resolvedSpec,
		todoFile: resolvedTodo,
		force,
		prompt,
		goal
	};
}

/**
 * Derive the goal record of a --goal init from the project brief: the first
 * line is the title, the full brief is the body (omitted when it adds nothing
 * beyond the title). The user reviews and edits the goal before starting the
 * goal loop; this is only the initial contract.
 */
function goalFromBrief(brief: string): { title: string; body?: string } {
	const trimmed = brief.trim();
	const firstLine = trimmed.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? trimmed;
	const body = trimmed === firstLine ? undefined : trimmed;
	return { title: firstLine, body };
}

interface RalphSetGoalArgs {
	goalFile: string;
	todoFile?: string;
}

/** Parse `set-goal <goal-file> [--todo <backlog-file>]`. */
function parseSetGoalArgs(args: string[]): RalphSetGoalArgs | undefined {
	let goalFile: string | undefined;
	let todoFile: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--todo') {
			const path = args[index + 1];
			if (!path || path.startsWith('--')) return undefined;
			if (todoFile) return undefined;
			todoFile = path;
			index += 1;
			continue;
		}
		if (arg.startsWith('--')) return undefined;
		if (goalFile) return undefined;
		goalFile = arg;
	}
	if (!goalFile) return undefined;
	return { goalFile, todoFile };
}

/**
 * Derive the goal record of a set-goal file: the first non-empty line is the
 * title (a leading `# ` H1 marker is stripped), the remaining lines are the
 * body (omitted when empty). Unlike goalFromBrief the body does not repeat
 * the title line, which the G record already stores.
 */
function goalFromFile(text: string): { title: string; body?: string } | undefined {
	const trimmed = text.trim();
	const lines = trimmed.split(/\r?\n/);
	const firstIndex = lines.findIndex((line) => line.trim() !== '');
	if (firstIndex === -1) return undefined;
	const firstLine = lines[firstIndex]!.trim();
	const h1 = firstLine.match(/^#\s+(.*)$/);
	const title = (h1?.[1] ?? firstLine).trim();
	if (!title) return undefined;
	const body = lines.slice(firstIndex + 1).join('\n').trim();
	return { title, body: body || undefined };
}

interface SetGoalOutcome {
	ok: boolean;
	level: 'info' | 'warning' | 'error';
	message: string;
}

/**
 * Set the single goal of a ralph-format backlog from a goal file. The target
 * backlog is the explicit --todo file, else the active loop's backlog, else
 * the conventional TODO.ralph. An existing goal must be open (a claimed or
 * done goal must be resolved first); setting replaces the title and body.
 */
async function setGoalFromFile(cwd: string, loopState: RalphState | undefined, args: RalphSetGoalArgs): Promise<SetGoalOutcome> {
	const goalPath = resolveProjectFile(cwd, args.goalFile);
	if (!goalPath) {
		return { ok: false, level: 'warning', message: 'The goal file must be a relative file inside the project' };
	}
	const todoPath = args.todoFile
		? resolveProjectFile(cwd, args.todoFile)
		: loopState?.enabled
			? loopState.todoPath
			: resolve(cwd, DEFAULT_TODO);
	if (!todoPath) {
		return { ok: false, level: 'warning', message: 'The backlog file must be a relative file inside the project' };
	}
	if (goalPath === todoPath) {
		return { ok: false, level: 'warning', message: 'The goal file and the backlog must be different files' };
	}
	const outName = relative(cwd, todoPath) || todoPath;
	let text: string;
	try {
		text = await readFile(goalPath, 'utf8');
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not read ${args.goalFile}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const goal = goalFromFile(text);
	if (!goal) {
		return {
			ok: false,
			level: 'error',
			message: `No goal in ${args.goalFile}: the first non-empty line must be a title (optionally an H1 heading)`
		};
	}
	let todo: string;
	try {
		todo = await readFile(todoPath, 'utf8');
	} catch {
		return {
			ok: false,
			level: 'error',
			message: `No backlog at ${outName} — create it first (e.g. /ralph-init --todo ${outName}) or pass --todo <file>`
		};
	}
	if (!isRalphBacklog(todo)) {
		return { ok: false, level: 'error', message: `${outName} is not a ralph-format backlog` };
	}
	let backlog: Backlog;
	try {
		backlog = Backlog.parse(todo);
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not parse ${outName}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const existing = backlog.goal();
	if (existing && existing.status !== 'open') {
		return {
			ok: false,
			level: 'warning',
			message: `The goal "${existing.title}" is ${existing.status} — resolve it first (confirm or withdraw a claimed goal, delete a done goal), then set the new goal`
		};
	}
	backlog.setGoal(goal);
	try {
		await writeFile(todoPath, backlog.render());
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not write ${outName}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const set = existing
		? `Replaced the goal in ${outName}: "${existing.title}" → "${goal.title}"`
		: `Set goal "${goal.title}" in ${outName}`;
	if (loopState?.enabled && loopState.todoPath === todoPath) {
		return {
			ok: true,
			level: 'info',
			message: `${set}. ${
				loopState.mode === 'goal'
					? 'The active goal loop picks it up from the next iteration.'
					: 'The active task loop is unaffected.'
			}`
		};
	}
	const todoFlag = todoPath === resolve(cwd, DEFAULT_TODO) ? '' : ` --todo ${outName}`;
	return { ok: true, level: 'info', message: `${set}. Start the goal loop with: /ralph start --goal${todoFlag}` };
}

/** Restrict generated Ralph documents to files below the project root. */
function resolveProjectFile(cwd: string, file: string): string | undefined {
	if (!file || isAbsolute(file)) return undefined;
	const path = resolve(cwd, file);
	const pathFromProject = relative(cwd, path);
	if (!pathFromProject || pathFromProject === '..' || pathFromProject.startsWith('../') || pathFromProject.startsWith('..\\')) {
		return undefined;
	}
	return path;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await readFile(path, 'utf8');
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
		return true;
	}
}

/**
 * Inspect an init output target before writing. Shared by /ralph-init and
 * ralph_todo action "init" to decide whether the file can be created, already
 * holds a ralph backlog (init is idempotent on it), or must not be replaced.
 */
async function inspectInitTarget(path: string): Promise<
	| { kind: 'missing' }
	| { kind: 'exists'; ralph: boolean }
	| { kind: 'error'; message: string }
> {
	try {
		const text = await readFile(path, 'utf8');
		return { kind: 'exists', ralph: isRalphBacklog(text) };
	} catch (error) {
		if (error instanceof Error && (error as { code?: unknown }).code === 'ENOENT') return { kind: 'missing' };
		return { kind: 'error', message: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

interface RalphImportArgs {
	input: string;
	force: boolean;
	category?: string;
}

/** Parse `/ralph import <file.md> [--category name] [--force]`. */
function parseImportArgs(args: string[]): RalphImportArgs | undefined {
	let input: string | undefined;
	let category: string | undefined;
	let force = false;
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--force') {
			if (force) return undefined;
			force = true;
		} else if (arg === '--category') {
			const value = args[index + 1];
			if (!value || value.startsWith('--') || category !== undefined) return undefined;
			category = value;
			index += 1;
		} else if (arg.startsWith('--')) {
			return undefined;
		} else if (input === undefined) {
			input = arg;
		} else {
			return undefined;
		}
	}
	if (!input) return undefined;
	return { input, force, category };
}

/** Suggest a category name from a todo filename: TODO.md → General, TODO_EMAIL.md → Email. */
function suggestCategory(input: string): string {
	const stem = input.replace(/\.md$/i, '').replace(/^todo[_-]?/i, '');
	if (!stem) return 'General';
	return stem
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
		.join(' ');
}

/**
 * The auto-created session category of an auto-mode loop: one per loop start
 * (list names cannot contain spaces, hence the compact timestamp). A collision
 * (two loops started within the same minute) gets a numeric suffix.
 */
function autoCategoryName(existing: string[], now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const base = `Session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	let name = base;
	for (let suffix = 2; existing.includes(name); suffix += 1) name = `${base}-${suffix}`;
	return name;
}

type RalphImportOutcome =
	| {
			ok: true;
			outName: string;
			category: string;
			merged?: { tasks: number; logEntries: number };
			counts: { open: number; total: number };
	  }
	| { ok: false; level: 'warning' | 'error'; message: string };

/**
 * Import a Markdown TODO file into the project's TODO.ralph backlog. Shared by
 * the `/ralph import` command and the ralph_todo "import" action so both stay
 * in sync. Existing ralph-format content is merged into; the recorded import
 * sources (M source records) prevent importing the same file twice.
 */
async function importMarkdownBacklog(
	cwd: string,
	input: string,
	options: { category?: string; force?: boolean }
): Promise<RalphImportOutcome> {
	const inputPath = resolveProjectFile(cwd, input);
	if (!inputPath) {
		return { ok: false, level: 'warning', message: 'Ralph import paths must be relative files inside the project' };
	}
	const outName = 'TODO.ralph';
	const outPath = resolveProjectFile(cwd, outName);
	if (!outPath) {
		return { ok: false, level: 'warning', message: 'Ralph import paths must be relative files inside the project' };
	}
	if (inputPath === outPath) {
		return { ok: false, level: 'warning', message: 'The import input and output must be different files' };
	}
	if (!/\.md$/i.test(input)) {
		return { ok: false, level: 'warning', message: `Ralph import only accepts Markdown TODO files (.md); ${input} is not one.` };
	}
	// Imports always stamp a category: uncategorized tasks are invisible in the
	// home view's list rows. An omitted or empty category falls back to a
	// name derived from the file name (TODO_EMAIL.md → Email).
	const category = options.category?.trim() || suggestCategory(input);
	let markdown: string;
	try {
		markdown = await readFile(inputPath, 'utf8');
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not read ${input}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (isRalphBacklog(markdown)) {
		return { ok: false, level: 'warning', message: `${input} is already a ralph-format backlog; nothing to import.` };
	}
	let imported: Backlog;
	try {
		imported = Backlog.fromMarkdown(markdown, { category });
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not import ${input}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const sourceId = relative(cwd, inputPath) || inputPath;
	let target: Backlog | undefined;
	let merged: { tasks: number; logEntries: number } | undefined;
	if (await pathExists(outPath)) {
		let outText = '';
		try {
			outText = await readFile(outPath, 'utf8');
		} catch {
			outText = '';
		}
		if (isRalphBacklog(outText)) {
			let existing: Backlog;
			try {
				existing = Backlog.parse(outText);
			} catch (error) {
				return { ok: false, level: 'error', message: `Could not parse ${outName}: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (existing.sources().includes(sourceId)) {
				return {
					ok: false,
					level: 'warning',
					message: `${input} was already imported into ${outName} (its source is recorded in the backlog). Remove its tasks manually to re-import it.`
				};
			}
			try {
				merged = existing.mergeFrom(imported, { category });
			} catch (error) {
				return { ok: false, level: 'error', message: `Could not merge ${input} into ${outName}: ${error instanceof Error ? error.message : String(error)}` };
			}
			existing.addSource(sourceId);
			target = existing;
		} else if (!options.force) {
			return { ok: false, level: 'warning', message: `Refusing to replace existing ${outName} (it is not a ralph-format backlog). Use force to overwrite.` };
		}
	}
	if (!target) {
		target = imported;
		target.addSource(sourceId);
	}
	try {
		await writeFile(outPath, target.render());
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not write ${outPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true, outName, category, merged, counts: target.counts() };
}

function initPrompt(specFile: string, prompt: string, force: boolean, goal?: { title: string; body?: string }): string {
	const templateWarning =
		specFile === DEFAULT_SPEC ? '; the target SPEC.md is intentionally allowed because it was explicitly selected' : '';
	const goalNote = goal
		? `

This project runs the Ralph goal loop: the ralph-format backlog already contains the goal below (and no tasks yet). The specification must state this goal and its acceptance criteria.

Goal: ${goal.title}
${goal.body ? `${goal.body}\n` : ''}
Keep the goal text exactly as given — it is the user's contract and is already recorded in the ralph-format backlog; do not reword it. Derive explicit, verifiable acceptance criteria for the goal from the project brief and put them with the goal in the specification. The goal loop plans from the goal, executes the planned tasks, and only stops when the goal is verified complete and approved.
`
		: '';
	return `Create the Ralph specification now. This is planning work only; do not implement the product brief.

Project brief:
${prompt}

Output target: specification: ${specFile}.

First read the bundled generic planning template in full:
- specification template: ${INIT_TEMPLATE_SPEC}

It is the authoritative example for the level of product/engineering detail, durable-spec content, acceptance criteria, decision handling, and source-evidence conventions. Adapt its structure and rigor to this project brief; do not copy its placeholder text or assume the project has an existing ${DEFAULT_SPEC} or ${DEFAULT_TODO}.

Create exactly the target file above${force ? ', replacing the named existing file because --force was explicitly supplied,' : ''}. Do not modify any other file${templateWarning}. Use the write tool to produce a complete Markdown document, not a prose preview. Make it self-contained while linking to the corresponding ralph-format backlog (${DEFAULT_TODO}) where useful.${goalNote}

The specification must be a durable, implementation-ready product and engineering contract: purpose, scope, non-goals, source/evidence rules where applicable, architecture, domain/lifecycle and authorization constraints, user journeys and acceptance criteria, quality/security requirements, definition of done, and release gates. Derive scope, architecture, risks, quality checks, and decisions from the project brief; identify unknowns explicitly rather than inventing them. After writing, read the generated file and verify that it is complete, internally consistent, and contains no unrelated implementation changes. Then report the generated path succinctly.`;
}

export default function (pi: ExtensionAPI) {
	let state: RalphState | undefined;
	let config = defaultConfig();
	let configWrite = Promise.resolve();
	// Cached from the TODO file at each refresh point (start, settle, rotation) so
	// the status widget can show the current task number without reading the file
	// on every streamed message update.
	let taskCount: { current: number; total: number } | undefined;
	// Cached from the TODO file at each refresh point (start, settle, rotation) so
	// the status widget can show the current goal state without reading the file
	// on every streamed message update.
	let goalState: GoalStatus | undefined;
	// Display-only: set when a fresh iteration prompt is sent and cleared when the
	// new turn starts streaming or settles, so the status bar visibly stays in the
	// "starting" phase instead of flipping back to "on" within milliseconds.
	let freshIterationPending = false;
	// Set when a turn begins already over budget (e.g. right after a rotation whose
	// reported usage has not caught up yet); suppresses the mid-turn checkpoint
	// steer for that turn so a rotation cannot immediately re-trigger itself.
	let turnStartedOverBudget = false;
	// Stop reason of the last assistant message of the current run; distinguishes
	// a recording turn that finished from one the user aborted (Escape) — an
	// aborted recording turn must not count as recorded progress.
	let lastAssistantStopReason: string | undefined;
	// The ralph-provided compaction pending for the in-flight rotation:
	// consumed by the session_before_compact handler when pi's compact() runs.
	let pendingRalphCompaction: { summary: string; anchorId?: string } | undefined;
	// Once per loop: whether the keepRecentTokens gate notification was shown
	// (a rotation compaction refused because the iteration is too small).
	let compactionGateNotified = false;
	// Auto mode "auto": once the auto loop is stopped in this session, the
	// context-budget intercept must not re-arm it (an explicit stop wins).
	let autoInterceptSuspended = false;
	// In-flight auto-arm setup; the promise cache keeps a burst of streaming
	// updates from arming two loops (two session categories).
	let autoArmInFlight: Promise<RalphState | undefined> | undefined;

	/** Refresh the cached task counter and goal state from a backlog snapshot. */
	const refreshCounts = (todo: string, category?: string) => {
		taskCount = countTodoTasks(todo, category);
		goalState = goalStatus(todo);
	};

	const persistConfig = (ctx: ExtensionContext, next: RalphConfig) => {
		config = next;
		// Keep the current branch's audit trail, while the project file makes the
		// settings available to future Ralph sessions.
		pi.appendEntry(CONFIG_TYPE, next);
		const path = projectConfigPath(ctx.cwd);
		configWrite = configWrite
			.then(async () => {
				await mkdir(join(ctx.cwd, CONFIG_DIR_NAME), { recursive: true });
				await writeFile(path, `${JSON.stringify(next, null, '\t')}\n`, 'utf8');
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Ralph configuration could not be saved to ${path}: ${message}`, 'error');
			});
	};

	const persistState = (next: RalphState) => {
		state = next;
		pi.appendEntry(STATE_TYPE, next);
	};

	// The ralph tools cost zero context until activated (by ralph_enable or
	// /ralph start). Activation is purely additive (defer_loading-friendly);
	// deactivation only happens on session start with no active loop — once
	// in context, the tools stay in context for the rest of the session
	// (loop stop does not remove them, which would break the cached prefix).
	// An active auto loop activates only its dedicated ralph_auto tool; the
	// task/goal loops activate the full ralph tool set.
	const syncToolActivation = () => {
		const active = pi.getActiveTools();
		const next = active.filter((name) => !RALPH_TOOL_NAMES.includes(name) && name !== AUTO_TOOL_NAME);
		if (state?.enabled) {
			const names = state.mode === 'auto' ? [AUTO_TOOL_NAME] : RALPH_TOOL_NAMES;
			for (const name of names) if (!next.includes(name)) next.push(name);
		}
		if (next.length !== active.length) pi.setActiveTools(next);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const autoApproveDecisions = state?.enabled ? state.autoApproveDecisions : config.autoApproveDecisions;
		const mode = state?.blocked
			? 'waiting'
			: state?.paused
				? 'paused'
				: state?.rotationCheckpointing
					? state?.rotationReason === 'completed-task' || state?.rotationReason === 'plan-updated'
						? 'recording'
						: state?.mode === 'auto'
							? 'finishing'
							: 'checkpointing'
					: state?.stopRequested
						? 'stopping'
						: state?.rotationQueued || freshIterationPending
							? 'starting'
							: 'on';
		// The label reflects the active loop's mode (a stopped goal loop keeps
		// its marker); the auto mode setting shows in the state word instead.
		const label =
			state?.mode === 'goal' ? 'Ralph (goal)' : state?.enabled && state.mode === 'auto' ? 'Ralph (auto)' : 'Ralph';
		// Idle state word: the auto mode setting itself: "on" and "auto" are
		// armed (the loop starts at session start / at the context budget),
		// not off.
		const idleState = label === 'Ralph' ? config.autoMode : 'off';
		// Non-default modifiers, compact: (auto-approve) and/or (compaction).
		const modifiers = [autoApproveDecisions ? 'auto-approve' : undefined, config.compactionMode ? 'compaction' : undefined]
			.filter((part): part is string => part !== undefined)
			.join(', ');
		const modifierSuffix = modifiers ? ` (${modifiers})` : '';
		// In the idle on/auto states the context percentage is still shown: the
		// auto loop rotates on the context budget, so the headroom matters.
		const idleContext = idleState !== 'off' ? ` · context: ${contextUsageLabel(ctx, contextThresholdFor(config, ctx))}` : '';
		const status = !state?.enabled
			? `${label}: ${idleState}${modifierSuffix}${idleContext}`
			: `${label}: ${mode}${modifierSuffix} · iteration ${state.iteration}/${state.maxIterations}${state.category ? ` · category: ${state.category}` : ''}${taskCount ? ` · task: ${taskCount.current}/${taskCount.total} (iteration ${state.taskIteration})` : ''}${state.mode === 'goal' && goalState ? ` · goal: ${goalState}` : ''} · context: ${contextUsageLabel(ctx, state.contextThreshold)}`;

		ctx.ui.setWidget('ralph-decision', state?.enabled && state.blocked ? decisionWidgetLines() : undefined);
		// Persistent reminder with the explicit options while paused; the status
		// bar alone does not say how to resume or stop. Typed messages are extra
		// instructions for the model and do NOT resume the loop.
		ctx.ui.setWidget(
			'ralph-paused',
			state?.enabled && state.paused
				? ['Ralph loop is paused — /ralph resume to continue · /ralph stop to stop (typed messages are extra instructions)']
				: undefined
		);
		ctx.ui.setStatus('ralph-loop', undefined);
		// Keep this in the persistent editor header area rather than Pi's startup
		// header, which is only visible at the top of the transcript.
		ctx.ui.setWidget(
			'ralph-loop-status',
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return wrapStatusSegments(status, width).map((line) => rightAlign(theme.fg('dim', line), width));
				}
			}),
			{ placement: 'aboveEditor' }
		);
		ctx.ui.setHeader(undefined);
	};

	const pauseLoop = (ctx: ExtensionContext, message: string) => {
		if (!state?.enabled) return;
		freshIterationPending = false;
		persistState({ ...state, paused: true });
		updateStatus(ctx);
		ctx.ui.notify(message, 'info');
	};

	const stopLoop = (ctx: ExtensionContext, message: string) => {
		if (!state) return;
		taskCount = undefined;
		goalState = undefined;
		freshIterationPending = false;
		// An explicit stop of the auto loop wins over auto mode: the
		// context-budget intercept must not re-arm the loop in this session.
		if (state.mode === 'auto') autoInterceptSuspended = true;
		persistState({
			...state,
			enabled: false,
			paused: false,
			rotationQueued: false,
			rotationReason: undefined,
			rotationCheckpointing: false,
			stopRequested: false,
			blocked: false,
			blockedItem: undefined
		});
		// Note: no syncToolActivation here — the tools stay in context after a
		// stop (removing them would invalidate the cached prompt prefix).
		updateStatus(ctx);
		ctx.ui.notify(message, 'info');
	};

	const blockLoop = (ctx: ExtensionContext, question: string) => {
		if (!state?.enabled) return;
		persistState({
			...state,
			rotationQueued: false,
			rotationReason: undefined,
			rotationCheckpointing: false,
			blocked: true,
			blockedItem: question
		});
		updateStatus(ctx);
		ctx.ui.notify('Ralph is paused — reply below and we’ll decide it together.', 'info');
	};

	// ralph_enable stays active at all times (it is the unlock for the lazy
	// ralph tools); everything else in RALPH_TOOL_NAMES is loop-gated.
	pi.registerTool({
		name: 'ralph_enable',
		label: 'Enable Ralph tools',
		description:
			'Enable the ralph_todo, ralph_goal, ralph_auto, and Ralph decision tools for this session. Call it when the user asks for Ralph backlog management but those tools are unavailable.',
		promptSnippet: 'Enable the Ralph tools',
		parameters: Type.Object({}),
		async execute() {
			const active = pi.getActiveTools();
			const next = [...active];
			for (const name of [...RALPH_TOOL_NAMES, AUTO_TOOL_NAME]) if (!next.includes(name)) next.push(name);
			if (next.length !== active.length) pi.setActiveTools(next);
			return {
				content: [{ type: 'text', text: 'Ralph tools enabled for this session.' }],
				details: {}
			};
		}
	});

	pi.registerTool({
		name: 'ralph_request_decision',
		label: 'Request Ralph decision',
		description: 'Pause the active Ralph loop with a decision question for the user. Use it instead of guessing whenever active Ralph work needs a user decision; include one precise question and the evidence/options.',
		parameters: Type.Object({
			question: Type.String({ description: 'The decision the user must make.' }),
			context: Type.Optional(Type.String({ description: 'Evidence, constraints, and options.' }))
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state?.enabled) throw new Error('Ralph is not active.');
			const question = params.question.trim();
			if (!question) throw new Error('A decision question is required.');
			const detail = params.context?.trim();
			if (state.autoApproveDecisions) {
				return {
					content: [
						{
							type: 'text',
							text: `Decision auto-approved. Choose a safe resolution, document it in versioned documentation with approver “auto-approved”, rationale, and evidence, then continue the blocked work.\n\nQuestion: ${question}${detail ? `\nEvidence/options: ${detail}` : ''}`
						}
					],
					details: { question, context: detail, autoApproved: true }
				};
			}
			const pendingDecision = detail ? `${question}\nEvidence/options: ${detail}` : question;
			blockLoop(ctx, pendingDecision);
			return {
				content: [{ type: 'text', text: formatDecisionMessage(question, detail) }],
				details: { question, context: detail },
				terminate: true
			};
		},
		renderResult(result, options) {
			if (options.isPartial) {
				return new Markdown('> Ralph is preparing the decision request…', 0, 0, getMarkdownTheme());
			}

			const details = result.details as { question?: unknown; context?: unknown } | undefined;
			const question = typeof details?.question === 'string' ? details.question : 'Please review the pending question.';
			const context = typeof details?.context === 'string' ? details.context : undefined;
			return new Markdown(formatDecisionMessage(question, context), 0, 0, getMarkdownTheme());
		}
	});

	pi.registerTool({
		name: 'ralph_resolve_decision',
		label: 'Resolve Ralph decision',
		description: 'Resume the blocked Ralph loop after the user decision is documented. Call it only after the user answered and the decision (approver, rationale, evidence) is recorded in versioned documentation.',
		parameters: Type.Object({
			recordPath: Type.String({ description: 'Path of the decision record.' }),
			resolution: Type.String({ description: 'The agreed decision.' })
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state?.enabled) throw new Error('Ralph is not active.');
			if (!state.blocked) throw new Error('Ralph has no pending decision to resolve.');
			const recordPath = params.recordPath.trim();
			const resolution = params.resolution.trim();
			if (!recordPath || !resolution) throw new Error('Both recordPath and resolution are required.');
			persistState({ ...state, blocked: false, blockedItem: undefined });
			updateStatus(ctx);
			ctx.ui.notify(`Ralph decision recorded in ${recordPath}; continuing.`, 'info');
			return {
				content: [
					{
						type: 'text',
						text: `Decision resolved: ${resolution}\nRecorded in: ${recordPath}\nRalph is unblocked. Continue the previously blocked work now.`
					}
				],
				details: {}
			};
		}
	});

	// Shared parse discipline for the backlog tools (ralph_todo, ralph_goal):
	// load the target file, require the ralph format, and parse it.
	const loadTargetBacklog = async (todoPath: string, toolName: string): Promise<Backlog> => {
		let text: string;
		try {
			text = await readRequiredFile(todoPath);
		} catch (error) {
			const missing = error instanceof Error && (error as { code?: unknown }).code === 'ENOENT';
			if (missing) {
				throw new Error(
					state?.enabled
						? `${todoPath} is missing; bootstrap it with ralph_todo action "init" or restore the file.`
						: `No Ralph backlog at ${todoPath}. Bootstrap it with ralph_todo action "init" or import a Markdown TODO with action "import".`
				);
			}
			throw new Error(`could not read ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isRalphBacklog(text)) {
			throw new Error(`${todoPath} is not a ralph-format backlog; ${toolName} only works with ralph-format backlogs.`);
		}
		try {
			return Backlog.parse(text);
		} catch (error) {
			throw new Error(`could not parse ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// Read/update the SQLite-backed ralph-format backlog. The tool is the only
	// writer of the backlog file, so the line-oriented format stays valid for
	// git diffs and re-imports. With an active loop it targets the loop's
	// backlog; otherwise it manages the project's main backlog (TODO.ralph),
	// so lists (categories) and entries can be created from chat anytime.
	pi.registerTool({
		name: 'ralph_todo',
		label: 'Ralph backlog',
		description:
			`Read/update the Ralph backlog (ralph-format TODO file). Targets the active loop\'s backlog, else the project\'s TODO.ralph (create with action "init"). Tasks addressed by position number as shown by list/next. Actions: next (first open task), list (open tasks + counts), search (needs query; use instead of grepping the file), complete (mark done; note also logs it), checkpoint (loop only), add (needs existing category), add-many, new-list, log, move, import, init. Never read or modify the backlog file by any other means (no file tools, no grep/cat/sed). Read ${REFERENCE_DOC} for per-action parameters and edge cases.`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal('next'),
				Type.Literal('list'),
				Type.Literal('search'),
				Type.Literal('complete'),
				Type.Literal('checkpoint'),
				Type.Literal('add'),
				Type.Literal('add-many'),
				Type.Literal('new-list'),
				Type.Literal('log'),
				Type.Literal('move'),
				Type.Literal('import'),
				Type.Literal('init')
			]),
			task: Type.Optional(
				Type.String({ description: 'Task number as shown by list/next (e.g. "3"); with list: that task\'s detail.' })
			),
			note: Type.Optional(Type.String({ description: 'Checkpoint note, log entry, or completion summary (with complete).' })),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String(),
						body: Type.Optional(Type.String()),
						category: Type.Optional(Type.String())
					}),
					{ description: 'Tasks for add-many (all-or-nothing).' }
				)
			),
			name: Type.Optional(Type.String()),
			category: Type.Optional(Type.String({ description: 'Existing list (must exist; create with new-list).' })),
			query: Type.Optional(Type.String()),
			verbose: Type.Optional(Type.Boolean()),
			date: Type.Optional(Type.String()),
			kind: Type.Optional(
				Type.Union([Type.Literal('done'), Type.Literal('reopen')], {
					description: 'reopen re-opens a completed task (default done).'
				})
			),
			direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')])),
			by: Type.Optional(Type.Integer({ minimum: 1 })),
			file: Type.Optional(Type.String()),
			force: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Import always targets the project's main backlog (TODO.ralph), which
			// may not exist yet, so it runs before the target read below.
			if (params.action === 'import') {
				if (!params.file) throw new Error('import requires the file path.');
				const outcome = await importMarkdownBacklog(ctx.cwd, params.file, {
					category: params.category,
					force: params.force
				});
				if (!outcome.ok) throw new Error(outcome.message);
				const counts = outcome.counts;
				const categoryNote = ` in category "${outcome.category}"`;
				const text = outcome.merged
					? `Merged ${outcome.merged.tasks} tasks${outcome.merged.logEntries ? ` and ${outcome.merged.logEntries} log entries` : ''} from ${params.file} into ${outcome.outName}${categoryNote} (backlog now ${counts.open} open / ${counts.total} total).`
					: `Imported ${counts.total} tasks (${counts.open} open) from ${params.file} to ${outcome.outName}${categoryNote}.`;
				return {
					content: [{ type: 'text', text }],
					details: { action: 'import', file: params.file }
				};
			}
			// Target: the active loop's backlog, else the project's main backlog.
			const todoPath = state?.enabled ? state.todoPath : resolve(ctx.cwd, 'TODO.ralph');
			// Init bootstraps a missing backlog file, so it runs before the target read.
			if (params.action === 'init') {
				const status = await inspectInitTarget(todoPath);
				if (status.kind === 'error') throw new Error(status.message);
				if (status.kind === 'exists') {
					if (status.ralph) {
						return {
							content: [{ type: 'text', text: `${todoPath} already exists as a ralph-format backlog; nothing to do.` }],
							details: { action: 'init', task: null }
						};
					}
					throw new Error(`${todoPath} exists but is not a ralph-format backlog; refusing to overwrite it.`);
				}
				try {
					await mkdir(dirname(todoPath), { recursive: true });
					await writeFile(todoPath, Backlog.empty().render());
				} catch (error) {
					throw new Error(`could not write ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
				return {
					content: [{ type: 'text', text: `Created empty Ralph backlog at ${todoPath}. Add tasks with action "add" and lists with action "new-list".` }],
					details: { action: 'init', task: null }
				};
			}
			const backlog = await loadTargetBacklog(todoPath, 'ralph_todo');

			let mutated = false;
			let output: string;
			const scope = state?.enabled ? state.category : undefined;
			switch (params.action) {
				case 'next': {
					const task = backlog.nextOpenTask(scope);
					if (!task) {
						output = `No open tasks remain${scope ? ` in category "${scope}"` : ''}.`;
						break;
					}
					output = formatNextTask(backlog, task, scope);
					break;
				}
				case 'list': {
					const listScope = params.category ?? scope;
					if (params.category !== undefined && !backlog.categories().includes(params.category)) {
						throw new Error(`no list named "${params.category}" (lists: ${backlog.categories().join(', ') || 'none'})`);
					}
					if (params.task !== undefined) {
						const task = backlog.findTaskByNumber(params.task, listScope);
						if (!task) {
							const known = [...backlog.taskNumbers(listScope).values()].join(', ');
							throw new Error(`no task ${params.task} (tasks: ${known || 'none'})`);
						}
						output = formatTaskDetail(backlog, task, listScope);
						break;
					}
					output = formatBacklog(backlog, listScope, { verbose: params.verbose === true });
					break;
				}
				case 'search': {
					if (!params.query) throw new Error('search requires the query text.');
					const searchScope = params.category ?? scope;
					if (params.category !== undefined && !backlog.categories().includes(params.category)) {
						throw new Error(`no list named "${params.category}" (lists: ${backlog.categories().join(', ') || 'none'})`);
					}
					output = formatSearchResults(backlog, params.query, searchScope);
					break;
				}
				case 'complete': {
					if (!params.task) throw new Error('complete requires the task number.');
					const task = backlog.complete(params.task, scope);
					mutated = true;
					const number = backlog.taskNumbers(scope).get(task.id) ?? task.id;
					let recorded = false;
					if (params.note) {
						const now = new Date();
						const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
						backlog.addLogEntry({ task: String(number), date, note: params.note.trim() }, scope);
						recorded = true;
					}
					output = state?.enabled
						? `Marked task ${number} "${task.title}" done${recorded ? ' and recorded the completion log entry' : ''}. Stop working now — the iteration is finished; the loop records the completion and starts a fresh iteration.`
						: `Marked task ${number} "${task.title}" done in ${todoPath}${recorded ? ' and recorded the completion log entry' : ''}.`;
					break;
				}
				case 'checkpoint': {
					if (!state?.enabled) throw new Error('checkpoint requires an active Ralph loop (start one with /ralph start).');
					if (!params.task || !params.note) throw new Error('checkpoint requires the task number and a note.');
					const task = backlog.setCheckpoint(params.task, params.note.trim(), state.iteration, scope);
					mutated = true;
					const number = backlog.taskNumbers(scope).get(task.id) ?? task.id;
					output = `Checkpoint recorded for task ${number} (iteration ${state.iteration}). Stop working now; a fresh iteration will continue from it.`;
					break;
				}
				case 'add': {
					if (!params.title) throw new Error('add requires a title.');
					if (!params.category) throw new Error('add requires a category (an existing list); create it first with action "new-list"');
					const targetCategory = params.category;
					if (!backlog.categories().includes(targetCategory)) {
						throw new Error(`no list named "${targetCategory}" (lists: ${backlog.categories().join(', ') || 'none'}); create it first with action "new-list"`);
					}
					const task = backlog.addTask({
						title: params.title,
						body: params.body,
						category: targetCategory
					});
					mutated = true;
					const number = backlog.taskNumbers(targetCategory).get(task.id) ?? task.id;
					output = `Added task ${number} "${task.title}" in category "${targetCategory}".`;
					break;
				}
				case 'add-many': {
					const items = params.tasks;
					if (!Array.isArray(items) || items.length === 0) {
						throw new Error('add-many requires a non-empty "tasks" array.');
					}
					if (!params.category) {
						throw new Error('add-many requires a category (an existing list) for the batch; create it first with action "new-list"');
					}
					const batchCategory = params.category;
					// Validate the whole batch first so an invalid entry adds nothing.
					const missingLists = [
						...new Set(
							[batchCategory, ...items.map((item) => item.category)]
								.filter((category): category is string => category !== undefined && !backlog.categories().includes(category))
						)
					];
					if (missingLists.length > 0) {
						throw new Error(
							`no list named ${missingLists.map((name) => `"${name}"`).join(', ')} (lists: ${backlog.categories().join(', ') || 'none'}); create it first with action "new-list"`
						);
					}
					const added = items.map((item) =>
						backlog.addTask({ title: item.title, body: item.body, category: item.category ?? batchCategory })
					);
					mutated = true;
					const summary = added
						.map((task) => {
							const number = backlog.taskNumbers(task.category ?? scope).get(task.id) ?? task.id;
							return `${number} "${task.title}"${task.category ? ` [${task.category}]` : ''}`;
						})
						.join(', ');
					output = `Added ${added.length} task${added.length === 1 ? '' : 's'}: ${summary}.`;
					break;
				}
				case 'new-list': {
					if (!params.name) throw new Error('new-list requires a name.');
					backlog.createList(params.name);
					mutated = true;
					output = `Created list "${params.name.trim()}". It is empty; add tasks to it with action "add" and category "${params.name.trim()}".`;
					break;
				}
				case 'log': {
					if (!params.task) throw new Error('log requires the task number.');
					if (!params.note) throw new Error('log requires a note.');
					const entry = backlog.addLogEntry({ task: params.task, date: params.date, note: params.note, kind: params.kind }, scope);
					mutated = true;
					const number = backlog.taskNumbers(scope).get(entry.taskId) ?? String(entry.taskId);
					output = `Completion log entry recorded for task ${number}${entry.date ? ` dated ${entry.date}` : ''}.`;
					break;
				}
				case 'move': {
					if (!params.task) throw new Error('move requires the task number.');
					if (params.direction !== 'up' && params.direction !== 'down') {
						throw new Error('move requires direction "up" or "down".');
					}
					const steps = params.by ?? 1;
					const task = backlog.moveTask(params.task, params.direction, steps, scope);
					mutated = true;
					const number = backlog.taskNumbers(scope).get(task.id) ?? task.id;
					output = `Moved task ${number} "${task.title}" ${params.direction} by ${steps}.`;
					break;
				}
			}

			if (mutated) {
				try {
					await writeFile(todoPath, backlog.render());
				} catch (error) {
					throw new Error(`could not write ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return {
				content: [{ type: 'text', text: output }],
				details: { action: params.action, task: params.task ?? null }
			};
		},
		renderResult(result, options) {
			const text =
				result.content
					.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
					.map((part) => part.text)
					.join('\n') || 'Ralph backlog updated.';
			return new Markdown(options.isPartial ? '> Ralph backlog…' : text, 0, 0, getMarkdownTheme());
		}
	});

	// Read/update the single goal of the ralph-format backlog. The goal is the
	// user's contract: the model is read-only on its title and body and may
	// only change the goal's state through this tool. With an active loop it
	// targets the loop's backlog; otherwise the project's main backlog
	// (TODO.ralph), so the goal can be inspected from chat anytime.
	pi.registerTool({
		name: 'ralph_goal',
		label: 'Ralph goal',
		description:
			`Read/update the single goal of the Ralph backlog (active loop\'s backlog, else TODO.ralph). The goal is the user\'s contract: its title/body are read-only; change only its state via this tool. Actions: show, checkpoint, complete, confirm, withdraw (all but show require the active goal loop). complete requires a full verification run of every SPEC.md command with evidence; never claim an unverified completion. After the user answers a completion approval: approved → record the decision, call ralph_resolve_decision, then confirm; rejected → withdraw with what is missing. Read ${REFERENCE_DOC} for per-action details.`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal('show'),
				Type.Literal('checkpoint'),
				Type.Literal('complete'),
				Type.Literal('confirm'),
				Type.Literal('withdraw')
			]),
			note: Type.Optional(
				Type.String({
					description:
						'Checkpoint note (checkpoint), completion evidence (complete), or withdrawal note describing what is missing (withdraw).'
				})
			)
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Target: the active loop's backlog, else the project's main backlog.
			const todoPath = state?.enabled ? state.todoPath : resolve(ctx.cwd, 'TODO.ralph');
			const backlog = await loadTargetBacklog(todoPath, 'ralph_goal');
			const goal = backlog.goal();

			let mutated = false;
			let terminated = false;
			let output: string;
			// Keep the cached status-line state in sync with a goal mutation before
			// the loop reacts to it (e.g. the blocked approval gate).
			const syncGoalState = () => {
				if (state?.enabled && state.todoPath === todoPath) goalState = backlog.goal()?.status;
			};
			switch (params.action) {
				case 'show': {
					if (!goal) {
						output = `No goal in ${todoPath}.`;
						break;
					}
					output = formatGoal(goal);
					break;
				}
				case 'checkpoint': {
					if (!state?.enabled) throw new Error('checkpoint requires an active Ralph loop (start one with /ralph start).');
					if (state.mode !== 'goal') {
						throw new Error('checkpoint requires an active goal loop (start one with /ralph start --goal).');
					}
					if (!params.note) throw new Error('checkpoint requires a note.');
					const updated = backlog.setGoalCheckpoint(params.note.trim(), state.iteration);
					mutated = true;
					output = `Checkpoint recorded for the goal "${updated.title}" (iteration ${state.iteration}). Stop working now; a fresh iteration will continue from it.`;
					break;
				}
				case 'complete': {
					if (!state?.enabled) throw new Error('complete requires an active Ralph loop (start one with /ralph start).');
					if (state.mode !== 'goal') {
						throw new Error('complete requires an active goal loop (start one with /ralph start --goal).');
					}
					if (!params.note) throw new Error('complete requires the verification evidence note.');
					if (!goal) throw new Error(`no goal in ${todoPath}`);
					if (goal.status !== 'open') {
						throw new Error(`cannot complete the goal: it is ${goal.status} (complete requires open)`);
					}
					const open = backlog.counts().open;
					if (open > 0) {
						throw new Error(`cannot complete the goal: ${open} task${open === 1 ? '' : 's'} still open`);
					}
					const evidence = params.note.trim();
					const claimed = backlog.claimGoal(evidence);
					mutated = true;
					syncGoalState();
					if (state.autoApproveDecisions) {
						// Delegated approval, consistent with the decision semantics:
						// the claim is confirmed immediately.
						const done = backlog.confirmGoal();
						syncGoalState();
						output = `Goal "${done.title}" is done (approver: auto-approved). Stop working now; the loop records the completion.`;
						break;
					}
					// User approval gate: the goal stays claimed and the loop pauses
					// until the user answers (the ralph_request_decision pattern).
					const question = `Approve completion of the goal "${claimed.title}"?`;
					blockLoop(ctx, `${question}\nEvidence: ${evidence}`);
					terminated = true;
					output = `Goal "${claimed.title}" is claimed (evidence recorded) and the loop is paused pending the user's approval.\n\nAfter the user answers:\n- Approved: record the decision, the user as approver, rationale, and evidence in the appropriate versioned documentation, then call ralph_resolve_decision with the record path, and then call ralph_goal with action "confirm".\n- Rejected: call ralph_goal with action "withdraw" and a note describing what is missing, then continue working on the remaining work.`;
					break;
				}
				case 'confirm': {
					if (!state?.enabled) throw new Error('confirm requires an active Ralph loop (start one with /ralph start).');
					if (state.mode !== 'goal') {
						throw new Error('confirm requires an active goal loop (start one with /ralph start --goal).');
					}
					if (!goal) throw new Error(`no goal in ${todoPath}`);
					const done = backlog.confirmGoal();
					mutated = true;
					syncGoalState();
					output = `Goal "${done.title}" is done (approved). Stop working now; the loop records the completion.`;
					break;
				}
				case 'withdraw': {
					if (!state?.enabled) throw new Error('withdraw requires an active Ralph loop (start one with /ralph start).');
					if (state.mode !== 'goal') {
						throw new Error('withdraw requires an active goal loop (start one with /ralph start --goal).');
					}
					if (!params.note) throw new Error('withdraw requires a note describing what is missing.');
					if (!goal) throw new Error(`no goal in ${todoPath}`);
					const withdrawn = backlog.withdrawGoal(params.note.trim());
					mutated = true;
					syncGoalState();
					output = `Goal "${withdrawn.title}" is open again; the withdrawal note is its checkpoint. Continue working on the remaining work.`;
					break;
				}
			}

			if (mutated) {
				try {
					await writeFile(todoPath, backlog.render());
				} catch (error) {
					throw new Error(`could not write ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
				// The status widget captures its label when updateStatus runs; refresh
				// it so the new goal state is visible without waiting for the settle.
				if (state?.enabled) updateStatus(ctx);
			}
			return {
				content: [{ type: 'text', text: output }],
				details: { action: params.action },
				...(terminated ? { terminate: true } : {})
			};
		},
		renderResult(result, options) {
			const text =
				result.content
					.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
					.map((part) => part.text)
					.join('\n') || 'Ralph goal updated.';
			return new Markdown(options.isPartial ? '> Ralph goal…' : text, 0, 0, getMarkdownTheme());
		}
	});

	// The dedicated tool of the auto mode: the session todos of _auto_.ralph.
	// With an active auto loop it is scoped to the loop's auto-created session
	// category; otherwise it reads the auto backlog unscoped. add and complete
	// require an active auto loop. The auto loop activates only this tool —
	// not the full ralph tool set.
	pi.registerTool({
		name: AUTO_TOOL_NAME,
		label: 'Ralph auto session',
		description:
			`Read/update the Ralph auto-loop session todos in ${AUTO_TODO_FILE} (ralph format). With an active auto loop, scoped to the loop's session category. Actions: next (first open task), list (open tasks + counts), add (record a todo entry for the next iteration; title + optional body; auto loop only), complete (mark done; note also records the completion log; auto loop only). Never read or modify the file by any other means (no file tools, no grep/cat/sed).`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal('next'),
				Type.Literal('list'),
				Type.Literal('add'),
				Type.Literal('complete')
			]),
			task: Type.Optional(Type.String({ description: 'Task number as shown by list/next (complete).' })),
			title: Type.Optional(Type.String({ description: 'Todo title (add).' })),
			body: Type.Optional(Type.String({ description: 'Todo detail as markdown bullets (add).' })),
			note: Type.Optional(Type.String({ description: 'Completion summary (complete).' })),
			verbose: Type.Optional(Type.Boolean())
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const autoLoop = state?.enabled && state.mode === 'auto' ? state : undefined;
			const todoPath = autoLoop ? autoLoop.todoPath : resolve(ctx.cwd, AUTO_TODO_FILE);
			const scope = autoLoop?.category;
			const backlog = await loadTargetBacklog(todoPath, AUTO_TOOL_NAME);

			let mutated = false;
			let output: string;
			switch (params.action) {
				case 'next': {
					// Reference entries ("Goal: " / "Findings: ") are not work
					// items: skip them so the iteration never stalls on one.
					const open = backlog.listTasks(scope).filter((task) => !task.done);
					const task = open.find((task) => !isReferenceTaskTitle(task.title));
					if (!task) {
						const references = open.filter((task) => isReferenceTaskTitle(task.title));
						output =
							references.length > 0
								? `No open work tasks remain${scope ? ` in category "${scope}"` : ''} (open reference entries, not work: ${references
										.map((reference) => reference.title)
										.join('; ')}).`
								: `No open tasks remain${scope ? ` in category "${scope}"` : ''}.`;
						break;
					}
					output = formatNextTask(backlog, task, scope);
					break;
				}
				case 'list': {
					output = formatBacklog(backlog, scope, { verbose: params.verbose === true });
					break;
				}
				case 'add': {
					if (!autoLoop) {
						throw new Error(
							'add requires an active Ralph auto loop (set auto mode to "on" or "auto" in /ralph config, or start one with /ralph start).'
						);
					}
					if (!params.title) throw new Error('add requires a title.');
					const category = autoLoop.category ?? autoCategoryName(backlog.categories());
					// The category is created at loop start; this is defensive.
					if (!backlog.categories().includes(category)) backlog.createList(category);
					const task = backlog.addTask({ title: params.title, body: params.body, category });
					mutated = true;
					const number = backlog.taskNumbers(category).get(task.id) ?? task.id;
					output = `Recorded todo ${number} "${task.title}" for the next iteration in category "${category}".`;
					break;
				}
				case 'complete': {
					if (!autoLoop)
						throw new Error(
							'complete requires an active Ralph auto loop (set auto mode to "on" or "auto" in /ralph config, or start one with /ralph start).'
						);
					if (!params.task) throw new Error('complete requires the task number.');
					const task = backlog.complete(params.task, scope);
					mutated = true;
					const number = backlog.taskNumbers(scope).get(task.id) ?? task.id;
					let recorded = false;
					if (params.note) {
						const now = new Date();
						const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
						backlog.addLogEntry({ task: String(number), date, note: params.note.trim() }, scope);
						recorded = true;
					}
					output = `Marked task ${number} "${task.title}" done${recorded ? ' and recorded the completion log entry' : ''}.`;
					break;
				}
			}

			if (mutated) {
				try {
					await writeFile(todoPath, backlog.render());
				} catch (error) {
					throw new Error(`could not write ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return {
				content: [{ type: 'text', text: output }],
				details: { action: params.action, task: params.task ?? null }
			};
		},
		renderResult(result, options) {
			const text =
				result.content
					.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
					.map((part) => part.text)
					.join('\n') || 'Ralph auto session updated.';
			return new Markdown(options.isPartial ? '> Ralph auto session…' : text, 0, 0, getMarkdownTheme());
		}
	});

	const startFreshIteration = (ctx: ExtensionContext) => {
		void (async () => {
			if (!state?.enabled) return;
			const reason = state.rotationReason ?? 'completed-task';
			try {
				const currentTodo = await readRequiredFile(state.todoPath);
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state. Auto mode never
				// stops on an empty backlog: the session category starts empty.
				if (state.mode !== 'goal' && state.mode !== 'auto' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				// Goal mode: never start a fresh iteration once the goal is done.
				if (state.mode === 'goal' && goalStatus(currentTodo) === 'done') {
					stopLoop(ctx, 'Ralph goal loop stopped because the goal is complete');
					return;
				}
				refreshCounts(currentTodo, state?.category);
				const taskChanged = state.taskNumber !== undefined && state.taskNumber !== taskCount.current;
				const next: RalphState = {
					...state,
					baselineTodo: currentTodo,
					iteration: state.iteration + 1,
					taskIteration: taskChanged ? 1 : state.taskIteration + 1,
					taskNumber: currentTaskNumber(taskCount.current),
					rotationQueued: false,
					rotationReason: undefined,
					rotationCheckpointing: false
				};
				if (next.iteration > next.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after reaching the maximum of ${next.maxIterations} iterations`);
					return;
				}
				persistState(next);
				updateStatus(ctx);

				// Keep the audit trail in this session. With compaction mode on,
				// hide the finished iteration: an extension-provided compaction
				// (no LLM call) cuts the TUI and the model context at the
				// recording prompt, and the summary, boundary marker, and prompt
				// are sent only after the compaction settles (or fails) so they
				// land after the cut. With compaction mode off, the finished
				// iteration stays visible in the TUI and the three messages are
				// sent directly — the boundary marker alone keeps the model
				// context clean. The summary is sent BEFORE the boundary: the
				// context handler slices the model context at the last boundary,
				// so the summary stays in the session (audit trail, TUI) but is
				// dropped from the model context — the model checks its own
				// progress with the ralph_todo/ralph_goal tools.
				freshIterationPending = true;
				updateStatus(ctx);
				const completion = completionSummary(currentTodo, state.loopStartTodo, next.category);
				const finishRotation = () => {
					// A pause/stop/blocked decision that landed while the compaction
					// ran must not start a new turn; the resume/stop flow continues.
					if (!state?.enabled || state.paused || state.blocked) return;
					if (completion) {
						pi.sendMessage(
							{ customType: COMPLETION_SUMMARY_TYPE, content: completion, display: true },
							{ triggerTurn: false, deliverAs: 'followUp' }
						);
					}
					pi.sendMessage(
						{
							customType: CONTEXT_BOUNDARY_TYPE,
							content:
								reason === 'context-limit'
									? 'Start of a fresh Ralph iteration after a durable context checkpoint.'
									: 'Start of a new independent Ralph iteration.',
							display: false
						},
						{ triggerTurn: false, deliverAs: 'followUp' }
					);
					pi.sendUserMessage(iterationPrompt(next, reason), { deliverAs: 'followUp' });
				};
				if (!config.compactionMode) {
					finishRotation();
					return;
				}
				const anchor = ctx.sessionManager
					.getBranch()
					.findLast((entry) => entry.type === 'message' && entry.message.role === 'user');
				pendingRalphCompaction = {
					summary:
						completion ??
						`Ralph loop: the previous iteration ended (${reason}). No tasks have been completed or checkpointed in this loop yet; the durable state is in the backlog and the repository.`,
					anchorId: anchor?.id
				};
				ctx.compact({
					onComplete: finishRotation,
					onError: (error) => {
						// Clear the pending compaction: the hook only consumes it when
						// pi actually runs the compaction, so a gate failure ("Nothing
						// to compact") must not leave it set for a later, unrelated
						// compaction (e.g. the user's /compact).
						pendingRalphCompaction = undefined;
						// An aborted compaction (user Escape) must not start a new
						// turn. Expected gate failures ("Nothing to compact" when the
						// iteration is smaller than compaction.keepRecentTokens,
						// "Already compacted" when a concurrent compaction won)
						// proceed without the TUI clear: the boundary marker still
						// keeps the model context clean.
						if (/abort|cancel/i.test(error.message)) {
							ctx.ui.notify('Ralph rotation compaction was aborted; the loop continues on the next settle.', 'warning');
							return;
						}
						// The iteration was too small to compact and stays visible in
						// the TUI: say so once per loop, where the user actually
						// notices it, instead of speculating at loop start.
						if (!compactionGateNotified && /nothing to compact/i.test(error.message)) {
							compactionGateNotified = true;
							ctx.ui.notify(
								'Ralph rotation compaction was skipped: the finished iteration is smaller than pi\'s compaction.keepRecentTokens and stays visible in the TUI. Set "compaction": { "keepRecentTokens": 1000 } in settings.json to hide every rotation.',
								'warning'
							);
						}
						finishRotation();
					}
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (state) {
					persistState({
						...state,
						rotationQueued: false,
						rotationReason: undefined,
						rotationCheckpointing: false
					});
				}
				updateStatus(ctx);
				ctx.ui.notify(`Ralph loop could not continue: ${message}`, 'error');
			}
		})();
	};

	/**
	 * Set up the auto loop's durable state: the _auto_.ralph backlog with its
	 * auto-created session category, the loop state, and the ralph_auto tool
	 * activation. Shared by /ralph start, the session-start auto start (auto
	 * mode "on"), and the context-budget intercept (auto mode "auto"). Returns
	 * undefined (with a notification) when the setup fails.
	 */
	const setupAutoLoop = async (ctx: ExtensionContext): Promise<RalphState | undefined> => {
		const todoPath = resolve(ctx.cwd, AUTO_TODO_FILE);
		const specPath = resolve(ctx.cwd, DEFAULT_SPEC);
		try {
			let backlog: Backlog;
			if (await pathExists(todoPath)) {
				const text = await readRequiredFile(todoPath);
				if (!isRalphBacklog(text)) {
					ctx.ui.notify(
						`Ralph auto mode needs a ralph-format backlog: ${AUTO_TODO_FILE} is not one. Delete or replace the file first.`,
						'warning'
					);
					return undefined;
				}
				backlog = Backlog.parse(text);
			} else {
				backlog = Backlog.empty();
			}
			const category = autoCategoryName(backlog.categories());
			backlog.createList(category);
			const rendered = backlog.render();
			await mkdir(dirname(todoPath), { recursive: true });
			await writeFile(todoPath, rendered);
			refreshCounts(rendered, category);
			const next: RalphState = {
				enabled: true,
				todoPath,
				specPath,
				loopStartTodo: rendered,
				baselineTodo: rendered,
				iteration: 1,
				taskIteration: 1,
				taskNumber: currentTaskNumber(taskCount.current),
				maxIterations: config.maxIterations,
				contextThreshold: contextThresholdFor(config, ctx),
				autoApproveDecisions: config.autoApproveDecisions,
				rotationQueued: false,
				rotationReason: undefined,
				rotationCheckpointing: false,
				stopRequested: false,
				paused: false,
				blocked: false,
				blockedItem: undefined,
				mode: 'auto',
				category
			};
			persistState(next);
			syncToolActivation();
			updateStatus(ctx);
			compactionGateNotified = false;
			ctx.ui.notify(`Ralph auto loop: state in ${AUTO_TODO_FILE}, session category "${category}"`, 'info');
			return next;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Ralph auto loop could not start: ${message}`, 'error');
			return undefined;
		}
	};

	/**
	 * Arm the auto loop at the context budget (auto mode "auto"). The promise
	 * cache keeps a burst of streaming updates from arming two loops.
	 */
	const armAutoLoop = (ctx: ExtensionContext) => {
		if (!autoArmInFlight) {
			autoArmInFlight = setupAutoLoop(ctx).finally(() => {
				autoArmInFlight = undefined;
			});
		}
		return autoArmInFlight;
	};

	// Shared by /ralph start and the GUI (the backlog view's s key): the same
	// validation (idle, readable spec + TODO, known category, open tasks) and
	// the same state setup.
	const startLoop = async (ctx: ExtensionCommandContext, files: RalphStartFiles): Promise<void> => {
		if (state?.enabled) {
			ctx.ui.notify('Ralph loop is already active — /ralph stop to end it first', 'info');
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify('Wait for the current agent run to finish before starting Ralph', 'warning');
			return;
		}

		const { specFile, todoFile, category: requestedCategory, goal } = files;
		// The auto loop is selected by the auto mode setting (on or auto): a
		// plain /ralph start stores its state in _auto_.ralph with an
		// auto-created session category. An explicit --goal start is unaffected.
		const auto = !goal && config.autoMode !== 'off';
		const todoPath = auto ? resolve(ctx.cwd, AUTO_TODO_FILE) : resolve(ctx.cwd, todoFile);
		const specPath = resolve(ctx.cwd, specFile);
		let category = requestedCategory;
		try {
			// The auto loop runs in any project: SPEC.md may be missing
			// (the prompt says "when present", and the loop creates it when the
			// project is not yet documented). The task/goal loops require it.
			if (!auto) await readRequiredFile(specPath);
			let baselineTodo: string;
			let backlog: Backlog;
			if (auto) {
				if (todoFile !== DEFAULT_TODO || requestedCategory !== undefined) {
					ctx.ui.notify(
						`Auto mode manages its own backlog (${AUTO_TODO_FILE}) and session category; set auto mode to "off" in /ralph config to use a custom backlog or category.`,
						'warning'
					);
					return;
				}
				const next = await setupAutoLoop(ctx);
				if (!next) return;
				pi.sendUserMessage(iterationPrompt(next));
				return;
			} else {
				baselineTodo = await readRequiredFile(todoPath);
				if (!isRalphBacklog(baselineTodo)) {
					ctx.ui.notify(
						`Ralph loops run on ralph-format backlogs only: ${todoFile} is not one. Import it first with /ralph import ${todoFile}`,
						'warning'
					);
					return;
				}
				backlog = Backlog.parse(baselineTodo);
				if (goal) {
				const goalRecord = backlog.goal();
				if (!goalRecord) {
					ctx.ui.notify(`Ralph goal loop will not start because ${todoFile} has no goal`, 'warning');
					return;
				}
				if (goalRecord.status === 'done') {
					ctx.ui.notify('Ralph goal loop will not start because the goal is already complete', 'info');
					return;
				}
			}
				if (requestedCategory !== undefined) {
					const known = backlog.categories();
					if (!known.includes(requestedCategory)) {
						ctx.ui.notify(`Unknown category "${requestedCategory}" (categories: ${known.join(', ') || 'none'})`, 'warning');
						return;
					}
				}
				// Goal mode allows zero open tasks: an empty plan is the planning
				// state, not a finished loop.
				if (!goal && isBacklogFinished(baselineTodo, requestedCategory)) {
					ctx.ui.notify('Ralph loop will not start because all TODO items are complete', 'info');
					return;
				}
			}
			refreshCounts(baselineTodo, category);
			const next: RalphState = {
				enabled: true,
				todoPath,
				specPath,
				loopStartTodo: baselineTodo,
				baselineTodo,
				iteration: 1,
				taskIteration: 1,
				taskNumber: currentTaskNumber(taskCount.current),
				maxIterations: config.maxIterations,
				contextThreshold: contextThresholdFor(config, ctx),
				autoApproveDecisions: config.autoApproveDecisions,
				rotationQueued: false,
				rotationReason: undefined,
				rotationCheckpointing: false,
				stopRequested: false,
				paused: false,
				blocked: false,
				blockedItem: undefined,
				mode: goal ? 'goal' : 'tasks',
				category
			};
			persistState(next);
			syncToolActivation();
			updateStatus(ctx);
			compactionGateNotified = false;
			pi.sendUserMessage(iterationPrompt(next));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Ralph loop needs readable spec file ${specFile} and TODO file ${todoFile}: ${message}`,
				'error'
			);
		}
	};

	const sendRecordingPrompt = (ctx: ExtensionContext, options?: { midTurn?: boolean }) => {
		if (!state) return;
		const prompt =
			state.rotationReason === 'completed-task'
				? completionRecordingPrompt(state)
				: state.rotationReason === 'plan-updated'
					? planRecordingPrompt(state)
					: state.mode === 'auto'
						? autoFinishPrompt(state)
						: contextCheckpointPrompt(state);
		pi.sendUserMessage(prompt, { deliverAs: options?.midTurn ? 'steer' : 'followUp' });
	};

	const queueRotation = (
		ctx: ExtensionContext,
		reason: RotationReason,
		options?: { midTurn?: boolean; currentTodo?: string }
	) => {
		if (!state?.enabled || state.rotationQueued) return;

		// For completed-task rotations, name the completed task(s) in the
		// recording prompt instead of making the model re-read the backlog to
		// find them: the diff against the baseline already identifies them.
		const completedTasks =
			reason === 'completed-task' && options?.currentTodo
				? completedTaskNumbers(state.baselineTodo, options.currentTodo, state.category)
				: undefined;

		persistState({
			...state,
			rotationQueued: true,
			rotationReason: reason,
			rotationCheckpointing: true,
			completedTasks
		});
		updateStatus(ctx);

		// Every rotation first records progress in a dedicated turn — a durable
		// TODO checkpoint for context-limit, a completion record plus local commit
		// for completed-task. That turn's settled event starts the clean context
		// that continues from the recorded state instead of the old conversation.
		// When the budget is crossed mid-turn, steer the instruction into the
		// running turn so the model stops at the next tool boundary instead of the
		// turn running on until it settles on its own.
		sendRecordingPrompt(ctx, options);
	};

	// Continue a paused loop: re-run the interrupted progress-recording turn
	// when a rotation was pending, otherwise continue the interrupted
	// iteration. Shared by /ralph resume and the paused-input dialog.
	const resumeLoop = (ctx: ExtensionContext) => {
		if (!state?.enabled || !state.paused) return;
		persistState({ ...state, paused: false });
		updateStatus(ctx);
		if (state.rotationQueued && state.rotationCheckpointing) {
			// The progress-recording turn was interrupted; run it again
			// before the fresh iteration starts.
			sendRecordingPrompt(ctx);
		} else {
			// No rotation was pending: continue the interrupted iteration.
			pi.sendUserMessage(resumePrompt(state), { deliverAs: 'followUp' });
		}
	};

	// Dynamic tool loading (pi "defer_loading"): the four ralph tools stay
	// inactive until ralph_enable or /ralph start activates them additively.
	// They carry no promptSnippet/promptGuidelines on purpose — activating a
	// tool with prompt metadata rebuilds the system prompt and invalidates the
	// cached prefix, even on providers with native deferred loading. All
	// behavioural rules live in the tool descriptions instead.

	pi.on('session_start', async (_event, ctx) => {
		state = undefined;
		taskCount = undefined;
		goalState = undefined;
		freshIterationPending = false;
		turnStartedOverBudget = false;
		lastAssistantStopReason = undefined;
		runSawAssistantMessage = true;
		runAbortedByUser = false;
		runSignal = undefined;
		config = defaultConfig();
		let hasSessionConfig = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== 'custom') continue;
			if (entry.customType === CONFIG_TYPE) {
				const savedConfig = normalizeConfig(entry.data);
				if (savedConfig) {
					config = savedConfig;
					hasSessionConfig = true;
				}
			}
			if (entry.customType === STATE_TYPE && isRalphState(entry.data)) {
				state = normalizeState(entry.data);
			}
		}
		// Sessions created before the config entry retain their last active setting.
		if (state && !hasSessionConfig) {
			config = {
				contextThresholds: { [DEFAULT_MODEL_CONFIG_KEY]: state.contextThreshold },
				autoApproveDecisions: state.autoApproveDecisions,
				maxIterations: state.maxIterations,
				compactionMode: DEFAULT_COMPACTION_MODE,
				autoMode: DEFAULT_AUTO_MODE
			};
		}

		const path = projectConfigPath(ctx.cwd);
		try {
			const savedConfig = normalizeConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
			if (!savedConfig) throw new Error('expected contextThreshold(s) and autoApproveDecisions');
			config = savedConfig;
			if (state?.enabled) {
				state = {
					...state,
					autoApproveDecisions: config.autoApproveDecisions,
					maxIterations: config.maxIterations,
					contextThreshold: contextThresholdFor(config, ctx)
				};
			}
		} catch (error) {
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Ralph configuration could not be loaded from ${path}: ${message}`, 'warning');
			}
		}
		if (state?.enabled) {
			try {
				const currentTodo = await readRequiredFile(state.todoPath);
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state. Auto mode never
				// stops on an empty backlog.
				if (state.mode !== 'goal' && state.mode !== 'auto' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				refreshCounts(currentTodo, state?.category);
				// Re-sync the per-task counter after a reload in case the TODO moved on.
				if (state.taskNumber !== undefined && state.taskNumber !== taskCount.current) {
					state = { ...state, taskNumber: currentTaskNumber(taskCount.current), taskIteration: 1 };
				} else if (state.taskNumber === undefined) {
					state = { ...state, taskNumber: currentTaskNumber(taskCount.current) };
				}
			} catch {
				// The normal iteration path will surface a readable TODO error.
			}
		}
		// Auto mode arms the auto loop without a /ralph start: "on" starts it
		// at every session start; "auto" starts it when the session already
		// runs over its context budget (e.g. a resumed long session) — the
		// finish-up turn records todos for the next iteration, which then
		// continues from the backlog.
		if (!state?.enabled) {
			if (config.autoMode === 'on') {
				const next = await setupAutoLoop(ctx);
				if (next) pi.sendUserMessage(iterationPrompt(next));
			} else if (config.autoMode === 'auto') {
				const fraction = contextUsageFraction(ctx);
				if (fraction !== undefined && fraction >= contextThresholdFor(config, ctx)) {
					const next = await setupAutoLoop(ctx);
					if (next) queueRotation(ctx, 'context-limit');
				}
			}
		}
		updateStatus(ctx);
		syncToolActivation();
	});

	pi.on('model_select', (_event, ctx) => {
		if (state?.enabled) {
			persistState({ ...state, contextThreshold: contextThresholdFor(config, ctx) });
		}
		updateStatus(ctx);
	});

	// Refresh the context reading while a response streams. The first streaming
	// update of a fresh iteration also ends its visible "starting" phase. A long
	// turn can cross the context budget while still running; the settle-time
	// check would only act when the turn finally ends, so steer the checkpoint
	// into the running turn as soon as the crossing is visible.
	pi.on('message_update', (_event, ctx) => {
		freshIterationPending = false;
		updateStatus(ctx);
		if (
			state?.enabled &&
			!state.blocked &&
			!state.paused &&
			!state.rotationQueued &&
			!turnStartedOverBudget
		) {
			const fraction = contextUsageFraction(ctx);
			if (fraction !== undefined && fraction >= state.contextThreshold) {
				queueRotation(ctx, 'context-limit', { midTurn: true });
			}
		} else if (!state?.enabled && config.autoMode === 'auto' && !autoInterceptSuspended && !turnStartedOverBudget) {
			// Auto mode intercepts a plain session at its context budget: arm
			// the auto loop and steer the finish-up (todo recording) into the
			// running turn.
			const fraction = contextUsageFraction(ctx);
			if (fraction !== undefined && fraction >= contextThresholdFor(config, ctx)) {
				void armAutoLoop(ctx).then((armed) => {
					if (armed) queueRotation(ctx, 'context-limit', { midTurn: true });
				});
			}
		}
	});

	// Record the stop reason of assistant messages so the settle handler can tell
	// a finished recording turn from one the user aborted.
	let runSawAssistantMessage = true;
	// Set when the run's abort signal fires while a tool call is executing: the
	// tool ends as an error result and the run can finish without an 'aborted'
	// assistant message, so the user abort must be remembered explicitly. Only
	// the signal is trusted here — matching abort-like text in a failing tool's
	// output (file names, log lines) false-positives on clean runs.
	let runAbortedByUser = false;
	// The current run's abort signal, captured at agent_start (after the run
	// ends the session no longer exposes it). Stays aborted after Escape,
	// covering aborts that land in gaps where no message event fires (e.g.
	// between a tool result and the next LLM request).
	let runSignal: AbortSignal | undefined;
	pi.on('message_end', (event) => {
		const message = (event as { message?: { role?: string; stopReason?: string } }).message;
		if (message?.role === 'assistant') {
			lastAssistantStopReason = message.stopReason;
			runSawAssistantMessage = true;
		}
	});

	// Record whether the turn started already over budget so the mid-turn steer
	// cannot re-trigger immediately after a rotation whose reported usage has
	// not caught up with the fresh (filtered) context yet.
	pi.on('agent_start', (_event, ctx) => {
		lastAssistantStopReason = undefined;
		runSawAssistantMessage = false;
		runAbortedByUser = false;
		runSignal = (ctx as { signal?: AbortSignal }).signal;
		turnStartedOverBudget = state ? (contextUsageFraction(ctx) ?? 0) >= state.contextThreshold : false;
	});

	// Remember a user abort that lands while a tool call is running. The tool
	// ends as an error result and the run can settle without an 'aborted'
	// assistant message, which the settle-time check alone would miss. The run's
	// abort signal is the only trustworthy indicator: a failing tool whose output
	// merely *contains* "abort" (file names, test names, log lines) is not an
	// Escape, so the result text is deliberately not inspected.
	pi.on('tool_execution_end', (_event, ctx) => {
		if ((ctx as { signal?: AbortSignal }).signal?.aborted) {
			runAbortedByUser = true;
		}
	});

	pi.on('context', (event) => {
		// The marker remains in the session as an audit boundary. Filter it and all
		// prior messages from every subsequent model request, so every fresh Ralph
		// iteration has a genuinely clean model context without replacing sessions.
		const boundaryIndex = event.messages.findLastIndex(
			(message) => message.role === 'custom' && message.customType === CONTEXT_BOUNDARY_TYPE
		);
		if (boundaryIndex >= 0) return { messages: event.messages.slice(boundaryIndex + 1) };
	});

	// Ralph-provided compaction: when a rotation is in flight, supply the
	// compaction result ourselves — pi records the entry, re-renders the TUI
	// from the cut point, and makes NO LLM call. User-initiated and automatic
	// compactions (no pending rotation) fall through to pi's default behaviour.
	pi.on('session_before_compact', (event) => {
		if (!pendingRalphCompaction) return;
		const { summary, anchorId } = pendingRalphCompaction;
		pendingRalphCompaction = undefined;
		return {
			compaction: {
				summary,
				firstKeptEntryId: anchorId ?? event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { source: COMPACTION_SOURCE }
			}
		};
	});

	pi.on('input', (event) => {
		if (!state?.enabled || event.source === 'extension') return;

		if (state.blocked) {
			const question = state.blockedItem ?? 'the pending Ralph decision';
			return {
				action: 'transform',
				text: `Ralph is paused in this session pending this decision:\n${question}\n\nThe user replied:\n${event.text}\n\nWork with the user to make the decision precise. Do not resume implementation yet. If more information or a different choice is needed, explain the exact remaining question and call ralph_request_decision again. Once the answer is sufficient, record the decision, the user as approver, rationale, and evidence in the appropriate versioned documentation; update a related TODO decision item only for audit purposes, never to unblock Ralph; then call ralph_resolve_decision with the documentation path and a concise resolution. That tool unblocks the session, after which continue the previously blocked work.`
			};
		}

		// A paused loop keeps the model out of the loop: without this note the
		// last prompt the model saw is the iteration prompt, so a typed message
		// can be misread as “continue the Ralph loop” instead of a normal chat
		// instruction. Extension commands (e.g. /ralph resume) never reach this
		// handler, so resuming is unaffected.
		if (state.paused) {
			return {
				action: 'transform',
				text: `The Ralph loop is temporarily paused in this session: you are NOT currently running the Ralph loop. The user message below is a normal instruction or question — not a Ralph iteration, not a resume, and not an answer to a pending decision. Do not start or continue Ralph work: do not select or modify TODO items, implement, checkpoint, commit, or call ralph_resolve_decision. Answer the user's message directly. The loop resumes only when the user runs /ralph resume.\n\nUser message:\n${event.text}`
			};
		}
	});

	pi.on('agent_settled', async (_event, ctx) => {
		freshIterationPending = false;
		if (state?.blocked) return;
		// An aborted run means the user pressed Escape: pause the loop
		// immediately, always — even mid-rotation. Continuing (re-sending the
		// recording prompt, queueing a rotation, or starting a fresh iteration)
		// would begin a new turn the user just tried to end. The runSignal /
		// runSawAssistantMessage / runAbortedByUser guards catch aborts that land
		// in gaps where no 'aborted' assistant message is produced (before the
		// first token, while a tool call is running, between tool result and the
		// next LLM request).
		const userAborted =
			lastAssistantStopReason === 'aborted' || runAbortedByUser || !runSawAssistantMessage || runSignal?.aborted === true;
		if (!state?.enabled) {
			// Auto mode intercepts a plain session at its context budget: arm
			// the auto loop and run the finish-up (todo recording) rotation.
			// An aborted run never arms — the user just tried to end the turn.
			if (config.autoMode === 'auto' && !autoInterceptSuspended && !userAborted) {
				const fraction = contextUsageFraction(ctx);
				if (fraction !== undefined && fraction >= contextThresholdFor(config, ctx)) {
					const armed = await armAutoLoop(ctx);
					if (armed) queueRotation(ctx, 'context-limit');
				}
			}
			return;
		}
		// A paused loop stays paused: user chat turns and any other settles must
		// not queue rotations or fresh iterations until /ralph resume.
		if (state.paused) return;
		if (userAborted) {
			if (state.stopRequested) {
				stopLoop(ctx, 'Ralph loop stopped after the current iteration');
			} else {
				pauseLoop(ctx, 'Ralph loop paused (Escape) — /ralph resume to continue');
			}
			return;
		}
		if (state.rotationQueued) {
			// The progress-recording turn (context checkpoint or completion record)
			// is an intentionally separate, docs-only turn. Once it settles, start
			// the fresh iteration from that durable state rather than compacting or
			// retaining the old conversation — unless a stop was requested, in which
			// case the recorded progress is the last thing the loop does. Without
			// this check a stop requested while a rotation was pending would be
			// ignored: the fresh iteration would carry stopRequested over and the
			// loop would auto-rotate forever.
			if (state.rotationCheckpointing) {
				if (state.stopRequested) {
					stopLoop(ctx, 'Ralph loop stopped after recording progress');
				} else {
					persistState({ ...state, rotationCheckpointing: false });
					startFreshIteration(ctx);
				}
			}
			return;
		}
		if (state.stopRequested) {
			// Stopping still honors the current iteration's rotation boundary:
			// a just-completed task gets its completion record + local commit, and
			// an over-budget context gets a durable checkpoint, before the loop
			// ends. Otherwise progress would be lost with the old conversation.
			try {
				const currentTodo = await readRequiredFile(state.todoPath);
				refreshCounts(currentTodo, state?.category);
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state. Auto mode never
				// stops on an empty backlog.
				if (state.mode !== 'goal' && state.mode !== 'auto' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				if (state.mode !== 'auto' && hasCompletedTodoItem(state.baselineTodo, currentTodo, state.category)) {
					queueRotation(ctx, 'completed-task', { currentTodo });
					return;
				}
				// Goal mode: a grown plan is a progress boundary too — the plan
				// update gets its commit before the loop ends.
				if (state.mode === 'goal' && planGrew(state.baselineTodo, currentTodo, state.category)) {
					queueRotation(ctx, 'plan-updated');
					return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Ralph loop could not read ${state.todoPath}: ${message}`, 'error');
				return;
			}
			const contextFraction = contextUsageFraction(ctx);
			if (contextFraction !== undefined && contextFraction >= state.contextThreshold) {
				queueRotation(ctx, 'context-limit');
				return;
			}
			stopLoop(ctx, 'Ralph loop stopped after the current iteration');
			return;
		}

		try {
			const currentTodo = await readRequiredFile(state.todoPath);
			refreshCounts(currentTodo, state?.category);
			// Re-render with the fresh count: a turn can complete several tasks
			// (auto mode works task after task), so the bar must not stay stale.
			updateStatus(ctx);
			// Goal mode is done when the goal is done, not when the plan is
			// exhausted: an empty plan is the planning state. Auto mode never
			// stops on an empty backlog.
			if (state.mode !== 'goal' && state.mode !== 'auto' && isBacklogFinished(currentTodo, state?.category)) {
				stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
				return;
			}
			// Goal mode: the loop ends when the goal is done in the file.
			if (state.mode === 'goal' && goalStatus(currentTodo) === 'done') {
				stopLoop(ctx, 'Ralph goal loop stopped because the goal is complete');
				return;
			}

			// Completing an item is a hard context boundary. It must win over the
			// proactive threshold check below: each rotation inserts a marker that
			// removes preceding turns from model context, while context-limit first
			// records a durable TODO checkpoint. Auto mode rotates only on its
			// context budget: completing a session todo is progress, not a boundary.
			if (state.mode !== 'auto' && hasCompletedTodoItem(state.baselineTodo, currentTodo, state.category)) {
				if (state.iteration >= state.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after completing iteration ${state.iteration}/${state.maxIterations}`);
					return;
				}
				queueRotation(ctx, 'completed-task', { currentTodo });
				return;
			}

			// Goal mode: the plan grew (new open tasks, no completions) — a
			// progress boundary that rotates with a commit-only recording turn,
			// winning over the proactive threshold check below like completions do.
			if (state.mode === 'goal' && planGrew(state.baselineTodo, currentTodo, state.category)) {
				if (state.iteration >= state.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after completing iteration ${state.iteration}/${state.maxIterations}`);
					return;
				}
				queueRotation(ctx, 'plan-updated');
				return;
			}

			// Start the checkpoint only after the current run has settled. Completed
			// items take the clean cutoff above; unfinished work gets a durable TODO
			// checkpoint followed by a fresh model context.
			const contextFraction = contextUsageFraction(ctx);
			if (contextFraction !== undefined && contextFraction >= state.contextThreshold) {
				queueRotation(ctx, 'context-limit');
				return;
			}

			// Auto mode rotates only on the context budget: a completed task
			// under budget is not a boundary, but the loop must not idle
			// either — start the next open work task instead of waiting for
			// the user to type "continue".
			if (
				state.mode === 'auto' &&
				hasCompletedTodoItem(state.baselineTodo, currentTodo, state.category) &&
				openWorkTaskCount(currentTodo, state.category) > 0
			) {
				pi.sendUserMessage(
					'Continue the Ralph auto loop: call ralph_auto with action "next" and start the next open task.',
					{ deliverAs: 'followUp' }
				);
				return;
			}

			// Goal mode: a turn that made no progress — the goal is still open, no
			// task is open, nothing was completed, and the plan did not grow — and
			// did not rotate (under budget) is a stall. Stop with a clear notice
			// instead of looping on an empty plan.
			if (
				state.mode === 'goal' &&
				goalStatus(currentTodo) === 'open' &&
				isBacklogFinished(currentTodo, state.category) &&
				!planGrew(state.baselineTodo, currentTodo, state.category)
			) {
				stopLoop(
					ctx,
					'Ralph goal loop stopped: the goal is still open but this iteration made no progress (no task completed and no new tasks added). Add tasks to the plan or complete the goal to continue.'
				);
				return;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Ralph loop could not read ${state.todoPath}: ${message}`, 'error');
			return;
		}
	});

	const openConfig = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== 'tui') {
			ctx.ui.notify('/ralph config requires TUI mode', 'error');
			return;
		}

		const items: SettingItem[] = [
			{
				id: 'contextThreshold',
				label: 'Start fresh context at',
				description: 'Record a durable TODO checkpoint and start a fresh Ralph context once this share of the context window is used. Saved separately for each model.',
				currentValue: contextThresholdLabel(contextThresholdFor(config, ctx)),
				submenu: (currentValue, done) =>
					numericSettingSubmenu(
						'Context percentage (10–100)',
						currentValue.replace(/%$/, ''),
						(value) => {
							const percentage = Number(value.trim().replace(/%$/, ''));
							if (!Number.isFinite(percentage) || percentage < 10 || percentage > 100) {
								ctx.ui.notify('Context percentage must be a number from 10 to 100.', 'error');
								return undefined;
							}
							return contextThresholdLabel(percentage / 100);
						},
						done
					)
			},
			{
				id: 'maxIterations',
				label: 'Maximum iterations',
				description: 'Stop Ralph after this many completed iterations.',
				currentValue: String(config.maxIterations),
				submenu: (currentValue, done) =>
					numericSettingSubmenu(
						'Maximum iterations (positive whole number)',
						currentValue,
						(value) => {
							const iterations = Number(value.trim());
							if (!isMaxIterations(iterations)) {
								ctx.ui.notify('Maximum iterations must be a positive whole number.', 'error');
								return undefined;
							}
							return String(iterations);
						},
						done
					)
			},
			{
				id: 'compactionMode',
				label: 'Compaction mode',
				description:
					'Hide each finished iteration from the TUI when the loop rotates: an extension-provided compaction (no LLM call) cuts the session at the recording prompt and shows the completion summary in the compaction box. Off: finished iterations stay visible.',
				currentValue: config.compactionMode ? 'enabled' : 'disabled',
				values: ['enabled', 'disabled']
			},
			{
				id: 'autoApproveDecisions',
				label: 'Auto-approve decisions',
				description: 'Continue after a decision request without pausing for your reply; Ralph records the approver as auto-approved.',
				currentValue: config.autoApproveDecisions ? 'enabled' : 'disabled',
				values: ['enabled', 'disabled']
			},
			{
				id: 'autoMode',
				label: 'Auto mode',
				description:
					`The auto loop stores its state in ${AUTO_TODO_FILE} with an auto-created session category, rotates on its context budget (the model finishes up and records todos for the next iteration), and uses the dedicated ralph_auto tool. off: nothing automatic. on: the loop starts at session start. auto: the loop arms itself when the context crosses the budget (at session start or mid-session). A plain /ralph start uses the auto loop unless the mode is off (an explicit --goal start is unaffected).`,
				currentValue: config.autoMode,
				values: ['off', 'on', 'auto']
			}
		];

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg('accent', theme.bold('Ralph configuration')), 1, 1));
			const settingsList = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					const next: RalphConfig =
						id === 'contextThreshold'
							? {
								...config,
								contextThresholds: {
									...config.contextThresholds,
									[modelConfigKey(ctx)]: Number.parseInt(value, 10) / 100
								}
							}
							: id === 'maxIterations'
								? { ...config, maxIterations: Number.parseInt(value, 10) }
								: id === 'compactionMode'
									? { ...config, compactionMode: value === 'enabled' }
								: id === 'autoMode'
									? { ...config, autoMode: value as AutoMode }
									: { ...config, autoApproveDecisions: value === 'enabled' };
					persistConfig(ctx, next);
					if (state?.enabled) {
						persistState({
							...state,
							autoApproveDecisions: next.autoApproveDecisions,
							maxIterations: next.maxIterations,
							contextThreshold: contextThresholdFor(next, ctx)
						});
					}
					// The status widget captures its label when updateStatus runs. Refresh it
					// here so an active loop immediately reflects a changed threshold.
					updateStatus(ctx);
					const savedDescription =
						id === 'contextThreshold'
							? contextThresholdLabel(contextThresholdFor(next, ctx))
							: id === 'maxIterations'
								? `maximum iterations ${next.maxIterations}`
								: id === 'compactionMode'
									? `compaction mode ${next.compactionMode ? 'enabled' : 'disabled'}`
								: id === 'autoMode'
									? `auto mode ${next.autoMode}`
									: `auto-approve decisions ${next.autoApproveDecisions ? 'enabled' : 'disabled'}`;
					ctx.ui.notify(`Ralph configuration saved: ${savedDescription}`, 'info');
				},
				() => done(undefined)
			);
			container.addChild(settingsList);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				}
			};
		});
	};

	pi.registerCommand('ralph-init', {
		description:
			'Create the Ralph spec (generated) and a ralph-format backlog: [--goal] [--spec file] [--todo file] [--force] <project brief>',
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const options: AutocompleteItem[] = [
				{ value: '--goal', label: '--goal', description: 'Initialize for the goal loop: the backlog gets the goal (derived from the brief) and the spec must state it with acceptance criteria.' },
				{ value: '--spec', label: '--spec', description: 'Generate only this specification file (or pair with --todo).' },
				{ value: '--todo', label: '--todo', description: 'Create only this ralph-format backlog file (or pair with --spec).' },
				{ value: '--force', label: '--force', description: 'Allow replacing a named existing output file.' }
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = parseCommandArguments(args.trim());
			const initFiles = commandArgs ? parseInitFiles(commandArgs) : undefined;
			if (!initFiles) {
				ctx.ui.notify(
					'Usage: /ralph-init [--goal] [--spec file] [--todo file] [--force] <project brief> (quote paths or briefs containing spaces)',
					'warning'
				);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify('Wait for the current agent run to finish before initializing Ralph documents', 'warning');
				return;
			}

			const specPath = initFiles.specFile ? resolveProjectFile(ctx.cwd, initFiles.specFile) : undefined;
			const todoPath = initFiles.todoFile ? resolveProjectFile(ctx.cwd, initFiles.todoFile) : undefined;
			if ((initFiles.specFile && !specPath) || (initFiles.todoFile && !todoPath)) {
				ctx.ui.notify('Ralph document paths must be relative files inside the project', 'warning');
				return;
			}
			if (specPath && todoPath && specPath === todoPath) {
				ctx.ui.notify('The specification and TODO outputs must have different names', 'warning');
				return;
			}

			// Pre-write checks for both targets. The ralph-format backlog needs no
			// template: it is created directly as an empty backlog (idempotent on
			// an existing ralph backlog); the specification is generated by the
			// LLM from the project brief.
			let todoStatus: Awaited<ReturnType<typeof inspectInitTarget>> | undefined;
			if (todoPath) {
				todoStatus = await inspectInitTarget(todoPath);
				if (todoStatus.kind === 'error') {
					ctx.ui.notify(todoStatus.message, 'warning');
					return;
				}
				if (todoStatus.kind === 'exists' && !todoStatus.ralph && !initFiles.force) {
					ctx.ui.notify(
						`Refusing to replace existing ${initFiles.todoFile} (it is not a ralph-format backlog). Choose a new name or add --force.`,
						'warning'
					);
					return;
				}
			}
			if (specPath) {
				if (!initFiles.force) {
					const status = await inspectInitTarget(specPath);
					if (status.kind === 'error') {
						ctx.ui.notify(status.message, 'warning');
						return;
					}
					if (status.kind === 'exists') {
						ctx.ui.notify(
							`Refusing to replace existing ${initFiles.specFile}. Choose a new name or add --force.`,
							'warning'
						);
						return;
					}
				}
			}

			let todoWritten = false;
			let goalAlready = false;
			if (todoPath && todoStatus) {
				let backlog: Backlog | undefined;
				if (todoStatus.kind === 'missing' || !todoStatus.ralph) {
					backlog = Backlog.empty();
				} else if (initFiles.goal) {
					// Existing ralph backlog: add the goal only when it has none yet,
					// so re-running --goal init is idempotent.
					try {
						const existing = Backlog.parse(await readFile(todoPath, 'utf8'));
						if (existing.goal()) goalAlready = true;
						else backlog = existing;
					} catch (error) {
						ctx.ui.notify(
							`could not parse ${initFiles.todoFile}: ${error instanceof Error ? error.message : String(error)}`,
							'error'
						);
						return;
					}
				}
				if (backlog) {
					if (initFiles.goal) backlog.setGoal(goalFromBrief(initFiles.prompt));
					try {
						await mkdir(dirname(todoPath), { recursive: true });
						await writeFile(todoPath, backlog.render());
						todoWritten = true;
					} catch (error) {
						ctx.ui.notify(
							`could not write ${initFiles.todoFile}: ${error instanceof Error ? error.message : String(error)}`,
							'error'
						);
						return;
					}
				}
			}

			if (specPath) {
				ctx.ui.notify('Preparing Ralph specification…', 'info');
				pi.sendUserMessage(
					initPrompt(initFiles.specFile!, initFiles.prompt, initFiles.force, initFiles.goal ? goalFromBrief(initFiles.prompt) : undefined)
				);
				return;
			}
			ctx.ui.notify(
				initFiles.goal
					? goalAlready
						? `Ralph backlog at ${initFiles.todoFile} already has the goal "${goalFromBrief(initFiles.prompt).title}"; nothing to do.`
						: `Created Ralph backlog with goal "${goalFromBrief(initFiles.prompt).title}" at ${initFiles.todoFile}. Review the goal, then start the goal loop with /ralph start --goal.`
					: todoWritten
						? `Created empty Ralph backlog at ${initFiles.todoFile}. Add tasks with the ralph_todo tool.`
						: `Ralph backlog at ${initFiles.todoFile} already exists; nothing to do.`,
					'info'
			);
		}
	});

	/**
	 * Open the Ralph home view (bare /ralph or /ralph <file>): a pinned goal
	 * row above the list rows; enter on a list opens the task view for it.
	 * Source: an explicit file, else the active loop's backlog, else the
	 * conventional names in the project root.
	 */
	const openHome = async (ctx: ExtensionCommandContext, fileArg?: string): Promise<void> => {
		const candidates = fileArg
			? [resolveProjectFile(ctx.cwd, fileArg)].filter((p): p is string => p !== undefined)
			: state?.enabled
				? [state.todoPath]
				: [resolve(ctx.cwd, DEFAULT_TODO), resolve(ctx.cwd, 'TODO.md')];
		let todoPath: string | undefined;
		for (const candidate of candidates) {
			if (candidate && (await pathExists(candidate))) {
				todoPath = candidate;
				break;
			}
		}
		if (!todoPath) {
			ctx.ui.notify(
				fileArg
					? `Could not read ${fileArg}`
					: 'No backlog found: start a loop or pass a file (e.g. /ralph TODO.ralph)',
				'error'
			);
			return;
		}
		const title = relative(ctx.cwd, todoPath) || todoPath;
		const loadBacklog = (): Backlog | undefined => {
			try {
				const text = readFileSync(todoPath!, 'utf8');
				// The view only renders ralph-format backlogs; Markdown
				// backlogs must be imported first (see below).
				return isRalphBacklog(text) ? Backlog.parse(text) : undefined;
			} catch {
				return undefined;
			}
		};
		let initial: Backlog | undefined;
		try {
			const text = readFileSync(todoPath, 'utf8');
			if (!isRalphBacklog(text)) {
				ctx.ui.notify('Todo entries empty. Import data with /ralph import', 'info');
				return;
			}
			initial = Backlog.parse(text);
		} catch {
			initial = undefined;
		}
		if (!initial) {
			ctx.ui.notify(`Could not parse ${todoPath} as a Ralph backlog`, 'error');
			return;
		}
		// Persist a backlog mutation: run fn on the given backlog instance and
		// write the result to disk. Return false when the change was not saved
		// (the view keeps showing the previous data).
		const persist = async (backlog: Backlog, fn: (b: Backlog) => void): Promise<boolean> => {
			try {
				fn(backlog);
			} catch (error) {
				ctx.ui.notify(`Could not update ${title}: ${error instanceof Error ? error.message : String(error)}`, 'error');
				return false;
			}
			try {
				await writeFile(todoPath, backlog.render());
				return true;
			} catch (error) {
				ctx.ui.notify(`Could not save ${title}: ${error instanceof Error ? error.message : String(error)}`, 'error');
				return false;
			}
		};
		// The views render as overlays on top of the chat, so the chat layout
		// and its scroll position are untouched while they are open (closing a
		// view no longer disturbs where the chat was scrolled). One overlay
		// hosts both stages (home view, task view) and swaps between them
		// without closing: closing between stages would let the chat behind
		// flash for a frame. Both stages use the todos view's layout: the
		// list is pinned to the top, the key hints sit on the bottom line,
		// and the lines in between are blank so the chat behind is blacked
		// out; both size to 90% of terminal height so the status footer
		// stays visible.
		const OVERLAY_MAX_HEIGHT = '90%';
		const viewHeight = () => Math.max(10, Math.floor((process.stdout.rows ?? 40) * 0.9));
		// The backlog instance the view currently renders; refreshed from
		// disk on every home round (a task-view round may have renamed or
		// added lists).
		let source: Backlog = initial;
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			// The stage currently rendered. Swapping stages does not close
			// the overlay, so the chat behind never flashes through.
			let stage: RalphHome | TodosView | undefined;
			const showStage = (next: RalphHome | TodosView) => {
				stage?.dispose();
				stage = next;
				tui.requestRender();
			};
			const showView = (category?: string) => {
				showStage(
					createTodosView({
						backlog: source,
						tui,
						title,
						category,
						theme,
						height: viewHeight,
						requestRender: () => tui.requestRender(),
						onClose: () => done('quit'),
						onBack: () => showHome(),
						reload: loadBacklog,
						mutate: persist,
						onStartLoop: (loopCategory) => {
							void startLoop(ctx, { specFile: DEFAULT_SPEC, todoFile: title, category: loopCategory, goal: false });
						}
					})
				);
			};
			const showHome = () => {
				const fresh = loadBacklog();
				if (fresh) source = fresh;
				showStage(
					createRalphHome({
						backlog: source,
						tui,
						title,
						theme,
						height: viewHeight,
						requestRender: () => tui.requestRender(),
						onClose: () => done(undefined),
						reload: loadBacklog,
						mutate: persist,
						onOpenList: (category) => showView(category),
						onStartGoalLoop: () => {
							void startLoop(ctx, { specFile: DEFAULT_SPEC, todoFile: title, goal: true });
						}
					})
				);
			};
			showHome();
			return {
				render: (width: number) => stage?.render(width) ?? [],
				handleInput: (data: string) => stage?.handleInput(data),
				invalidate: () => stage?.invalidate(),
				dispose: () => stage?.dispose()
			};
		}, { overlay: true, overlayOptions: { width: '100%', maxHeight: OVERLAY_MAX_HEIGHT } });
	};

	pi.registerCommand('ralph', {
		description: 'Ralph home and loop control: /ralph [file] opens the home view (TUI); subcommands: [start|import|set-goal|stop|resume|status|config]',
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const options: AutocompleteItem[] = [
				{
					value: 'start',
					label: 'start',
					description: 'Defaults: SPEC.md and TODO.ralph. Override either with --spec <file> or --todo <file>; scope a ralph-format backlog with --category <name>; start the goal loop with --goal (the backlog needs a goal). Markdown TODOs must be imported first: /ralph import TODO.md.'
				},
				{ value: 'import', label: 'import', description: 'Import a Markdown TODO backlog into the ralph format: /ralph import <file.md> [--category name] [--force]. Always imports into TODO.ralph, merging into an existing backlog. Each source file is only imported once.' },
				{ value: 'set-goal', label: 'set-goal', description: 'Set the backlog goal from a file: /ralph set-goal <goal.md> [--todo <backlog>]. The first non-empty line (optionally an H1 heading) is the title, the rest is the body. Targets the active loop’s backlog or TODO.ralph. Replaces an open goal; a claimed or done goal must be resolved first.' },
				{ value: 'stop', label: 'stop', description: 'Stop after the current iteration.' },
				{ value: 'resume', label: 'resume', description: 'Resume a paused loop (Escape pauses it).' },
				{ value: 'status', label: 'status', description: 'Show the Ralph loop state.' },
				{ value: 'config', label: 'config', description: 'Configure fresh-context rotation and decision approval.' }
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = parseCommandArguments(args.trim());
			if (!commandArgs) {
				ctx.ui.notify('Usage: /ralph start [--spec file] [--todo file] (quote paths containing spaces)', 'warning');
				return;
			}			const command = commandArgs[0]?.toLowerCase() ?? '';
			if (command === 'stop') {
				if (!state?.enabled) {
					ctx.ui.notify('Ralph loop is already stopped', 'info');
					return;
				}

				// A checkpoint/fresh-context rotation can be queued after the prior agent
				// turn settles, so Pi can report idle despite Ralph having a continuation
				// pending. Treat that queued rotation as part of the current iteration and
				// stop at the next agent_settled event.
				if (ctx.isIdle() && !state.rotationQueued) {
					stopLoop(ctx, 'Ralph loop stopped');
				} else {
					persistState({ ...state, stopRequested: true });
					updateStatus(ctx);
					ctx.ui.notify('Ralph will stop after the current iteration', 'info');
				}
				return;
			}
			if (command === 'resume') {
				if (!state?.enabled) {
					ctx.ui.notify('Ralph loop is not active', 'info');
					return;
				}
				if (!state.paused) {
					ctx.ui.notify('Ralph loop is not paused', 'info');
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify('Wait for the current agent run to finish before resuming Ralph', 'warning');
					return;
				}
				resumeLoop(ctx);
				ctx.ui.notify('Ralph loop resumed', 'info');
				return;
			}
			if (command === 'config') {
				await openConfig(ctx);
				return;
			}
			if (command === 'status') {
				const loopName =
					state?.mode === 'goal' ? 'Ralph goal loop' : state?.mode === 'auto' ? 'Ralph auto loop' : 'Ralph loop';
				ctx.ui.notify(
					!state?.enabled
						? `${loopName} is stopped`
						: state.blocked
							? `${loopName} is awaiting your decision: ${state.blockedItem ?? 'no question was recorded'}`
							: state.paused
								? `${loopName} is paused — /ralph resume to continue`
								: state.rotationCheckpointing
									? state.rotationReason === 'completed-task'
										? `${loopName} is recording the completed task’s progress`
										: state.mode === 'auto'
											? `${loopName} is finishing up and recording todos for the next iteration`
											: `${loopName} is recording a durable context checkpoint`
									: state.stopRequested
										? `${loopName} will stop after the current iteration`
										: state.rotationQueued
											? `${loopName} is starting a fresh iteration`
											: `${loopName} is active · iteration ${state.iteration}/${state.maxIterations}${taskCount ? ` · task: ${taskCount.current}/${taskCount.total} (iteration ${state.taskIteration})` : ''}${state.mode === 'goal' && goalState ? ` · goal: ${goalState}` : ''}`,
					'info'
				);
				return;
			}
			const knownCommands = ['start', 'import', 'set-goal', 'stop', 'resume', 'status', 'config'];
			if (command !== '' && !knownCommands.includes(command)) {
				// The first non-subcommand argument is a backlog file for the home view.
				if (ctx.mode !== 'tui') {
					ctx.ui.notify(
						`Unknown subcommand "${commandArgs[0]}" — usage: /ralph [start|import|set-goal|stop|resume|status|config]`,
						'error'
					);
					return;
				}
				await openHome(ctx, commandArgs[0]);
				return;
			}
			if (command === '') {
				if (ctx.mode !== 'tui') {
					ctx.ui.notify('Usage: /ralph [start|import|set-goal|stop|resume|status|config] (in TUI: bare /ralph opens the home view)', 'warning');
					return;
				}
				await openHome(ctx);
				return;
			}
			if (command === 'set-goal') {
				const setGoalArgs = parseSetGoalArgs(commandArgs.slice(1));
				if (!setGoalArgs) {
					ctx.ui.notify('Usage: /ralph set-goal <goal-file> [--todo <backlog-file>]', 'warning');
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify('Wait for the current agent run to finish before setting the goal', 'warning');
					return;
				}
				const outcome = await setGoalFromFile(ctx.cwd, state, setGoalArgs);
				ctx.ui.notify(outcome.message, outcome.level);
				return;
			}
			if (command === 'import') {
				const importArgs = parseImportArgs(commandArgs.slice(1));
				if (!importArgs) {
					ctx.ui.notify('Usage: /ralph import <file.md> [--category name] [--force] (quote paths containing spaces)', 'warning');
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify('Wait for the current agent run to finish before importing a backlog', 'warning');
					return;
				}
				// Category: explicit --category wins; in TUI mode ask (suggested
				// from the file name; empty accepts the suggestion).
				let category = importArgs.category;
				if (category === undefined && ctx.mode === 'tui') {
					const answer = await ctx.ui.input('Category', suggestCategory(importArgs.input));
					if (answer === undefined) {
						ctx.ui.notify('Import cancelled', 'info');
						return;
					}
					category = answer.trim() === '' ? undefined : answer.trim();
				}
				const outcome = await importMarkdownBacklog(ctx.cwd, importArgs.input, {
					category,
					force: importArgs.force
				});
				if (!outcome.ok) {
					ctx.ui.notify(outcome.message, outcome.level);
					return;
				}
				const counts = outcome.counts;
				const categoryNote = ` in category "${outcome.category}"`;
				ctx.ui.notify(
					outcome.merged
						? `Merged ${outcome.merged.tasks} tasks${outcome.merged.logEntries ? ` and ${outcome.merged.logEntries} log entries` : ''} from ${importArgs.input} into ${outcome.outName}${categoryNote} (backlog now ${counts.open} open / ${counts.total} total). Start with: /ralph start --todo ${outcome.outName}`
						: `Imported ${counts.total} tasks (${counts.open} open) from ${importArgs.input} to ${outcome.outName}${categoryNote}. Start with: /ralph start --todo ${outcome.outName}`,
					'info'
				);
				return;
			}
			const startFiles = parseStartFiles(commandArgs.slice(1));
			if (!startFiles) {
				ctx.ui.notify('Usage: /ralph start [--spec file] [--todo file] [--category name] [--goal]', 'warning');
				return;
			}
			await startLoop(ctx, startFiles);
		}
	});
}
