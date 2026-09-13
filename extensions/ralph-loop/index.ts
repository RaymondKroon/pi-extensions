import {
	CONFIG_DIR_NAME,
	getAgentDir,
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
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import {
	Backlog,
	formatBacklog,
	formatGoal,
	formatNextTask,
	formatSearchResults,
	formatTaskDetail,
	isRalphBacklog,
	NotRalphBacklogError,
	type CompletionEntry,
	type Goal,
	type GoalStatus
} from './backlog.ts';
import { createTodosView, type TodosView } from './todos-view.ts';
import { renderPrompt } from './prompt-template.ts';
import { createRalphHome, type RalphHome } from './ralph-home.ts';

const STATE_TYPE = 'ralph-loop-state';
const CONFIG_TYPE = 'ralph-loop-config';
const CONFIG_FILE_NAME = 'ralph-loop.json';
/** The global config store file (in the ralph directory of pi's global agent directory): settings per directory and, for git repositories, per branch. */
const GLOBAL_CONFIG_FILE_NAME = 'config.json';
/** The branch key for non-git directories and detached HEAD, and the per-directory fallback when a branch has no entry of its own. */
const DEFAULT_BRANCH_KEY = 'default';
/** Marks the beginning of an independent Ralph iteration in the same session. */
const CONTEXT_BOUNDARY_TYPE = 'ralph-loop-context-boundary';
/** Completion-summary message injected at the start of each fresh Ralph iteration. */
const COMPLETION_SUMMARY_TYPE = 'ralph-loop-completion-summary';
/** Marker in a ralph-provided compaction entry's details (distinguishes it from pi's LLM compactions). */
const COMPACTION_SOURCE = 'ralph-loop';
/**
 * The ralph backlog directory: every loop (tasks/goal/auto) and every idle
 * ralph_todo/ralph_goal read runs on the per-session ralph file here. Stored
 * in the ralph subdirectory of pi's global agent directory (like sessions in
 * its sessions subdirectory), one per session (`<session-id>.db`), so it
 * stays out of the project — no check-in, nothing lost in the repository —
 * and can be looked back on globally. A per-session file also leaves room
 * for multiple categories in one file. The file is a SQLite database (the
 * extension marks the format: .db is SQLite, the legacy .ralph name is the
 * human-readable text format, auto-migrated on open).
 */
const AUTO_TODO_DIR = 'ralph';
const autoTodoPath = (ctx: ExtensionContext): string =>
	join(getAgentDir(), AUTO_TODO_DIR, `${ctx.sessionManager.getSessionId()}.db`);
const DEFAULT_CONTEXT_THRESHOLD = 0.5;
const DEFAULT_AUTO_APPROVE_DECISIONS = false;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_COMPACTION_MODE = true;
const DEFAULT_MODEL_CONFIG_KEY = '__default__';
/**
 * The auto mode setting: off — nothing automatic; on — the auto loop arms
 * itself when the context crosses the budget (at session start or mid-session)
 * and records todos for the next iteration. The loop itself only starts via
 * /ralph start.
 */
type AutoMode = 'off' | 'on';
const DEFAULT_AUTO_MODE: AutoMode = 'off';
/**
 * The rotation policy: task — a fresh iteration after every completed task
 * (planned, feature-sized backlogs); budget — work task after task, fresh
 * iteration only at the context budget (fine-grained rolling handoff todos).
 * default — the per-mode default: task for the task/goal loops, budget for
 * the auto loop.
 */
type RotateOn = 'default' | 'task' | 'budget';
const DEFAULT_ROTATE_ON: RotateOn = 'default';
/** The rotation policy resolved for a loop mode ("default" keeps the per-mode default). */
function rotateOnFor(mode: 'tasks' | 'goal' | 'auto', config: RalphConfig): 'task' | 'budget' {
	if (config.rotateOn === 'task' || config.rotateOn === 'budget') return config.rotateOn;
	return mode === 'auto' ? 'budget' : 'task';
}
/** Tools activated additively (defer_loading) by ralph_enable or /ralph start; disabled again on session start when no loop is active. Once in context they stay in context for the rest of the session. */
const RALPH_TOOL_NAMES = ['ralph_todo', 'ralph_goal', 'ralph_request_decision', 'ralph_resolve_decision'];
/** The backlog tool name. With auto mode "on" the auto tool set is pre-activated at session start so arming the loop at the context budget does not change the tool set (a changed tool set changes the rendered prompt and invalidates the provider's prefix cache). */
const TODO_TOOL_NAME = 'ralph_todo';
const GOAL_TOOL_NAME = 'ralph_goal';
/** The tools an active auto loop activates (and auto mode "on" pre-activates): the backlog tool plus the goal tool — the auto loop's big-picture layer is the backlog's goal. */
const AUTO_TOOL_NAMES = [TODO_TOOL_NAME, GOAL_TOOL_NAME];
/** On-demand action reference; the compact tool descriptions point here instead of always-in-context text. */
const REFERENCE_DOC = join(import.meta.dirname, 'docs', 'ralph-backlog.md');

type RotationReason = 'completed-task' | 'plan-updated' | 'phase-changed' | 'context-limit';

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
	 * The auto loop (state in the per-session <session-id>.db in the global
	 * agent directory, auto-created session category, ralph_todo tool, rotation
	 * per the rotation policy — default: the context budget): off — nothing
	 * automatic; on — the loop starts at session start; auto — the loop arms
	 * itself when the context crosses the budget (at session start or
	 * mid-session) and records todos for the next iteration. A plain
	 * /ralph start uses the auto loop unless the mode is off (an explicit
	 * --goal start is unaffected).
	 */
	autoMode: AutoMode;
	/** When a fresh iteration starts: task — after every completed task; budget — only at the context budget; default — per-mode default (task for tasks/goal, budget for auto). */
	rotateOn: RotateOn;
}

interface LegacyRalphConfig {
	contextThreshold: number;
	autoApproveDecisions: boolean;
	maxIterations?: number;
}

function isRotateOn(value: unknown): value is RotateOn {
	return value === 'default' || value === 'task' || value === 'budget';
}

interface RalphState {
	/** The active model's threshold, retained for this Ralph session. */
	contextThreshold: number;
	autoApproveDecisions: boolean;
	enabled: boolean;
	/** Loop policy: the finite task backlog, the single goal, or the auto loop. */
	mode: 'tasks' | 'goal' | 'auto';
	/** The rotation policy resolved at loop start (config "default" → per-mode default); a mid-loop config edit does not change a running loop. */
	rotateOn: 'task' | 'budget';
	todoPath: string;
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
	/** The loop is paused (e.g. the user pressed Escape) and waits for the next user message, which resumes it. */
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
		(state.rotateOn === undefined || state.rotateOn === 'task' || state.rotateOn === 'budget') &&
		typeof state.todoPath === 'string' &&
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
	const mode = state.mode ?? 'tasks';
	return {
		...state,
		mode,
		rotateOn: state.rotateOn ?? (mode === 'auto' ? 'budget' : 'task'),
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
	return value === 'off' || value === 'on';
}

/** Accept the current string values plus the legacy 'auto' string and boolean (true = on, false = off). */
function normalizeAutoMode(value: unknown): AutoMode | undefined {
	if (isAutoMode(value)) return value;
	if (value === 'auto' || value === true) return 'on';
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
		isAutoMode(config.autoMode) &&
		isRotateOn(config.rotateOn)
	);
}

/** A saved config missing newer optional fields; normalizeConfig fills the defaults. */
function isRalphConfigPartial(
	value: unknown
): value is Omit<RalphConfig, 'maxIterations' | 'compactionMode' | 'autoMode' | 'rotateOn'> &
	Partial<Pick<RalphConfig, 'maxIterations' | 'compactionMode' | 'autoMode' | 'rotateOn'>> {
	if (!value || typeof value !== 'object') return false;
	const config = value as Partial<RalphConfig>;
	return (
		!!config.contextThresholds &&
		typeof config.contextThresholds === 'object' &&
		Object.values(config.contextThresholds).every(isContextThreshold) &&
		typeof config.autoApproveDecisions === 'boolean' &&
		(config.maxIterations === undefined || isMaxIterations(config.maxIterations)) &&
		(config.compactionMode === undefined || typeof config.compactionMode === 'boolean') &&
		(config.autoMode === undefined || normalizeAutoMode(config.autoMode) !== undefined) &&
		(config.rotateOn === undefined || isRotateOn(config.rotateOn))
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
			autoMode: normalizeAutoMode(value.autoMode) ?? DEFAULT_AUTO_MODE,
			rotateOn: value.rotateOn ?? DEFAULT_ROTATE_ON
		};
	}
	if (isLegacyRalphConfig(value)) {
		return {
			contextThresholds: { [DEFAULT_MODEL_CONFIG_KEY]: value.contextThreshold },
			autoApproveDecisions: value.autoApproveDecisions,
			maxIterations: value.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			compactionMode: DEFAULT_COMPACTION_MODE,
			autoMode: DEFAULT_AUTO_MODE,
			rotateOn: DEFAULT_ROTATE_ON
		};
	}
}

function defaultConfig(): RalphConfig {
	return {
		contextThresholds: {},
		autoApproveDecisions: DEFAULT_AUTO_APPROVE_DECISIONS,
		maxIterations: DEFAULT_MAX_ITERATIONS,
		compactionMode: DEFAULT_COMPACTION_MODE,
		autoMode: DEFAULT_AUTO_MODE,
		rotateOn: DEFAULT_ROTATE_ON
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

/** The global config store: a "defaults" section (the normal config for directories without their own settings) and a "dirs" section keyed by directory → branch (or "default") → saved config. */
interface RalphConfigStore {
	defaults?: Record<string, unknown>;
	dirs?: Record<string, Record<string, unknown>>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate the parsed store file; undefined for an unrecognized shape (a
 * corrupt store).
 */
function parseConfigStore(value: unknown): RalphConfigStore | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.defaults !== undefined && !isPlainObject(value.defaults)) return undefined;
	if (value.dirs !== undefined && !isPlainObject(value.dirs)) return undefined;
	return { defaults: value.defaults, dirs: value.dirs };
}

function globalConfigPath(): string {
	return join(getAgentDir(), AUTO_TODO_DIR, GLOBAL_CONFIG_FILE_NAME);
}

/** The current git branch of the directory (undefined outside a repository or on a detached HEAD). */
function gitBranch(cwd: string): string | undefined {
	try {
		const branch = execFileSync('git', ['branch', '--show-current'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		return branch.length > 0 ? branch : undefined;
	} catch {
		return undefined;
	}
}

/** The stored config for a directory: the git branch's entry, falling back to the directory's default entry. */
function directoryConfigFor(store: RalphConfigStore, cwd: string, branch: string | undefined): unknown {
	const dir = store.dirs?.[cwd];
	if (!dir || typeof dir !== 'object') return undefined;
	return (branch ? dir[branch] : undefined) ?? dir[DEFAULT_BRANCH_KEY];
}

/**
 * Number the task Ralph is currently working on so the status shows an
 * increasing counter (e.g. task 4/12 once three tasks are complete):
 * completed + 1, so the counter tracks work order even when tasks are
 * completed out of order or reference entries are interleaved.
 */
function countTodoTasks(todo: string, category?: string): { current: number; total: number; done: boolean } {
	const { open, total } = todoCounts(todo, category);
	return { current: open > 0 ? total - open + 1 : total, total, done: open === 0 && total > 0 };
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
 * The auto mode's reference entries: "Findings: " notes from earlier
 * iterations are not work items. ralph_todo "next" skips them on the session
 * backlog so an iteration never stalls on a reference entry. (The big-picture
 * layer is the backlog's goal, maintained via ralph_goal — not "Goal: "
 * tasks.)
 */
function isReferenceTaskTitle(title: string): boolean {
	return title.startsWith('Findings: ');
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
 * The goal-loop phase for a backlog snapshot: planning (goal open, zero
 * tasks), execution (open tasks), or re-evaluation (goal open, tasks exist,
 * none open). Undefined for non-ralph formats, backlogs without a goal, or
 * parse failures.
 */
function goalPhaseOf(todo: string, category?: string): GoalPhase | undefined {
	if (!isRalphBacklog(todo)) return undefined;
	try {
		const backlog = Backlog.parse(todo);
		if (!backlog.goal()) return undefined;
		const counts = backlog.counts(category);
		if (counts.total === 0) return 'planning';
		if (counts.open === 0) return 're-evaluation';
		return 'execution';
	} catch {
		return undefined;
	}
}

/**
 * Whether the goal phase changed between two backlog snapshots (both must be
 * ralph backlogs with a goal for a change to be detectable). The goal loop
 * under rotateOn "budget" rotates on this: the phase is detected at iteration
 * start, so without the rotation a finished plan with context headroom would
 * never reach the re-evaluation prompt and the loop would stall.
 */
function goalPhaseChanged(previousTodo: string, currentTodo: string, category?: string): boolean {
	const previous = goalPhaseOf(previousTodo, category);
	const current = goalPhaseOf(currentTodo, category);
	return previous !== undefined && current !== undefined && previous !== current;
}

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

/** The goal of the state's baseline backlog (undefined when absent or unparseable). */
function baselineGoal(state: RalphState): Goal | undefined {
	if (!isRalphBacklog(state.baselineTodo)) return undefined;
	try {
		return Backlog.parse(state.baselineTodo).goal();
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

/**
 * Prefix for every prompt Ralph injects as a user message (prompts/prefix.md).
 * It makes the sender explicit so the model does not misattribute these to the
 * human user in its reasoning (e.g. narrating "The user is saying to
 * continue.").
 */
function automatedPrefix(): string {
	return `${renderPrompt('prefix', {})}\n\n`;
}

function iterationPrompt(state: RalphState, reason?: RotationReason): string {
	return automatedPrefix() + iterationPromptBody(state, reason);
}

function iterationPromptBody(state: RalphState, reason?: RotationReason): string {
	if (state.mode === 'auto') {
		const contextNote =
			reason === 'context-limit'
				? 'The previous iteration reached its context budget and finished up: the remaining work is recorded as todo entries in your session category. Re-establish facts from the repository and the backlog before continuing; do not rely on the old conversation. The backlog also carries "Findings: " entries with what the previous iteration learned, and DEBUG.md at the project root may carry durable debug findings — read them before starting work instead of rediscovering what they already establish.'
			: 'This is the first iteration of the Ralph auto loop in this session. Start with a clean review of the repository.';
		// From the second iteration on, the backlog also carries the big-picture
		// layer (the backlog's goal, maintained via ralph_goal) and the findings
		// layer ("Findings: " reference notes from earlier iterations).
		const referenceTaskNote =
			state.iteration > 1
				? ' Tasks whose title starts with "Findings: " are not work items, and "next" skips them: they are reference notes from earlier iterations. Read the open Findings entries before starting work, then mark each one done with ralph_todo (action "complete") so the backlog does not accumulate open reference entries.'
				: '';
		const bigGoalMaintenance =
			state.iteration > 1
				? `
Keep the big picture in the backlog's goal: it is the larger objective this work serves, not the immediate next step. Check it with ralph_goal (action "show"); if it is missing or no longer describes the objective, replace it with ralph_goal (action "set", title, body with the acceptance evidence to look for).`
				: '';
		// The big picture: the backlog's goal, carried into every fresh iteration.
		const goal = baselineGoal(state);
		const goalSection = goal
			? `\n\nBig picture — the backlog's goal (maintain it with ralph_goal):\n${goalBlock(goal)}`
			: '';
		// Closing step per rotation policy: under "task" the commit ends the
		// iteration (the loop rotates and starts a fresh one); under "budget"
		// the model keeps working task after task until the context budget.
		const closeStep =
			state.rotateOn === 'task'
				? '5. This is the last step of the iteration: stop working when the commit is made.'
				: '5. After committing, immediately go back to step 1 and start the next open task. Keep working task after task: this iteration only ends when you are told to finish up (context budget) or when no open tasks remain. Do not stop after a completed task while open tasks remain.';
		return renderPrompt('iteration-auto', {
			contextNote,
			goalSection,
			category: String(state.category),
			referenceTaskNote,
			closeStep,
			bigGoalMaintenance
		});
	}

	const contextNote =
		reason === 'context-limit'
			? 'The previous iteration reached its context budget and finished up: the remaining work is recorded as todo entries in the backlog. Re-establish facts from the repository and TODO before continuing; do not rely on the old conversation.'
			: reason === 'completed-task'
				? 'A previous TODO item was completed. Start the next independent iteration with a clean review of the repository.'
				: reason === 'plan-updated'
					? 'The plan was just updated with new tasks. Start the next independent iteration with a clean review of the repository and the updated plan.'
				: reason === 'phase-changed'
						? 'The goal phase changed. Start the next independent iteration with a clean review of the repository and the backlog.'
						: 'This is the first iteration of the Ralph loop in this session. Start with a clean review of the repository.';
	// Closing step per rotation policy: under "task" the commit ends the
	// iteration (the loop rotates and starts a fresh one); under "budget" the
	// model keeps working task after task until the context budget.
	const closeStep = (number: string, commitText: string) =>
		state.rotateOn === 'task'
			? `${number}. ${commitText} This is the last step of the iteration: stop working when the commit is made.`
			: `${number}. ${commitText} After committing, immediately go back to step 1 and start the next open task. Keep working task after task: this iteration only ends when you are told to finish up (context budget) or when no open tasks remain. Do not stop after a completed task while open tasks remain.`;
	const ralphCloseStep = closeStep(
		'6',
		`Commit the completed task locally in a single commit. Do not push.`
	);

	const decisionNote = `If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, do not guess and do not use ${state.todoPath} as an unblock mechanism. Call the ralph_request_decision tool with one precise question and the relevant evidence. ${state.autoApproveDecisions ? 'Decision auto-approval is enabled: the tool will not pause Ralph. Treat this as delegated approval to select a safe resolution, document the decision, approver (auto-approved), rationale, and evidence in versioned documentation, then continue the blocked work. Do not call ralph_resolve_decision.' : 'It pauses Ralph in this session and presents the question to the user. After the user answers, discuss any remaining ambiguity with them. When the decision is clear, record the decision, approver (the user), rationale, and evidence in the appropriate versioned documentation; update any related TODO decision item only as an audit record; then call ralph_resolve_decision with the recorded path and continue the blocked work.'}`;

	if (isRalphBacklog(state.baselineTodo)) {
		const goalInfo = goalPhase(state);
		if (goalInfo) {
			const { phase, goal } = goalInfo;
			const backlogNote = `The backlog is the SQLite-backed file ${state.todoPath} (ralph format). Read and update it only through the ralph_todo tool — never read or modify it by any other means (no file tools, no grep/cat/sed or other shell commands on the file). Use ralph_todo action "search" to find tasks by keyword.`;
			const categoryScope = state.category ? ` in category "${state.category}"` : '';
			const categoryGuard = state.category ? ' or on a task in another category' : '';

			if (phase === 'planning') {
				return renderPrompt('iteration-goal-planning', {
					contextNote,
					backlogNote,
					goalBlock: goalBlock(goal),
					todoPath: state.todoPath,
					decisionNote
				});
			}
			if (phase === 're-evaluation') {
				return renderPrompt('iteration-goal-re-evaluation', {
					contextNote,
					backlogNote,
					goalBlock: goalBlock(goal),
					todoPath: state.todoPath,
					decisionNote
				});
			}
			return renderPrompt('iteration-goal-execution', {
				contextNote,
				backlogNote,
				goalBlock: goalBlock(goal),
				todoPath: state.todoPath,
				categoryScope,
				categoryGuard,
				ralphCloseStep,
				decisionNote
			});
		}

		const categoryScope = state.category ? ` in category "${state.category}"` : '';
		return renderPrompt('iteration-ralph', {
			contextNote,
			backlogNote: `The backlog is the SQLite-backed file ${state.todoPath} (ralph format). Read and update it only through the ralph_todo tool — never read or modify it by any other means (no file tools, no grep/cat/sed or other shell commands on the file). Use ralph_todo action "search" to find tasks by keyword.`,
			todoPath: state.todoPath,
			categoryScope,
			categoryGuard: state.category ? ' or on a task in another category' : '',
			ralphCloseStep,
			decisionNote
		});
	}

	return renderPrompt('iteration-markdown', {
		contextNote,
		todoPath: state.todoPath,
		ralphCloseStep,
		decisionNote
	});
}

/**
 * Compact summary of the progress made in the current loop, re-derived by
 * diffing the backlog against the snapshot taken when the loop started:
 * tasks completed in this loop (titles only — the completion log entries
 * stay in the backlog), tasks checkpointed in this loop, and the goal
 * checkpoint when it changed. Tasks completed before the loop started stay
 * out. Used as the text of the ralph-provided compaction at each rotation
 * and as the visible custom message injected at the start of each fresh
 * Ralph iteration. At rotations it is sent before the context boundary, so
 * it stays in the session (audit trail, TUI) but is dropped from the model
 * context — the model checks its own progress with the ralph_todo/ralph_goal
 * tools.
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
			// Title only: the completion log entries (outcome, evidence,
			// verification) stay durable in the backlog's completion log; the
			// summary is a compact progress list for the TUI/audit trail.
			completionLines.push(`${number}. ${task.title}`);
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
 * Sent when a paused loop is resumed by a typed user message without a pending
 * rotation: the current iteration continues from the durable state instead of
 * starting over, and the user's message is extra info for the loop.
 */
function resumeWithExtraInfoPrompt(extraInfo: string): string {
	return `${automatedPrefix()}${renderPrompt('resume-extra-info', { extraInfo })}`;
}

/**
 * The progress-recording prompt for a queued rotation: the finish-up
 * (context budget / goal phase change) or the completion record plus local
 * commit (completed-task, plan-updated). Ralph-format loops finish up with the
 * merged finish-up prompt; goal planning / re-evaluation iterations checkpoint
 * the goal instead (no task to finish up), and Markdown backlogs keep the
 * item-note checkpoint.
 */
function recordingPromptFor(state: RalphState): string {
	return state.rotationReason === 'completed-task'
		? completionRecordingPrompt(state)
		: state.rotationReason === 'plan-updated'
			? planRecordingPrompt()
			: state.rotationReason === 'phase-changed'
				? finishUpPrompt(state, 'phase-changed')
				: state.mode === 'goal' && goalPhase(state)?.phase !== 'execution'
					? contextCheckpointPrompt(state)
					: isRalphBacklog(state.baselineTodo)
						? finishUpPrompt(state, 'context-limit')
						: contextCheckpointPrompt(state);
}

function contextCheckpointPrompt(state: RalphState): string {
	return automatedPrefix() + contextCheckpointPromptBody(state);
}

function contextCheckpointPromptBody(state: RalphState): string {
	if (isRalphBacklog(state.baselineTodo)) {
		// Task-less goal iterations (planning/re-evaluation) have no task to
		// checkpoint: the goal carries the durable state instead.
		const goalInfo = goalPhase(state);
		if (goalInfo && goalInfo.phase !== 'execution') {
			return renderPrompt('context-checkpoint-goal', {
				iteration: String(state.iteration),
				maxIterations: String(state.maxIterations)
			});
		}
		return renderPrompt('context-checkpoint-ralph', {
			iteration: String(state.iteration),
			maxIterations: String(state.maxIterations),
			taskIteration: String(state.taskIteration)
		});
	}
	return renderPrompt('context-checkpoint-markdown', {
		iteration: String(state.iteration),
		maxIterations: String(state.maxIterations),
		taskIteration: String(state.taskIteration),
		todoPath: state.todoPath
	});
}

/**
 * The rotation finish-up prompt: sent as the dedicated finish-up turn when the
 * iteration reaches its context budget, or when the goal phase changes.
 * Finishing the handoff matters more than a clean state: the model may leave
 * the code in a bad state and records the remaining work as todo entries for
 * the next iteration; completed work gets its completion log entry and its
 * local commit (broken or half-done work does not). The auto loop adds the
 * findings layer ("Findings: " reference notes) and, from the second
 * iteration on, keeps the big picture in the backlog's goal (maintained via
 * ralph_goal). The settled turn starts the fresh iteration.
 */
function finishUpPrompt(state: RalphState, reason: 'context-limit' | 'phase-changed'): string {
	const isAuto = state.mode === 'auto';
	// The auto loop records its todos in the session category; the other loops
	// in their scoped category (or the work's own category when unscoped).
	const categoryClause =
		state.category !== undefined ? ` in category "${state.category}"` : isAuto ? '' : ', and the category of the work';
	// The findings layer is the auto loop's handoff memory; the other loops
	// keep durable findings in DEBUG.md during the iteration instead.
	const findings = isAuto ? `${renderPrompt('finish-up-findings', {})}\n` : '';
	// From the second iteration on, the auto handoff also refreshes the
	// big-picture layer: the first round establishes what the work is about,
	// the later rounds keep the larger objective visible as the backlog's goal.
	const bigPicture =
		isAuto && state.iteration > 1 ? `${renderPrompt('finish-up-big-picture', {})}\n` : '';
	const opening =
		reason === 'phase-changed'
			? 'The goal phase changed. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.'
			: 'The current Ralph iteration has reached its configured context budget. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.';
	return `${automatedPrefix()}${renderPrompt('finish-up', {
		opening,
		iteration: String(state.iteration),
		maxIterations: String(state.maxIterations),
		categoryClause,
		findings,
		bigPicture
	})}`;
}

/**
 * Sent as the dedicated progress-recording turn before a fresh iteration after
 * a completed task: the completion record and the local commit must exist before
 * the next iteration starts.
 */
function completionRecordingPrompt(state: RalphState): string {
	return automatedPrefix() + completionRecordingPromptBody(state);
}

function completionRecordingPromptBody(state: RalphState): string {
	const numbers = state.completedTasks ?? [];
	if (numbers.length > 0) {
		const singular = numbers.length === 1;
		const target = singular ? `task ${numbers[0]}` : `tasks ${numbers.join(', ')}`;
		return renderPrompt('completion-recording', {
			target,
			numberRef: singular ? 'the task\'s number' : 'each task\'s number',
			taskRef: singular ? 'the task' : 'a task',
			entryWord: singular ? 'entry' : 'entry per task',
			reportWord: singular ? 'entry' : 'entries'
		});
	}
	return renderPrompt('completion-recording-identify', {});
}

/**
 * Sent as the dedicated recording turn before a fresh iteration after the goal
 * plan grew: the plan update must be committed locally before the next
 * iteration starts, but no completion log entry is written because no task
 * was completed in the turn.
 */
function planRecordingPrompt(): string {
	return `${automatedPrefix()}${renderPrompt('plan-recording', {})}`;
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
	category?: string;
	/** Start the goal loop instead of the task loop. */
	goal: boolean;
}

/** Parse the start options; the backlog is always the session's ralph file. */
function parseStartFiles(args: string[]): RalphStartFiles | undefined {
	let category: string | undefined;
	let goal = false;

	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === '--goal') {
			if (goal) return undefined;
			goal = true;
			continue;
		}
		if (option !== '--category') return undefined;
		const path = args[index + 1];
		if (!path || path.startsWith('--')) return undefined;
		category = path;
		index += 1;
	}

	return { category, goal };
}

interface RalphSetGoalArgs {
	goalFile: string;
}

/** Parse `set-goal <goal-file>`. */
function parseSetGoalArgs(args: string[]): RalphSetGoalArgs | undefined {
	let goalFile: string | undefined;
	for (const arg of args) {
		if (arg.startsWith('--')) return undefined;
		if (goalFile) return undefined;
		goalFile = arg;
	}
	if (!goalFile) return undefined;
	return { goalFile };
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
 * backlog is the active loop's backlog, else the session's ralph file. An
 * existing goal must be open (a claimed or done goal must be resolved first);
 * setting replaces the title and body.
 */
async function setGoalFromFile(
	cwd: string,
	loopState: RalphState | undefined,
	args: RalphSetGoalArgs,
	todoPath: string
): Promise<SetGoalOutcome> {
	const goalPath = resolveProjectFile(cwd, args.goalFile);
	if (!goalPath) {
		return { ok: false, level: 'warning', message: 'The goal file must be a relative file inside the project' };
	}
	const outName = todoPath;
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
	let backlog: Backlog;
	try {
		backlog = Backlog.open(todoPath);
	} catch (error) {
		if (isMissingFileError(error)) {
			return {
				ok: false,
				level: 'error',
				message: `No backlog at ${outName} — create it first with ralph_todo action "init"`
			};
		}
		return { ok: false, level: 'error', message: `${outName} is not a ralph-format backlog` };
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
		backlog.save(todoPath);
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
	return { ok: true, level: 'info', message: `${set}. Start the goal loop with: /ralph start --goal` };
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
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** True when the error is a missing file (ENOENT). */
function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Inspect an init output target before writing (ralph_todo action "init") to
 * decide whether the file can be created, already holds a ralph backlog (init
 * is idempotent on it), or must not be replaced.
 */
async function inspectInitTarget(path: string): Promise<
	| { kind: 'missing' }
	| { kind: 'exists'; ralph: boolean }
> {
	if (!(await pathExists(path))) return { kind: 'missing' };
	try {
		Backlog.open(path);
		return { kind: 'exists', ralph: true };
	} catch (error) {
		if (isMissingFileError(error)) return { kind: 'missing' };
		return { kind: 'exists', ralph: false };
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
 * The session category of an auto-mode loop: named after the pi session when
 * it has a name (spaces become dashes, since list names cannot contain
 * them); unnamed sessions use "General". A loop restarted in the same session
 * continues the existing category instead of starting a new one.
 */
function autoCategoryName(sessionName?: string): string {
	return sessionName?.trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'General';
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
 * Import a Markdown TODO file into the session's ralph backlog. Shared by the
 * `/ralph import` command and the ralph_todo "import" action so both stay in
 * sync. Existing ralph-format content is merged into; the recorded import
 * sources (M source records) prevent importing the same file twice.
 */
async function importMarkdownBacklog(
	cwd: string,
	input: string,
	outPath: string,
	options: { category?: string; force?: boolean }
): Promise<RalphImportOutcome> {
	const inputPath = resolveProjectFile(cwd, input);
	if (!inputPath) {
		return { ok: false, level: 'warning', message: 'Ralph import paths must be relative files inside the project' };
	}
	const outName = outPath;
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
		let existing: Backlog | undefined;
		try {
			existing = Backlog.open(outPath);
		} catch {
			existing = undefined;
		}
		if (existing) {
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
		target.save(outPath);
	} catch (error) {
		return { ok: false, level: 'error', message: `Could not write ${outPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true, outName, category, merged, counts: target.counts() };
}

export default function (pi: ExtensionAPI) {
	let state: RalphState | undefined;
	let config = defaultConfig();
	let configWrite = Promise.resolve();
	// Cached from the TODO file at each refresh point (start, settle, rotation) so
	// the status widget can show the current task number without reading the file
	// on every streamed message update.
	let taskCount: { current: number; total: number; done: boolean } | undefined;
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
	// Auto mode: once the auto loop is stopped in this session, the automatic
	// context-budget intercept must not re-arm it (an explicit stop wins). An
	// explicit ralph_todo add/update/complete still re-arms the loop: the new
	// request supersedes the stop.
	let autoInterceptSuspended = false;
	// In-flight auto-arm setup; the promise cache keeps a burst of streaming
	// updates from arming two loops (two session categories).
	let autoArmInFlight: Promise<RalphState | undefined> | undefined;

	/** Refresh the cached task counter and goal state from a backlog snapshot. */
	const refreshCounts = (todo: string, category?: string) => {
		taskCount = countTodoTasks(todo, category);
		goalState = goalStatus(todo);
	};
	/** The status counter's scope: the auto loop works through every list, the other loops are scoped to their category. */
	const countCategory = (s?: RalphState) => (s && s.mode === 'auto' ? undefined : s?.category);

	const persistConfig = (ctx: ExtensionContext, next: RalphConfig) => {
		config = next;
		// Keep the current branch's audit trail, while the global store makes the
		// settings available to future Ralph sessions — per directory and, for git
		// repositories, per branch.
		pi.appendEntry(CONFIG_TYPE, next);
		const path = globalConfigPath();
		const branchKey = gitBranch(ctx.cwd) ?? DEFAULT_BRANCH_KEY;
		configWrite = configWrite
			.then(async () => {
				let store: RalphConfigStore;
				try {
					const parsed = parseConfigStore(JSON.parse(await readFile(path, 'utf8')));
					if (!parsed) throw new Error('unrecognized configuration store format');
					store = parsed;
				} catch (error) {
					if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
						store = {};
					} else {
						// A corrupt store: refuse to clobber the other directories' settings.
						throw error;
					}
				}
				const dir = store.dirs?.[ctx.cwd];
				store.dirs = {
					...(store.dirs ?? {}),
					[ctx.cwd]: { ...(dir && typeof dir === 'object' ? dir : {}), [branchKey]: next }
				};
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, `${JSON.stringify(store, null, '\t')}\n`, 'utf8');
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
	// An active auto loop activates the auto tool set (backlog + goal — the
	// big picture is the backlog's goal); the task/goal loops
	// activate the full ralph tool set.
	// With auto mode "on", the auto tool set is pre-activated at session start: the
	// tool definitions are part of every request (vLLM inlines them into the
	// rendered prompt), so adding the tool when the loop arms at the context
	// budget would invalidate the prefix cache at the largest context of the
	// session. The tool is safe to have active without an armed loop —
	// add/update/complete on the session backlog arm the auto loop when auto
	// mode is on (otherwise they require an active one), next/list read the
	// backlogs unscoped.
	const syncToolActivation = () => {
		const active = pi.getActiveTools();
		const next = active.filter((name) => !RALPH_TOOL_NAMES.includes(name));
		if (state?.enabled) {
			const names = state.mode === 'auto' ? AUTO_TOOL_NAMES : RALPH_TOOL_NAMES;
			for (const name of names) if (!next.includes(name)) next.push(name);
		} else if (config.autoMode === 'on') {
			// Pre-activate the auto tool set so arming the loop is cache-neutral.
			for (const name of AUTO_TOOL_NAMES) if (!next.includes(name)) next.push(name);
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
					: state?.mode === 'goal' && goalPhase(state)?.phase !== 'execution'
						? 'checkpointing'
						: 'finishing'
					: state?.stopRequested
						? 'stopping'
						: state?.rotationQueued || freshIterationPending
							? 'starting'
							: 'on';
		// The label reflects the active loop's mode (a stopped goal loop keeps
		// its marker); the auto mode setting shows in the state word instead.
		const label =
			state?.mode === 'goal' ? 'Ralph (goal)' : state?.enabled && state.mode === 'auto' ? 'Ralph (auto)' : 'Ralph';
		// Idle state word: the auto mode setting itself: "auto" is armed (the
		// loop arms itself at the context budget), not off — and distinct from
		// "on", which means a loop is actually running.
		const idleState = label === 'Ralph' ? (config.autoMode === 'on' ? 'auto' : 'off') : 'off';
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
			: `${label}: ${mode}${modifierSuffix} · iteration ${state.iteration}/${state.maxIterations}${state.category ? ` · category: ${state.category}` : ''}${taskCount ? ` · task: ${taskCount.current}/${taskCount.total}${taskCount.done ? ' (done)' : ''} (iteration ${state.taskIteration})` : ''}${state.mode === 'goal' && goalState ? ` · goal: ${goalState}` : ''} · context: ${contextUsageLabel(ctx, state.contextThreshold)}`;

		ctx.ui.setWidget('ralph-decision', state?.enabled && state.blocked ? decisionWidgetLines() : undefined);
		// Persistent reminder with the explicit options while paused; the status
		// bar alone does not say how to resume or stop. A typed message resumes
		// the loop and is extra info for it.
		ctx.ui.setWidget(
			'ralph-paused',
			state?.enabled && state.paused
				? ['Ralph loop is paused — type a message to resume it with extra info · /ralph stop to stop']
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

	/**
	 * Write a mutated backlog to disk and refresh the cached status-line state
	 * (task count, goal state) so the footer reflects the mutation immediately
	 * instead of waiting for the next settle. Every backlog write path that can
	 * change tasks must go through here.
	 */
	const commitBacklog = async (todoPath: string, backlog: Backlog, ctx: ExtensionContext, category?: string) => {
		try {
			backlog.save(todoPath);
		} catch (error) {
			throw new Error(`could not write ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		refreshCounts(backlog.render(), category);
		updateStatus(ctx);
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
		// A force stop can land while a rotation compaction is in flight; the
		// pending ralph summary must not hijack a later, unrelated compaction
		// (e.g. the user's own /compact).
		pendingRalphCompaction = undefined;
		// An explicit stop of the auto loop wins over auto mode for the rest
		// of the session: the automatic context-budget intercept must not
		// re-arm the loop (an explicit ralph_todo add/complete may still do).
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
			'Enable the ralph_todo, ralph_goal, and Ralph decision tools for this session. Call it when the user asks for Ralph backlog management but those tools are unavailable.',
		promptSnippet: 'Enable the Ralph tools',
		parameters: Type.Object({}),
		async execute() {
			const active = pi.getActiveTools();
			const next = [...active];
			for (const name of RALPH_TOOL_NAMES) if (!next.includes(name)) next.push(name);
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

	// Per-backlog-file mutation queue. Sibling tool calls from one assistant
	// message execute concurrently, and each call parses its own in-memory
	// backlog: without serialization, two calls on the same file interleave
	// (lost tasks, torn renders). The queue serializes each call's full
	// load → mutate → write cycle per path, so every call loads the state the
	// previous call left behind.
	const backlogLocks = new Map<string, Promise<unknown>>();
	const withBacklogLock = <T>(path: string, fn: () => Promise<T>): Promise<T> => {
		const previous = backlogLocks.get(path) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		backlogLocks.set(path, run.then(() => undefined, () => undefined));
		return run;
	};

	// Shared load discipline for the backlog tools (ralph_todo, ralph_goal):
	// open the target file as a ralph backlog (SQLite, or legacy ralph text,
	// which is migrated in place).
	const loadTargetBacklog = async (todoPath: string, toolName: string): Promise<Backlog> => {
		try {
			return Backlog.open(todoPath);
		} catch (error) {
			if (isMissingFileError(error)) {
				throw new Error(
					state?.enabled
						? `${todoPath} is missing; bootstrap it with ralph_todo action "init" or restore the file.`
						: `No Ralph backlog at ${todoPath}. Bootstrap it with ralph_todo action "init" or import a Markdown TODO with action "import".`
				);
			}
			if (error instanceof NotRalphBacklogError) {
				throw new Error(`${todoPath} is not a ralph-format backlog; ${toolName} only works with ralph-format backlogs.`);
			}
			throw new Error(`could not open ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// Read/update the SQLite-backed ralph backlog. The tool is the only writer
	// of the backlog file, so the file stays a valid ralph database. It
	// targets the session's ralph file
	// (<session-id>.db in the global agent directory) — the active loop's
	// backlog when a loop is running — so lists (categories) and entries can
	// be created from chat anytime.
	pi.registerTool({
		name: 'ralph_todo',
		label: 'Ralph backlog',
		description:
			`Read/update the Ralph backlog (ralph-format TODO file). Targets the active loop's backlog, else the session's ralph file (<session-id>.db in the global agent directory; create with action "init"). Tasks addressed by position number as shown by list/next. Actions: next (first open task), list (open tasks + counts), search (needs query; use instead of grepping the file), complete (mark done; note also logs it), checkpoint (task/goal loop only), add (list created when missing), add-many, new-list, update (title/body of an existing task), log, move, import, init. add/update/complete start the auto loop first when auto mode is "on" and no loop is active yet. Never read or modify the backlog file by any other means (no file tools, no grep/cat/sed). Read ${REFERENCE_DOC} for per-action parameters and edge cases.`,
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
				Type.Literal('update'),
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
			category: Type.Optional(Type.String({ description: 'List (created when missing).' })),
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
			const sessionPath = autoTodoPath(ctx);
			// Import targets the session's ralph file, which may not exist yet, so
			// it runs before the target read below.
			if (params.action === 'import') {
				return withBacklogLock(sessionPath, async () => {
					if (!params.file) throw new Error('import requires the file path.');
					const outcome = await importMarkdownBacklog(ctx.cwd, params.file, sessionPath, {
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
				});
			}
			// Target: the active loop's backlog, else the session's ralph file.
			const todoPath = state?.enabled ? state.todoPath : sessionPath;
			// The first mutation of the session backlog enables the auto loop when
			// auto mode is "on" and no loop is active yet: the context-budget
			// intercept would arm the same loop later (at the budget), this moves
			// the arming up to the first recorded todo. An explicit /ralph stop
			// does not block this: the recorded todo is a new request that
			// supersedes the stop (the stop only suspends the automatic
			// context-budget intercept). An active loop still wins. The
			// armAutoLoop promise cache keeps concurrent sibling calls from arming
			// two loops.
			let armedNow = false;
			const armingAction =
				params.action === 'add' || params.action === 'add-many' || params.action === 'update' || params.action === 'complete';
			if (armingAction && !state?.enabled && todoPath === sessionPath && config.autoMode === 'on') {
				const armed = await armAutoLoop(ctx);
				armedNow = armed !== undefined;
			}
			const isSession = todoPath === sessionPath;
			// Init bootstraps a missing backlog file, so it runs before the target read.
			if (params.action === 'init') {
				return withBacklogLock(todoPath, async () => {
					const status = await inspectInitTarget(todoPath);
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
						Backlog.empty().save(todoPath);
					} catch (error) {
						throw new Error(`could not write ${todoPath}: ${error instanceof Error ? error.message : String(error)}`);
					}
					return {
						content: [{ type: 'text', text: `Created empty Ralph backlog at ${todoPath}. Add tasks with action "add" and lists with action "new-list".` }],
						details: { action: 'init', task: null }
					};
				});
			}
			return withBacklogLock(todoPath, async () => {
				const backlog = await loadTargetBacklog(todoPath, 'ralph_todo');

				let mutated = false;
				let output: string;
				// Scope: the active loop's category when its backlog is the
				// target — except the auto loop, which works through all lists
				// (global numbering); the session backlog and idle reads are
				// unscoped.
				const scope =
					state?.enabled && state.todoPath === todoPath && state.mode !== 'auto'
						? state.category
						: undefined;
				const armedNote = armedNow ? ' The Ralph auto loop was started (iteration 1).' : '';
				switch (params.action) {
					case 'next': {
						// On the session backlog, reference entries ("Goal: " /
						// "Findings: ") are not work items: skip them so the
						// iteration never stalls on one.
						if (isSession) {
							const open = backlog.listTasks(scope).filter((task) => !task.done);
							const task = open.find((task) => !isReferenceTaskTitle(task.title));
							if (!task) {
								const references = open.filter((task) => isReferenceTaskTitle(task.title));
								output =
									references.length > 0
										? `No open work tasks remain (open reference entries, not work: ${references
													.map((reference) => reference.title)
												.join('; ')}).`
										: 'No open work tasks remain.';
								break;
							}
							output = formatNextTask(backlog, task, scope);
							break;
						}
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
							? state.rotateOn === 'task'
								? `Marked task ${number} "${task.title}" done${recorded ? ' and recorded the completion log entry' : ''}. Stop working now — the iteration is finished; the loop records the completion and starts a fresh iteration.`
								: `Marked task ${number} "${task.title}" done${recorded ? ' and recorded the completion log entry' : ''}. Continue with the next open task.${armedNote}`
							: `Marked task ${number} "${task.title}" done in ${todoPath}${recorded ? ' and recorded the completion log entry' : ''}.${armedNote}`;
						break;
					}
					case 'checkpoint': {
						if (!state?.enabled) throw new Error('checkpoint requires an active Ralph loop (start one with /ralph start).');
						if (state.mode === 'auto') {
							throw new Error('checkpoint is not available in the auto loop: it records progress with add/update at the context budget.');
						}
						if (!params.task || !params.note) throw new Error('checkpoint requires the task number and a note.');
						const task = backlog.setCheckpoint(params.task, params.note.trim(), state.iteration, scope);
						mutated = true;
						const number = backlog.taskNumbers(scope).get(task.id) ?? task.id;
						output = `Checkpoint recorded for task ${number} (iteration ${state.iteration}). Stop working now; a fresh iteration will continue from it.`;
						break;
					}
					case 'add': {
						if (!params.title) throw new Error('add requires a title.');
						// Category rule: the session backlog auto-creates missing
						// lists and defaults to the loop's category (task/goal loop)
						// or the session category (no loop / auto loop). Legacy
						// project-backlog loops (restored state) still need an
						// existing list.
						let targetCategory = params.category?.trim();
						if (!targetCategory) {
							if (isSession) {
								targetCategory =
									state?.enabled && state.todoPath === todoPath && state.category
										? state.category
									: autoCategoryName(ctx.sessionManager.getSessionName());
							} else {
								throw new Error('add requires a category (an existing list); create it first with action "new-list"');
							}
						}
						if (!backlog.categories().includes(targetCategory)) {
							if (isSession) backlog.createList(targetCategory);
							else {
								throw new Error(`no list named "${targetCategory}" (lists: ${backlog.categories().join(', ') || 'none'}); create it first with action "new-list"`);
							}
						}
						const task = backlog.addTask({
							title: params.title,
							body: params.body,
							category: targetCategory
						});
						mutated = true;
						const number = backlog.taskNumbers(scope).get(task.id) ?? backlog.taskNumbers().get(task.id) ?? task.id;
						output = `Added task ${number} "${task.title}" in category "${targetCategory}".${armedNote}`;
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
						if (!isSession && missingLists.length > 0) {
							throw new Error(
								`no list named ${missingLists.map((name) => `"${name}"`).join(', ')} (lists: ${backlog.categories().join(', ') || 'none'}); create it first with action "new-list"`
							);
						}
						for (const name of missingLists) backlog.createList(name);
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
					case 'update': {
						if (!params.task) throw new Error('update requires the task number.');
						if (params.title === undefined && params.body === undefined) {
							throw new Error('update requires a title and/or body.');
						}
						const changes: { title?: string; body?: string | null } = {};
						if (params.title !== undefined) changes.title = params.title;
						if (params.body !== undefined) changes.body = params.body;
						const task = backlog.updateTask(params.task, changes, scope);
						mutated = true;
						const number = backlog.taskNumbers(scope).get(task.id) ?? backlog.taskNumbers().get(task.id) ?? task.id;
						output = `Updated task ${number} "${task.title}".${armedNote}`;
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
					// Live status: the footer's task count must not wait for the
					// settle to reflect mutations made mid-turn.
					await commitBacklog(todoPath, backlog, ctx, scope);
				}
				return {
					content: [{ type: 'text', text: output }],
					details: { action: params.action, task: params.task ?? null }
				};
			});
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
	// targets the loop's backlog; otherwise the session's ralph file, so the
	// goal can be inspected from chat anytime.
	pi.registerTool({
		name: 'ralph_goal',
		label: 'Ralph goal',
		description:
			`Read/update the single goal of the Ralph backlog (active loop\'s backlog, else the session\'s ralph file). In the goal loop the goal is the user\'s contract: its title/body are read-only; change only its state via this tool. In the auto loop the goal is the model-maintained big picture: set creates or replaces it, checkpoint records progress toward it. Actions: show, set (auto loop only), checkpoint (goal or auto loop), complete, confirm, withdraw (the last three require the active goal loop). complete requires a full verification run of every verification command required by the goal and the backlog, with evidence; never claim an unverified completion. After the user answers a completion approval: approved → record the decision, call ralph_resolve_decision, then confirm; rejected → withdraw with what is missing. Read ${REFERENCE_DOC} for per-action details.`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal('show'),
				Type.Literal('set'),
				Type.Literal('checkpoint'),
				Type.Literal('complete'),
				Type.Literal('confirm'),
				Type.Literal('withdraw')
			]),
			title: Type.Optional(
				Type.String({
					description: 'The goal\'s title (set, auto loop only).'
				})
			),
			body: Type.Optional(
				Type.String({
					description: 'The goal\'s body as markdown bullets (set, auto loop only); an empty string clears it.'
				})
			),
			note: Type.Optional(
				Type.String({
					description:
					'Checkpoint note (checkpoint), completion evidence (complete), or withdrawal note describing what is missing (withdraw).'
				})
			)
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Target: the active loop's backlog, else the session's ralph file.
			const todoPath = state?.enabled ? state.todoPath : autoTodoPath(ctx);
			return withBacklogLock(todoPath, async () => {
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
					case 'set': {
						if (!state?.enabled) throw new Error('set requires an active Ralph loop (start one with /ralph start).');
						if (state.mode !== 'auto') {
							throw new Error('set is not available in the goal loop: the goal is the user\'s contract (set it with /ralph set-goal or the /ralph home view).');
						}
						if (!params.title?.trim()) throw new Error('set requires a title.');
						const updated = backlog.setGoal({ title: params.title.trim(), body: params.body });
						mutated = true;
						syncGoalState();
						output = `Goal "${updated.title}" ${goal ? 'updated' : 'created'} in ${todoPath}.`;
						break;
					}
					case 'checkpoint': {
						if (!state?.enabled) throw new Error('checkpoint requires an active Ralph loop (start one with /ralph start).');
						if (state.mode !== 'goal' && state.mode !== 'auto') {
							throw new Error('checkpoint requires an active goal or auto loop (start one with /ralph start).');
						}
						if (!params.note) throw new Error('checkpoint requires a note.');
						if (!goal) throw new Error(`no goal in ${todoPath}`);
						const updated = backlog.setGoalCheckpoint(params.note.trim(), state.iteration);
						mutated = true;
						if (state.mode === 'auto') {
							output = `Checkpoint recorded for the goal "${updated.title}" (iteration ${state.iteration}). Continue working.`;
							break;
						}
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
						backlog.save(todoPath);
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
			});
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

	const startFreshIteration = (ctx: ExtensionContext) => {
		void (async () => {
			if (!state?.enabled) return;
			const reason = state.rotationReason ?? 'completed-task';
		try {
				// The rotation logic compares text snapshots; render the on-disk
				// backlog (SQLite file) into that form.
				const currentTodo = Backlog.open(state.todoPath).render();
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
				refreshCounts(currentTodo, countCategory(state));
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
	 * Set up the auto loop's durable state: the per-session auto backlog
	 * (<session-id>.db in the global agent directory) with its
	 * auto-created session category, the loop state, and the ralph_todo tool
	 * activation. Shared by /ralph start and the context-budget intercept
	 * (auto mode "on"). Returns undefined (with a notification) when the setup
	 * fails.
	 */
	const setupAutoLoop = async (ctx: ExtensionContext): Promise<RalphState | undefined> => {
		const todoPath = autoTodoPath(ctx);
		try {
		let backlog: Backlog;
		try {
			backlog = Backlog.open(todoPath);
		} catch (error) {
			if (isMissingFileError(error)) {
				backlog = Backlog.empty();
			} else {
				ctx.ui.notify(
					`Ralph auto mode needs a ralph-format backlog: ${error instanceof Error ? error.message : String(error)}. Delete or replace the file first.`,
					'warning'
				);
				return undefined;
			}
		}
		const category = autoCategoryName(ctx.sessionManager.getSessionName());
		// A restarted loop continues the session's existing category.
		if (!backlog.categories().includes(category)) backlog.createList(category);
		const rendered = backlog.render();
		backlog.save(todoPath);
		refreshCounts(rendered);
			const next: RalphState = {
				enabled: true,
				todoPath,
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
				rotateOn: rotateOnFor('auto', config),
				category
			};
			persistState(next);
			syncToolActivation();
			updateStatus(ctx);
			compactionGateNotified = false;
			ctx.ui.notify(`Ralph auto loop: state in ${todoPath}, session category "${category}"`, 'info');
			return next;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Ralph auto loop could not start: ${message}`, 'error');
			return undefined;
		}
	};

	/**
	 * Arm the auto loop at the context budget (auto mode "on"). The promise
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
	// validation (idle, known category, open tasks) and the same state setup.
	const startLoop = async (ctx: ExtensionCommandContext, files: RalphStartFiles): Promise<void> => {
		if (state?.enabled) {
			ctx.ui.notify('Ralph loop is already active — /ralph stop to end it first', 'info');
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify('Wait for the current agent run to finish before starting Ralph', 'warning');
			return;
		}

		const { category: requestedCategory, goal } = files;
		// Every loop runs on the session's ralph file (<session-id>.db in the
		// global agent directory). The auto loop is selected by the auto mode
		// setting (on): a plain /ralph start uses it with an auto-created
		// session category. An explicit --goal start is unaffected.
		const auto = !goal && config.autoMode !== 'off';
		const todoPath = autoTodoPath(ctx);
		let category = requestedCategory;
		try {
			let baselineTodo: string;
			let backlog: Backlog;
			if (auto) {
				if (requestedCategory !== undefined) {
					ctx.ui.notify(
						`Auto mode manages its own session category; set auto mode to "off" in /ralph config to use a custom category.`,
						'warning'
					);
					return;
				}
				const next = await setupAutoLoop(ctx);
				if (!next) return;
				pi.sendUserMessage(iterationPrompt(next));
				return;
			} else {
				// The session's ralph file is created when missing (like the
				// auto loop); an existing file must be a ralph-format backlog.
				try {
					backlog = Backlog.open(todoPath);
				} catch (error) {
					if (isMissingFileError(error)) {
						backlog = Backlog.empty();
					} else {
						ctx.ui.notify(
							`Ralph loops run on ralph-format backlogs only: ${error instanceof Error ? error.message : String(error)}. Delete or replace the file first.`,
							'warning'
						);
						return;
					}
				}
				// The baseline is the backlog as the loop starts; the goal-mode
				// list creation below re-renders it before the loop state is set.
				baselineTodo = backlog.render();
				if (goal) {
					const goalRecord = backlog.goal();
					if (!goalRecord) {
						ctx.ui.notify(`Ralph goal loop will not start because ${todoPath} has no goal`, 'warning');
						return;
					}
					if (goalRecord.status === 'done') {
						ctx.ui.notify('Ralph goal loop will not start because the goal is already complete', 'info');
						return;
					}
				}
				if (requestedCategory !== undefined && !backlog.categories().includes(requestedCategory) && goal) {
					// The goal loop's planning iteration works in the plan's list:
					// create a requested new list up front (the task loop refuses
					// an empty scope below instead).
					backlog.createList(requestedCategory);
				}
				// Goal mode allows zero open tasks: an empty plan is the planning
				// state, not a finished loop.
				if (!goal) {
					const counts = backlog.counts();
					if (counts.total === 0) {
						ctx.ui.notify(
							'Ralph loop will not start: the session backlog is empty — add tasks first (ralph_todo action "add" or /ralph import).',
							'info'
						);
						return;
					}
					if (requestedCategory !== undefined && backlog.listTasks(requestedCategory).length === 0) {
						ctx.ui.notify(`Ralph loop will not start because category "${requestedCategory}" has no tasks`, 'info');
						return;
					}
					if (isBacklogFinished(baselineTodo, requestedCategory)) {
						ctx.ui.notify('Ralph loop will not start because all TODO items are complete', 'info');
						return;
					}
				}
				// Persist the (possibly new or list-extended) backlog.
				backlog.save(todoPath);
				baselineTodo = backlog.render();
			}
			refreshCounts(baselineTodo, category);
			const next: RalphState = {
				enabled: true,
				todoPath,
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
				rotateOn: rotateOnFor(goal ? 'goal' : 'tasks', config),
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
				`Could not start the Ralph loop on the session backlog ${todoPath}: ${message}`,
				'error'
			);
		}
	};

	const sendRecordingPrompt = (ctx: ExtensionContext, options?: { midTurn?: boolean }) => {
		if (!state) return;
		// Every rotation first records progress in a dedicated turn. That
		// turn's settled event starts the clean context that continues from the
		// recorded state instead of the old conversation.
		const prompt = recordingPromptFor(state);
		// When the budget is crossed mid-turn, steer the instruction into the
		// running turn so the model stops at the next tool boundary instead of
		// the turn running on until it settles on its own.
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
				? completedTaskNumbers(state.baselineTodo, options.currentTodo, countCategory(state))
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

	// Dynamic tool loading (pi "defer_loading"): the four ralph tools stay
	// inactive until ralph_enable or /ralph start activates them additively.
	// They carry no promptSnippet/promptGuidelines on purpose — activating a
	// tool with prompt metadata rebuilds the system prompt and invalidates the
	// cached prefix, even on providers with native deferred loading. All
	// behavioural rules live in the tool descriptions instead. The tool
	// definitions themselves are part of every request (rendered into the
	// prompt by the provider's chat template), so the tool set must also stay
	// stable mid-session: syncToolActivation only ever adds tools, and the
	// one addition that would otherwise land mid-session (ralph_todo when the
	// auto loop arms at the context budget) is moved to session start.

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
		// The persisted state may predate the SQLite migration: when the
		// recorded backlog path no longer exists but its format sibling does
		// (a .ralph text file migrated to .db, or vice versa), follow the
		// sibling so the loop keeps operating on the migrated backlog.
		if (state && !(await pathExists(state.todoPath))) {
			const sibling = Backlog.formatSibling(state.todoPath);
			if (sibling !== state.todoPath && (await pathExists(sibling))) {
				state = { ...state, todoPath: sibling };
			}
		}
		// Sessions created before the config entry retain their last active setting.
		if (state && !hasSessionConfig) {
			config = {
				contextThresholds: { [DEFAULT_MODEL_CONFIG_KEY]: state.contextThreshold },
				autoApproveDecisions: state.autoApproveDecisions,
				maxIterations: state.maxIterations,
				compactionMode: DEFAULT_COMPACTION_MODE,
				autoMode: DEFAULT_AUTO_MODE,
				rotateOn: DEFAULT_ROTATE_ON
			};
		}

		// The global store (<agent dir>/ralph/config.json) keeps the settings in a
		// "defaults" section (the normal config) and a "dirs" section per directory
		// and, for git repositories, per branch — outside the project.
		// Resolution: the directory's entry, then the legacy project file (the
		// directory's own older setting), then the defaults section.
		let store: RalphConfigStore | undefined;
		const globalPath = globalConfigPath();
		try {
			store = parseConfigStore(JSON.parse(await readFile(globalPath, 'utf8')));
		} catch (error) {
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Ralph configuration could not be loaded from ${globalPath}: ${message}`, 'warning');
			}
		}
		let savedConfig = store ? normalizeConfig(directoryConfigFor(store, ctx.cwd, gitBranch(ctx.cwd))) : undefined;
		// Legacy: the project file predates the global store. It is read but never
		// updated, so point the user at it either way — in use (it shadows the
		// defaults section) or ignored (a store entry wins), it can go away.
		const legacyPath = projectConfigPath(ctx.cwd);
		if (savedConfig) {
			try {
				await access(legacyPath);
				ctx.ui.notify(
					`A legacy Ralph config exists at ${legacyPath} but is ignored while the global store has a setting for this directory — you can delete the file.`,
					'warning'
				);
			} catch {
				// No legacy file: nothing to point out.
			}
		} else {
			try {
				const legacy = normalizeConfig(JSON.parse(await readFile(legacyPath, 'utf8')) as unknown);
				if (legacy) {
					savedConfig = legacy;
					ctx.ui.notify(
						`Found a legacy Ralph config at ${legacyPath} — it is only read, never updated. Re-save your settings with /ralph config (global store: ${globalPath}), then delete the file.`,
						'warning'
					);
				}
			} catch (error) {
				if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Ralph configuration could not be loaded from ${legacyPath}: ${message}`, 'warning');
				}
			}
		}
		if (!savedConfig) {
			savedConfig = normalizeConfig(store?.defaults);
		}
		if (savedConfig) {
			config = savedConfig;
			if (state?.enabled) {
				state = {
					...state,
					autoApproveDecisions: config.autoApproveDecisions,
					maxIterations: config.maxIterations,
					contextThreshold: contextThresholdFor(config, ctx)
				};
			}
		}
		if (state?.enabled) {
			try {
				const currentTodo = Backlog.open(state.todoPath).render();
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state. Auto mode never
				// stops on an empty backlog.
				if (state.mode !== 'goal' && state.mode !== 'auto' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				refreshCounts(currentTodo, countCategory(state));
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
		// Auto mode arms the auto loop without a /ralph start when the session
		// already runs over its context budget (e.g. a resumed long session) —
		// the finish-up turn records todos for the next iteration, which then
		// continues from the backlog. The loop also arms on the first
		// ralph_todo add/complete; /ralph start begins it immediately.
		if (!state?.enabled && config.autoMode === 'on') {
			const fraction = contextUsageFraction(ctx);
			if (fraction !== undefined && fraction >= contextThresholdFor(config, ctx)) {
				const next = await setupAutoLoop(ctx);
				if (next) queueRotation(ctx, 'context-limit');
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
		} else if (!state?.enabled && config.autoMode === 'on' && !autoInterceptSuspended && !turnStartedOverBudget) {
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

	pi.on('input', (event, ctx) => {
		if (!state?.enabled || event.source === 'extension') return;

		if (state.blocked) {
			const question = state.blockedItem ?? 'the pending Ralph decision';
			return {
				action: 'transform',
				text: `Ralph is paused in this session pending this decision:\n${question}\n\nThe user replied:\n${event.text}\n\nWork with the user to make the decision precise. Do not resume implementation yet. If more information or a different choice is needed, explain the exact remaining question and call ralph_request_decision again. Once the answer is sufficient, record the decision, the user as approver, rationale, and evidence in the appropriate versioned documentation; update a related TODO decision item only for audit purposes, never to unblock Ralph; then call ralph_resolve_decision with the documentation path and a concise resolution. That tool unblocks the session, after which continue the previously blocked work.`
			};
		}

		// A typed message resumes a paused loop: the user's text is extra info
		// for the loop, not a side conversation. Extension commands (e.g.
		// /ralph stop) never reach this handler.
		if (state.paused) {
			persistState({ ...state, paused: false });
			updateStatus(ctx);
			if (state.rotationQueued && state.rotationCheckpointing) {
				// The progress-recording turn was interrupted: re-run it, carrying
				// the user's extra info into the recorded state.
				return {
					action: 'transform',
							text: `${recordingPromptFor(state)}\n\n${renderPrompt('recording-extra-info', { extraInfo: event.text })}`
				};
			}
			// No rotation was pending: continue the interrupted iteration with
			// the user's extra info.
			return {
				action: 'transform',
				text: resumeWithExtraInfoPrompt(event.text)
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
			if (config.autoMode === 'on' && !autoInterceptSuspended && !userAborted) {
				const fraction = contextUsageFraction(ctx);
				if (fraction !== undefined && fraction >= contextThresholdFor(config, ctx)) {
					const armed = await armAutoLoop(ctx);
					if (armed) queueRotation(ctx, 'context-limit');
				}
			}
			return;
		}
		// A paused loop stays paused: settles must not queue rotations or fresh
		// iterations (a typed message resumes the loop before its turn runs).
		if (state.paused) return;
		if (userAborted) {
			if (state.stopRequested) {
				stopLoop(ctx, 'Ralph loop stopped after the current iteration');
			} else {
				pauseLoop(ctx, 'Ralph loop paused (Escape) — type a message to resume it with extra info');
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
				const currentTodo = Backlog.open(state.todoPath).render();
				refreshCounts(currentTodo, countCategory(state));
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state. Auto mode never
				// stops on an empty backlog.
				if (state.mode !== 'goal' && state.mode !== 'auto' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				if (state.rotateOn === 'task' && hasCompletedTodoItem(state.baselineTodo, currentTodo, countCategory(state))) {
					queueRotation(ctx, 'completed-task', { currentTodo });
					return;
				}
				// Goal mode: a grown plan (task policy) or a phase change (budget
				// policy) is a progress boundary too — the plan update gets its
				// commit before the loop ends.
				if (state.mode === 'goal' && state.rotateOn === 'task' && planGrew(state.baselineTodo, currentTodo, state.category)) {
					queueRotation(ctx, 'plan-updated');
					return;
				}
				if (state.mode === 'goal' && state.rotateOn === 'budget' && goalPhaseChanged(state.baselineTodo, currentTodo, state.category)) {
					queueRotation(ctx, 'phase-changed');
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
			const currentTodo = Backlog.open(state.todoPath).render();
			refreshCounts(currentTodo, countCategory(state));
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

			// Rotation per the loop's policy (rotateOn, resolved at loop start).
			// Under "task", completing an item is a hard context boundary: it must
			// win over the proactive threshold check below, because each rotation
			// inserts a marker that removes preceding turns from model context,
		// while context-limit first records the finish-up. Under "budget",
		// completions are progress, not a boundary (the nudge below keeps the
		// loop moving).
			if (state.rotateOn === 'task' && hasCompletedTodoItem(state.baselineTodo, currentTodo, countCategory(state))) {
				if (state.iteration >= state.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after completing iteration ${state.iteration}/${state.maxIterations}`);
					return;
				}
				queueRotation(ctx, 'completed-task', { currentTodo });
				return;
			}

			// Goal mode: under "task" a grown plan (new open tasks, no
			// completions) is a progress boundary that rotates with a commit-only
			// recording turn; under "budget" the model keeps working on the new
			// tasks in the same iteration, and only a phase change (planning →
			// execution → re-evaluation) rotates — without it a finished plan with
			// context headroom would never reach the re-evaluation prompt and the
			// loop would stall.
			if (state.mode === 'goal' && state.rotateOn === 'task' && planGrew(state.baselineTodo, currentTodo, state.category)) {
				if (state.iteration >= state.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after completing iteration ${state.iteration}/${state.maxIterations}`);
					return;
				}
				queueRotation(ctx, 'plan-updated');
				return;
			}
			if (state.mode === 'goal' && state.rotateOn === 'budget' && goalPhaseChanged(state.baselineTodo, currentTodo, state.category)) {
				if (state.iteration >= state.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after completing iteration ${state.iteration}/${state.maxIterations}`);
					return;
				}
				queueRotation(ctx, 'phase-changed');
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

			// A budget-rotating loop must not idle after a completion — start the
			// next open work task instead of waiting for the user to type
			// "continue".
			if (
				state.rotateOn === 'budget' &&
				hasCompletedTodoItem(state.baselineTodo, currentTodo, countCategory(state)) &&
				openWorkTaskCount(currentTodo, countCategory(state)) > 0
			) {
					pi.sendUserMessage(`${automatedPrefix()}${renderPrompt('continue-loop', {})}`, { deliverAs: 'followUp' });
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
					`The auto loop stores its state in a per-session file in the ralph directory of pi's global agent directory (<session-id>.db) with an auto-created session category, rotates per the rotation policy (default: the context budget — the model finishes up and records todos for the next iteration), and uses the ralph_todo tool. off: nothing automatic. on: the loop arms itself when the context crosses the budget (at session start or mid-session) or on the first ralph_todo add/complete on the session backlog. /ralph start begins the auto loop immediately with an iteration prompt unless the mode is off (an explicit --goal start is unaffected).`,
				currentValue: config.autoMode,
				values: ['off', 'on']
			},
			{
				id: 'rotateOn',
				label: 'Rotation policy',
				description:
					'When a fresh iteration starts: task — after every completed task (planned, feature-sized backlogs); budget — only at the context budget, working task after task (fine-grained rolling handoff todos); default — task for the task/goal loops, budget for the auto loop. Applies to loops started after the change.',
				currentValue: config.rotateOn,
				values: ['default', 'task', 'budget']
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
							: id === 'rotateOn'
								? { ...config, rotateOn: value as RotateOn }
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
							: id === 'rotateOn'
								? `rotation policy ${next.rotateOn}`
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

	/**
	 * Open the Ralph home view (bare /ralph or /ralph <file>): a pinned goal
	 * row above the list rows; enter on a list opens the task view for it.
	 * Source: an explicit file, else the active loop's backlog, else the
	 * session's ralph file.
	 */
	const openHome = async (ctx: ExtensionCommandContext, fileArg?: string): Promise<void> => {
		const candidates = fileArg
			? [resolveProjectFile(ctx.cwd, fileArg)].filter((p): p is string => p !== undefined)
			: state?.enabled
				? [state.todoPath]
				: [autoTodoPath(ctx)];
		let todoPath: string | undefined;
		for (const candidate of candidates) {
			if (!candidate) continue;
			// The path may predate the SQLite migration: when the recorded name
			// no longer exists, follow the format sibling (.ralph ↔ .db).
			if (await pathExists(candidate)) {
				todoPath = candidate;
			} else {
				const sibling = Backlog.formatSibling(candidate);
				if (sibling === candidate || !(await pathExists(sibling))) continue;
				todoPath = sibling;
			}
			break;
		}
		if (!todoPath) {
			ctx.ui.notify(
				fileArg
					? `Could not read ${fileArg}`
					: 'No backlog found: start a loop or add tasks with the ralph_todo tool (or pass a file: /ralph <file.db>)',
				'error'
			);
			return;
		}
		const rel = relative(ctx.cwd, todoPath);
		const title = rel && !rel.startsWith('..') ? rel : basename(todoPath);
		const loadBacklog = (): Backlog | undefined => {
			try {
				// The view only renders ralph backlogs; Markdown backlogs must be
				// imported first (see below).
				return Backlog.open(todoPath!);
			} catch {
				return undefined;
			}
		};
		let initial: Backlog | undefined;
		try {
			initial = Backlog.open(todoPath);
		} catch (error) {
			if (error instanceof NotRalphBacklogError) {
				ctx.ui.notify('Todo entries empty. Import data with /ralph import', 'info');
				return;
			}
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
				// Keep the status bar's cached task count in sync with GUI
				// mutations, like the ralph tool paths do.
				await commitBacklog(todoPath, backlog, ctx, countCategory(state));
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
							void startLoop(ctx, { category: loopCategory, goal: false });
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
							void startLoop(ctx, { goal: true });
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
		description: 'Ralph home and loop control: /ralph [file] opens the home view (TUI); subcommands: [start|import|set-goal|stop|status|config]',
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const options: AutocompleteItem[] = [
				{
					value: 'start',
					label: 'start',
					description: 'Runs on the session\'s ralph file (created when missing). Scope the backlog with --category <name>; start the goal loop with --goal (the backlog needs a goal). Markdown TODOs must be imported first: /ralph import TODO.md.'
				},
				{ value: 'import', label: 'import', description: 'Import a Markdown TODO backlog into the ralph format: /ralph import <file.md> [--category name] [--force]. Always imports into the session\'s ralph file, merging into an existing backlog. Each source file is only imported once.' },
				{ value: 'set-goal', label: 'set-goal', description: 'Set the backlog goal from a file: /ralph set-goal <goal.md>. The first non-empty line (optionally an H1 heading) is the title, the rest is the body. Targets the active loop\u2019s backlog or the session\'s ralph file. Replaces an open goal; a claimed or done goal must be resolved first.' },
				{ value: 'stop', label: 'stop', description: 'Stop after the current iteration. --force stops immediately, aborting the current run and skipping the rotation/finish-up boundary.' },
				{ value: 'status', label: 'status', description: 'Show the Ralph loop state.' },
				{ value: 'config', label: 'config', description: 'Configure fresh-context rotation and decision approval.' }
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const commandArgs = parseCommandArguments(args.trim());
			if (!commandArgs) {
				ctx.ui.notify('Usage: /ralph start [--category name] [--goal] (quote values containing spaces)', 'warning');
				return;
			}			const command = commandArgs[0]?.toLowerCase() ?? '';
			if (command === 'stop') {
				if (!state?.enabled) {
					ctx.ui.notify('Ralph loop is already stopped', 'info');
					return;
				}
				const stopArgs = commandArgs.slice(1);
				if (stopArgs.length > 1 || (stopArgs[0] !== undefined && stopArgs[0] !== '--force')) {
					ctx.ui.notify('Usage: /ralph stop [--force]', 'warning');
					return;
				}
				if (stopArgs[0] === '--force') {
					// Force stop: end the loop immediately instead of waiting for the
					// iteration/rotation boundary — abort the in-flight run (iteration,
					// recording turn, or compaction) and drop the pending rotation.
					// Progress since the last recording turn is not recorded; the
					// durable state is the backlog and the repository.
					if (!ctx.isIdle()) ctx.abort();
					// A force stop of the auto loop is a hard kill: turn the persisted
					// auto mode off as well, so the status (which shows the setting)
					// matches reality and a fresh session does not re-arm the loop at
					// the context budget. A graceful stop only suspends the intercept
					// for this session and keeps the setting.
					const autoModeOff = state.mode === 'auto' && config.autoMode === 'on';
					if (autoModeOff) persistConfig(ctx, { ...config, autoMode: 'off' });
					stopLoop(ctx, autoModeOff ? 'Ralph loop stopped (forced); auto mode is now off' : 'Ralph loop stopped (forced)');
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
								? `${loopName} is paused — type a message to resume it with extra info`
				: state.rotationCheckpointing
					? state.rotationReason === 'completed-task'
						? `${loopName} is recording the completed task’s progress`
						: state.rotationReason === 'plan-updated'
							? `${loopName} is committing the updated plan`
							: state.rotationReason === 'phase-changed'
								? `${loopName} is finishing up after the goal phase change`
								: `${loopName} is finishing up and recording todos for the next iteration`
									: state.stopRequested
										? `${loopName} will stop after the current iteration`
										: state.rotationQueued
											? `${loopName} is starting a fresh iteration`
											: `${loopName} is active · iteration ${state.iteration}/${state.maxIterations}${taskCount ? ` · task: ${taskCount.current}/${taskCount.total}${taskCount.done ? ' (done)' : ''} (iteration ${state.taskIteration})` : ''}${state.mode === 'goal' && goalState ? ` · goal: ${goalState}` : ''}`,
					'info'
				);
				return;
			}
			const knownCommands = ['start', 'import', 'set-goal', 'stop', 'status', 'config'];
			if (command !== '' && !knownCommands.includes(command)) {
				// The first non-subcommand argument is a backlog file for the home view.
				if (ctx.mode !== 'tui') {
					ctx.ui.notify(
						`Unknown subcommand "${commandArgs[0]}" — usage: /ralph [start|import|set-goal|stop|status|config]`,
						'error'
					);
					return;
				}
				await openHome(ctx, commandArgs[0]);
				return;
			}
			if (command === '') {
				if (ctx.mode !== 'tui') {
					ctx.ui.notify('Usage: /ralph [start|import|set-goal|stop|status|config] (in TUI: bare /ralph opens the home view)', 'warning');
					return;
				}
				await openHome(ctx);
				return;
			}
			if (command === 'set-goal') {
				const setGoalArgs = parseSetGoalArgs(commandArgs.slice(1));
				if (!setGoalArgs) {
					ctx.ui.notify('Usage: /ralph set-goal <goal-file>', 'warning');
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify('Wait for the current agent run to finish before setting the goal', 'warning');
					return;
				}
				const outcome = await setGoalFromFile(
					ctx.cwd,
					state,
					setGoalArgs,
					state?.enabled ? state.todoPath : autoTodoPath(ctx)
				);
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
				const outcome = await importMarkdownBacklog(ctx.cwd, importArgs.input, autoTodoPath(ctx), {
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
						? `Merged ${outcome.merged.tasks} tasks${outcome.merged.logEntries ? ` and ${outcome.merged.logEntries} log entries` : ''} from ${importArgs.input} into ${outcome.outName}${categoryNote} (backlog now ${counts.open} open / ${counts.total} total). Start with: /ralph start`
						: `Imported ${counts.total} tasks (${counts.open} open) from ${importArgs.input} to ${outcome.outName}${categoryNote}. Start with: /ralph start`,
					'info'
				);
				return;
			}
			const startFiles = parseStartFiles(commandArgs.slice(1));
			if (!startFiles) {
				ctx.ui.notify('Usage: /ralph start [--category name] [--goal]', 'warning');
				return;
			}
			await startLoop(ctx, startFiles);
		}
	});
}
