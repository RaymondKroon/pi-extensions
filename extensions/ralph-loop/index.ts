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
	type Goal,
	type GoalStatus
} from './backlog.ts';
import { createTodosView, type TodosView } from './todos-view.ts';
import { createListPicker, type ListPicker } from './list-picker.ts';

const STATE_TYPE = 'ralph-loop-state';
const CONFIG_TYPE = 'ralph-loop-config';
const CONFIG_FILE_NAME = 'ralph-loop.json';
/** Marks the beginning of an independent Ralph iteration in the same session. */
const CONTEXT_BOUNDARY_TYPE = 'ralph-loop-context-boundary';
const DEFAULT_TODO = 'TODO.ralph';
const DEFAULT_SPEC = 'SPEC.md';
/** Generic planning document bundled with this extension for /ralph-init to adapt. */
const INIT_TEMPLATE_SPEC = join(import.meta.dirname, 'SPEC.template.md');
const DEFAULT_CONTEXT_THRESHOLD = 0.5;
const DEFAULT_AUTO_APPROVE_DECISIONS = false;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MODEL_CONFIG_KEY = '__default__';

type RotationReason = 'completed-task' | 'context-limit';

interface RalphConfig {
	/**
	 * Fresh-context thresholds keyed by provider/model. The default keeps
	 * existing projects working until a model receives an explicit setting.
	 */
	contextThresholds: Record<string, number>;
	autoApproveDecisions: boolean;
	maxIterations: number;
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
	/** Loop policy: the finite task backlog or the single goal. */
	mode: 'tasks' | 'goal';
	todoPath: string;
	specPath: string;
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
		(state.mode === undefined || state.mode === 'tasks' || state.mode === 'goal') &&
		typeof state.todoPath === 'string' &&
		typeof state.specPath === 'string' &&
		typeof state.baselineTodo === 'string' &&
		(state.iteration === undefined || (typeof state.iteration === 'number' && state.iteration >= 1)) &&
		(state.taskIteration === undefined || (typeof state.taskIteration === 'number' && state.taskIteration >= 1)) &&
		(state.taskNumber === undefined || (typeof state.taskNumber === 'number' && state.taskNumber >= 1)) &&
		(state.maxIterations === undefined || (typeof state.maxIterations === 'number' && state.maxIterations >= 1)) &&
		typeof state.contextThreshold === 'number' &&
		(state.autoApproveDecisions === undefined || typeof state.autoApproveDecisions === 'boolean') &&
		typeof state.rotationQueued === 'boolean' &&
		(state.rotationReason === undefined || state.rotationReason === 'completed-task' || state.rotationReason === 'context-limit') &&
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

function isRalphConfig(value: unknown): value is RalphConfig {
	if (!value || typeof value !== 'object') return false;
	const config = value as Partial<RalphConfig>;
	return (
		!!config.contextThresholds &&
		typeof config.contextThresholds === 'object' &&
		Object.values(config.contextThresholds).every(isContextThreshold) &&
		typeof config.autoApproveDecisions === 'boolean' &&
		isMaxIterations(config.maxIterations)
	);
}

function isRalphConfigWithoutMaxIterations(
	value: unknown
): value is Omit<RalphConfig, 'maxIterations'> {
	if (!value || typeof value !== 'object') return false;
	const config = value as Partial<RalphConfig>;
	return (
		!!config.contextThresholds &&
		typeof config.contextThresholds === 'object' &&
		Object.values(config.contextThresholds).every(isContextThreshold) &&
		typeof config.autoApproveDecisions === 'boolean'
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
	if (isRalphConfigWithoutMaxIterations(value)) {
		return { ...value, maxIterations: DEFAULT_MAX_ITERATIONS };
	}
	if (isLegacyRalphConfig(value)) {
		return {
			contextThresholds: { [DEFAULT_MODEL_CONFIG_KEY]: value.contextThreshold },
			autoApproveDecisions: value.autoApproveDecisions,
			maxIterations: value.maxIterations ?? DEFAULT_MAX_ITERATIONS
		};
	}
}

function defaultConfig(): RalphConfig {
	return {
		contextThresholds: {},
		autoApproveDecisions: DEFAULT_AUTO_APPROVE_DECISIONS,
		maxIterations: DEFAULT_MAX_ITERATIONS
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

function formatTokenCount(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

function rightAlign(line: string, width: number): string {
	const fitted = truncateToWidth(line, width);
	return `${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`;
}

function contextUsageLabel(ctx: ExtensionContext, threshold: number): string {
	const fraction = contextUsageFraction(ctx);
	if (fraction === undefined) return `calculating… / ${contextThresholdLabel(threshold)}`;
	const percentage = `${fraction * 100 < 10 ? (fraction * 100).toFixed(1) : Math.round(fraction * 100)}%`;
	const usage = ctx.getContextUsage();
	const thresholdTokens = ctx.model ? ctx.model.contextWindow * threshold : undefined;
	if (usage?.tokens === null || usage?.tokens === undefined || thresholdTokens === undefined) {
		return `${percentage} / ${contextThresholdLabel(threshold)}`;
	}
	return `${percentage} / ${contextThresholdLabel(threshold)} (${formatTokenCount(usage.tokens)} / ${formatTokenCount(thresholdTokens)})`;
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Number the task Ralph is currently working on so the status shows an
 * increasing counter (e.g. task 4/12 once three tasks are complete).
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
	const contextNote =
		reason === 'context-limit'
			? 'The previous iteration reached its context budget and recorded a durable TODO checkpoint. Re-establish facts from the repository and TODO before continuing; do not rely on the old conversation.'
			: reason === 'completed-task'
				? 'A previous TODO item was completed. Start the next independent iteration with a clean review of the repository.'
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
3. Add the whole plan to the backlog with ralph_todo (action "add-many" for the plan, or "add" per task).
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
3. If any criterion is not met, add tasks for the missing work with ralph_todo and stop after recording them.
4. If every criterion is met and verified, call ralph_goal with action "complete" and the evidence. Do not edit ${state.todoPath} directly.

${decisionNote}`;
			}
			return `Run the Ralph goal loop for this repository. ${contextNote}

${backlogNote}

${goalBlock(goal)}

You are executing the goal: keep the plan honest — when reality diverges from the plan, add or adjust tasks with ralph_todo so the backlog always reflects the remaining work.

1. Read ${state.specPath} in full, then call ralph_todo with action "next" to get the next open task${categoryScope}: its number, body, and checkpoint. Use action "list" only when that task is blocked and you need the wider backlog to find an unblocked one.
2. Do not work on a later task${categoryGuard}.
3. Read the relevant code and source evidence, then implement exactly one coherent vertical slice.
4. Add focused tests and run every quality command required by SPEC.md and the backlog.
5. Only after all acceptance criteria pass, call ralph_todo with action "complete" and the task's number. Do not edit ${state.todoPath} directly.
6. Commit the completed iteration locally. Do not push.

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
2. Update that item in ${state.todoPath} with a concise, non-checkbox “Context checkpoint (iteration ${state.iteration})” note. Include completed implementation/test evidence, relevant changed paths, known failures or risks, and the exact next step. Use the actual iteration number shown above in the label — never a placeholder. If the item already has a “Context checkpoint” note, replace it with this one: keep only the single most recent checkpoint, because an older checkpoint’s state and next step are stale. Do not put this in the completion log: the item is not complete.
3. Keep a single exact next step in the checkpoint note.
4. Do not mark the item complete, do not claim unverified work, do not modify product code, and do not commit. Do not continue implementation after recording the checkpoint.

Report the checkpoint path and the next step succinctly.`;
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

/** Extract the readable text from a tool result payload (for abort detection). */
function toolResultText(result: unknown): string {
	if (!result || typeof result !== 'object') return '';
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) =>
			part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string'
				? (part as { text: string }).text
				: ''
		)
		.join(' ');
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
 * created directly as an empty backlog. `--` permits a brief that starts with
 * an option-looking word.
 */
function parseInitFiles(args: string[]): RalphInitFiles | undefined {
	let specFile: string | undefined;
	let todoFile: string | undefined;
	let force = false;
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
	if (resolvedSpec && !prompt) return undefined;
	return {
		specFile: resolvedSpec,
		todoFile: resolvedTodo,
		force,
		prompt
	};
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
	// todos view's list picker. An omitted or empty category falls back to a
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

function initPrompt(specFile: string, prompt: string, force: boolean): string {
	const templateWarning =
		specFile === DEFAULT_SPEC ? '; the target SPEC.md is intentionally allowed because it was explicitly selected' : '';
	return `Create the Ralph specification now. This is planning work only; do not implement the product brief.

Project brief:
${prompt}

Output target: specification: ${specFile}.

First read the bundled generic planning template in full:
- specification template: ${INIT_TEMPLATE_SPEC}

It is the authoritative example for the level of product/engineering detail, durable-spec content, acceptance criteria, decision handling, and source-evidence conventions. Adapt its structure and rigor to this project brief; do not copy its placeholder text or assume the project has an existing ${DEFAULT_SPEC} or ${DEFAULT_TODO}.

Create exactly the target file above${force ? ', replacing the named existing file because --force was explicitly supplied,' : ''}. Do not modify any other file${templateWarning}. Use the write tool to produce a complete Markdown document, not a prose preview. Make it self-contained while linking to the corresponding backlog (${DEFAULT_TODO}) where useful.

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

	const updateStatus = (ctx: ExtensionContext) => {
		const autoApproveDecisions = state?.enabled ? state.autoApproveDecisions : config.autoApproveDecisions;
		const mode = state?.blocked
			? 'waiting'
			: state?.paused
				? 'paused'
				: state?.rotationCheckpointing
					? state?.rotationReason === 'completed-task'
						? 'recording'
						: 'checkpointing'
					: state?.stopRequested
						? 'stopping'
						: state?.rotationQueued || freshIterationPending
							? 'starting'
							: 'on';
		const status = !state?.enabled
			? `Ralph: off${autoApproveDecisions ? ' (auto)' : ''}`
			: `Ralph: ${mode}${autoApproveDecisions ? ' (auto)' : ''} · iteration ${state.iteration}/${state.maxIterations}${state.category ? ` · category: ${state.category}` : ''}${taskCount ? ` · task: ${taskCount.current}/${taskCount.total} (iteration ${state.taskIteration})` : ''} · context: ${contextUsageLabel(ctx, state.contextThreshold)}`;

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
					return [rightAlign(theme.fg('dim', status), width)];
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
		freshIterationPending = false;
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

	pi.registerTool({
		name: 'ralph_request_decision',
		label: 'Request Ralph decision',
		description: 'Pause the active Ralph loop and present a precise decision question to the user.',
		promptSnippet: 'Pause Ralph for a user decision',
		promptGuidelines: [
			'Use ralph_request_decision instead of guessing whenever active Ralph work needs a user decision. Include one precise question and the evidence or options needed to answer it.'
		],
		parameters: Type.Object({
			question: Type.String({ description: 'The exact decision the user must make.' }),
			context: Type.Optional(Type.String({ description: 'Relevant evidence, constraints, and options.' }))
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
		description: 'Unblock an active Ralph loop after the user decision has been documented.',
		promptSnippet: 'Resume Ralph after documenting a user decision',
		promptGuidelines: [
			'Call ralph_resolve_decision only after the user has answered a pending Ralph decision and the decision, approver, rationale, and evidence are recorded in versioned documentation.'
		],
		parameters: Type.Object({
			recordPath: Type.String({ description: 'Repository-relative path of the decision record.' }),
			resolution: Type.String({ description: 'Concise statement of the agreed decision.' })
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
			'Read or update the SQLite-backed Ralph backlog (ralph-format TODO file). With an active loop it targets the loop\'s backlog; otherwise the project\'s TODO.ralph, which must exist first (create it with action "init" or "import"). Tasks are addressed by their position number in the list ("1", "2", …) as shown by list/next. Actions: next (compact view of the first open task — prefer it over list when you only need the next task), list (compact by default: counts, per-list counts, and open tasks; pass category to filter to one list, pass task for a single task detail view (body, checkpoint, and completion log), and verbose: true for completed tasks, checkpoints, and completion log entries), search (case-insensitive substring match over task titles, bodies, checkpoints, and completion log notes; requires query, optionally scoped with category — use it instead of grepping the backlog file), complete, checkpoint (loop only), add, add-many, new-list, log, move, import, init. "add" adds to the current scope, or to an existing list via "category" (it never creates a list); use "new-list" with a name to create a new list explicitly. "add-many" adds several tasks at once via the "tasks" array (all-or-nothing; each entry may set its own category). "log" records a completion entry for a task (requires the task number); pass kind: "reopen" when re-opening a completed task so the entry is marked with a cross instead of a check. "complete" marks the task done; with a note it also records the completion log entry in the same call. "move" reorders a task with direction "up" or "down" (optionally "by" steps) within the list. "import" converts a Markdown TODO file (file) into the ralph format, always merging into the project\'s TODO.ralph; each source file is only imported once. Imported tasks are stamped with category, which defaults to a name derived from the file name (TODO_EMAIL.md → Email). "init" explicitly bootstraps an empty backlog at the target path when it does not exist yet (idempotent; refuses to overwrite a non-ralph file).',
		promptSnippet: 'Read/update the Ralph backlog',
		promptGuidelines: [
			'Use ralph_todo to read or update the ralph-format backlog; never read or modify the backlog file by any other means (no file tools, no grep/cat/sed or other shell commands on the file). Use action "search" to find tasks by keyword.'
		],
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
				Type.String({ description: 'Task number (as shown by list/next, e.g. "3"): the target of complete/checkpoint/log/move; with list: show that single task\'s detail view (body, checkpoint, completion log) instead of the whole backlog.' })
			),
			note: Type.Optional(Type.String({ description: 'Checkpoint note (checkpoint), completion-log entry (log), or completion summary recorded with the task (complete).' })),
			title: Type.Optional(Type.String({ description: 'New task title (add).' })),
			body: Type.Optional(Type.String({ description: 'New task body, markdown bullets (add).' })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: 'Task title.' }),
						body: Type.Optional(Type.String({ description: 'Task body, markdown bullets.' })),
						category: Type.Optional(Type.String({ description: 'Existing list for this task; omit for the current scope.' }))
					}),
					{ description: 'Tasks to add in order (add-many). The batch is all-or-nothing: if any entry is invalid, nothing is added.' }
				)
			),
			name: Type.Optional(Type.String({ description: 'New list name (new-list). Creating a list is explicit and separate from adding a task.' })),
			category: Type.Optional(Type.String({ description: 'Existing list (list: filter the summary to it; add: target list for a new task; search: restrict the match to it). Must already exist; use new-list to create one first. Omit on add to use the current scope. For import: list stamped on the imported tasks; defaults to a name derived from the file name (TODO_EMAIL.md → Email).' })),
			query: Type.Optional(Type.String({ description: 'Case-insensitive substring to search for (search) in task titles, bodies, checkpoints, and completion log notes.' })),
			verbose: Type.Optional(Type.Boolean({ description: 'list: include completed tasks, checkpoints, and completion log entries (default: compact summary of open tasks).' })),
			date: Type.Optional(Type.String({ description: 'YYYY-MM-DD for the log entry (log; defaults to today).' })),
			kind: Type.Optional(
				Type.Union([Type.Literal('done'), Type.Literal('reopen')], {
					description: 'Log entry kind (log; defaults to done). Use reopen when re-opening a completed task.'
				})
			),
			direction: Type.Optional(
				Type.Union([Type.Literal('up'), Type.Literal('down')], {
					description: 'Move direction (move; required for move).'
				})
			),
			by: Type.Optional(Type.Integer({ minimum: 1, description: 'How many positions to move (move; defaults to 1).' })),
			file: Type.Optional(Type.String({ description: 'Markdown TODO file (.md) to import (import); relative path inside the project.' })),
			force: Type.Optional(Type.Boolean({ description: 'Overwrite an existing non-ralph TODO.ralph (import; defaults to false).' }))
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
					const targetCategory = params.category;
					if (targetCategory !== undefined && !backlog.categories().includes(targetCategory)) {
						throw new Error(`no list named "${targetCategory}" (lists: ${backlog.categories().join(', ') || 'none'}); create it first with action "new-list"`);
					}
					const addScope = targetCategory ?? scope;
					const task = backlog.addTask({
						title: params.title,
						body: params.body,
						category: targetCategory
					});
					mutated = true;
					const number = backlog.taskNumbers(addScope).get(task.id) ?? task.id;
					output = `Added task ${number} "${task.title}"${task.category ? ` in category "${task.category}"` : ''}.`;
					break;
				}
				case 'add-many': {
					const items = params.tasks;
					if (!Array.isArray(items) || items.length === 0) {
						throw new Error('add-many requires a non-empty "tasks" array.');
					}
					// Validate the whole batch first so an invalid entry adds nothing.
					const missingLists = [
						...new Set(
							items
								.map((item) => item.category)
								.filter((category): category is string => category !== undefined && !backlog.categories().includes(category))
						)
					];
					if (missingLists.length > 0) {
						throw new Error(
							`no list named ${missingLists.map((name) => `"${name}"`).join(', ')} (lists: ${backlog.categories().join(', ') || 'none'}); create it first with action "new-list"`
						);
					}
					const added = items.map((item) =>
						backlog.addTask({ title: item.title, body: item.body, category: item.category })
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
			'Read or update the single goal of the SQLite-backed Ralph backlog (ralph-format TODO file). With an active loop it targets the loop\'s backlog; otherwise the project\'s TODO.ralph. The goal is the user\'s contract: you are read-only on its title and body — only the user edits them, and you may only change the goal\'s state through this tool. Actions: show (works anywhere; prints the goal\'s title, status, body, evidence, and checkpoint), checkpoint (active goal loop only; replaces the single goal checkpoint — the durable state of task-less planning/re-evaluation iterations), complete (active goal loop only; requires the goal open and no open tasks; the completion bar is a full verification run — run every verification command required by SPEC.md first and pass the evidence; the goal then becomes done).',
		promptSnippet: 'Read/update the Ralph goal',
		promptGuidelines: [
			'Use ralph_goal for the goal of the active goal loop; the goal text is the user\'s contract — you are read-only on it and may only change its state through this tool.',
			'ralph_goal complete is the completion bar: run every verification command required by SPEC.md first and pass the evidence; never claim an unverified completion.'
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal('show'),
				Type.Literal('checkpoint'),
				Type.Literal('complete')
			]),
			note: Type.Optional(
				Type.String({ description: 'Checkpoint note (checkpoint) or completion evidence (complete).' })
			)
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Target: the active loop's backlog, else the project's main backlog.
			const todoPath = state?.enabled ? state.todoPath : resolve(ctx.cwd, 'TODO.ralph');
			const backlog = await loadTargetBacklog(todoPath, 'ralph_goal');
			const goal = backlog.goal();

			let mutated = false;
			let output: string;
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
					backlog.claimGoal(params.note.trim());
					const done = backlog.confirmGoal();
					mutated = true;
					output = `Goal "${done.title}" is done (evidence recorded). Stop working now; the loop records the completion.`;
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
				details: { action: params.action }
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

	const startFreshIteration = (ctx: ExtensionContext) => {
		void (async () => {
			if (!state?.enabled) return;
			const reason = state.rotationReason ?? 'completed-task';
			try {
				const currentTodo = await readRequiredFile(state.todoPath);
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state.
				if (state.mode !== 'goal' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				// Goal mode: never start a fresh iteration once the goal is done.
				if (state.mode === 'goal' && goalStatus(currentTodo) === 'done') {
					stopLoop(ctx, 'Ralph goal loop stopped because the goal is complete');
					return;
				}
				taskCount = countTodoTasks(currentTodo, state?.category);
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

				// Keep the audit trail in this session, but ensure the next model can
				// only use the durable repository/TODO checkpoint rather than old turns.
				freshIterationPending = true;
				updateStatus(ctx);
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

		const { specFile, todoFile, category, goal } = files;
		const todoPath = resolve(ctx.cwd, todoFile);
		const specPath = resolve(ctx.cwd, specFile);
		try {
			const baselineTodo = await readRequiredFile(todoPath);
			await readRequiredFile(specPath);
			if (!isRalphBacklog(baselineTodo)) {
				ctx.ui.notify(
					`Ralph loops run on ralph-format backlogs only: ${todoFile} is not one. Import it first with /ralph import ${todoFile}`,
					'warning'
				);
				return;
			}
			const backlog = Backlog.parse(baselineTodo);
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
			if (category !== undefined) {
				const known = backlog.categories();
				if (!known.includes(category)) {
					ctx.ui.notify(`Unknown category "${category}" (categories: ${known.join(', ') || 'none'})`, 'warning');
					return;
				}
			}
			// Goal mode allows zero open tasks: an empty plan is the planning
			// state, not a finished loop.
			if (!goal && isBacklogFinished(baselineTodo, category)) {
				ctx.ui.notify('Ralph loop will not start because all TODO items are complete', 'info');
				return;
			}
			taskCount = countTodoTasks(baselineTodo, category);
			const next: RalphState = {
				enabled: true,
				todoPath,
				specPath,
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
			updateStatus(ctx);
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
			state.rotationReason === 'completed-task' ? completionRecordingPrompt(state) : contextCheckpointPrompt(state);
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

	pi.on('session_start', async (_event, ctx) => {
		state = undefined;
		taskCount = undefined;
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
				maxIterations: state.maxIterations
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
				// exhausted: an empty plan is the planning state.
				if (state.mode !== 'goal' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				taskCount = countTodoTasks(currentTodo, state?.category);
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
		updateStatus(ctx);
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
		}
	});

	// Record the stop reason of assistant messages so the settle handler can tell
	// a finished recording turn from one the user aborted.
	let runSawAssistantMessage = true;
	// Set when the user aborts the run while a tool call is executing: the tool
	// ends as an error result and the run can finish without an 'aborted'
	// assistant message, so the user abort must be remembered explicitly.
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
	// assistant message, which the settle-time check alone would miss.
	pi.on('tool_execution_end', (event, ctx) => {
		const toolEvent = event as { isError?: boolean; result?: unknown };
		const resultText = toolResultText(toolEvent.result);
		if ((ctx as { signal?: AbortSignal }).signal?.aborted || (toolEvent.isError === true && /abort/i.test(resultText))) {
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
		if (!state?.enabled || state.blocked) return;
		// A paused loop stays paused: user chat turns and any other settles must
		// not queue rotations or fresh iterations until /ralph resume.
		if (state.paused) return;
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
				taskCount = countTodoTasks(currentTodo, state?.category);
				// Goal mode is done when the goal is done, not when the plan is
				// exhausted: an empty plan is the planning state.
				if (state.mode !== 'goal' && isBacklogFinished(currentTodo, state?.category)) {
					stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
					return;
				}
				if (hasCompletedTodoItem(state.baselineTodo, currentTodo, state.category)) {
					queueRotation(ctx, 'completed-task', { currentTodo });
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
			taskCount = countTodoTasks(currentTodo, state?.category);
			// Goal mode is done when the goal is done, not when the plan is
			// exhausted: an empty plan is the planning state.
			if (state.mode !== 'goal' && isBacklogFinished(currentTodo, state?.category)) {
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
			// records a durable TODO checkpoint.
			if (hasCompletedTodoItem(state.baselineTodo, currentTodo, state.category)) {
				if (state.iteration >= state.maxIterations) {
					stopLoop(ctx, `Ralph loop stopped after completing iteration ${state.iteration}/${state.maxIterations}`);
					return;
				}
				queueRotation(ctx, 'completed-task', { currentTodo });
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
				id: 'autoApproveDecisions',
				label: 'Auto-approve decisions',
				description: 'Continue after a decision request without pausing for your reply; Ralph records the approver as auto-approved.',
				currentValue: config.autoApproveDecisions ? 'enabled' : 'disabled',
				values: ['enabled', 'disabled']
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
			'Create the Ralph spec (generated) and an empty ralph-format backlog: [--spec file] [--todo file] [--force] <project brief>',
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const options: AutocompleteItem[] = [
				{ value: '--spec', label: '--spec', description: 'Generate only this specification file (or pair with --todo).' },
				{ value: '--todo', label: '--todo', description: 'Create only this empty ralph-format backlog file (or pair with --spec).' },
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
					'Usage: /ralph-init [--spec file] [--todo file] [--force] <project brief> (quote paths or briefs containing spaces)',
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

			if (todoPath && todoStatus && (todoStatus.kind === 'missing' || !todoStatus.ralph)) {
				try {
					await mkdir(dirname(todoPath), { recursive: true });
					await writeFile(todoPath, Backlog.empty().render());
				} catch (error) {
					ctx.ui.notify(
						`could not write ${initFiles.todoFile}: ${error instanceof Error ? error.message : String(error)}`,
						'error'
					);
					return;
				}
			}

			if (specPath) {
				ctx.ui.notify('Preparing Ralph specification…', 'info');
				pi.sendUserMessage(initPrompt(initFiles.specFile!, initFiles.prompt, initFiles.force));
				return;
			}
			ctx.ui.notify(
				`Created empty Ralph backlog at ${initFiles.todoFile}. Add tasks with the ralph_todo tool.`,
				'info'
			);
		}
	});

	pi.registerCommand('ralph', {
		description: 'Start or manage the Ralph loop: [start|import|todos|stop|resume|status|config]',
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const options: AutocompleteItem[] = [
				{
					value: 'start',
					label: 'start',
					description: 'Defaults: SPEC.md and TODO.ralph. Override either with --spec <file> or --todo <file>; scope a ralph-format backlog with --category <name>; start the goal loop with --goal (the backlog needs a goal). Markdown TODOs must be imported first: /ralph import TODO.md.'
				},
				{ value: 'import', label: 'import', description: 'Import a Markdown TODO backlog into the ralph format: /ralph import <file.md> [--category name] [--force]. Always imports into TODO.ralph, merging into an existing backlog. Each source file is only imported once.' },
				{ value: 'todos', label: 'todos', description: 'Show the backlog in an interactive list: /ralph todos [file] (defaults to the active loop’s backlog). In the list picker: enter: open, R: rename, q: quit. In the view: a/A add and e edit open a popup form (jk/↑↓ or tab: field, enter: edit/confirm field, ctrl+s: save, esc: cancel), x delete, R rename list, s start a loop on the list, q quit.' },
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
				ctx.ui.notify(
					!state?.enabled
						? 'Ralph loop is stopped'
						: state.blocked
							? `Ralph loop is awaiting your decision: ${state.blockedItem ?? 'no question was recorded'}`
							: state.paused
								? 'Ralph loop is paused — /ralph resume to continue'
								: state.rotationCheckpointing
									? state.rotationReason === 'completed-task'
										? 'Ralph loop is recording the completed task’s progress'
										: 'Ralph loop is recording a durable context checkpoint'
									: state.stopRequested
										? 'Ralph loop will stop after the current iteration'
										: state.rotationQueued
											? 'Ralph loop is starting a fresh iteration'
											: `Ralph loop is active · iteration ${state.iteration}/${state.maxIterations}${taskCount ? ` · task: ${taskCount.current}/${taskCount.total} (iteration ${state.taskIteration})` : ''}`,
					'info'
				);
				return;
			}
			if (command && command !== 'start' && command !== 'import' && command !== 'todos') {
				ctx.ui.notify('Usage: /ralph [start|import|todos|stop|resume|status|config]', 'warning');
				return;
			}
			if (command === 'todos') {
				const fileArg = commandArgs.slice(1)[0];
				if (ctx.mode !== 'tui') {
					ctx.ui.notify('/ralph todos requires TUI mode', 'error');
					return;
				}
				// Source: the active loop's backlog, else an explicit file, else the
				// conventional names in the project root.
				const candidates = state?.enabled
					? [state.todoPath]
					: fileArg
						? [resolveProjectFile(ctx.cwd, fileArg)].filter((p): p is string => p !== undefined)
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
							: 'No backlog found: start a loop or pass a file (e.g. /ralph todos TODO.ralph)',
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
				// An active loop already scopes the view to its category; otherwise
				// let the user choose a list (category) when the backlog has any.
				// Escape from a list goes back to this overview.
				const hasPicker = initial.categories().length > 0;
				// The views render as overlays on top of the chat, so the chat layout
				// and its scroll position are untouched while they are open (closing a
				// view no longer disturbs where the chat was scrolled). One overlay
				// hosts both stages (list picker, task view) and swaps between them
				// without closing: closing between stages would let the chat behind
				// flash for a frame. Both stages use the todos view's layout: the
				// list is pinned to the top, the key hints sit on the bottom line,
				// and the lines in between are blank so the chat behind is blacked
				// out; both size to 90% of terminal height so the status footer
				// stays visible.
				const OVERLAY_MAX_HEIGHT = '90%';
				const viewHeight = () => Math.max(10, Math.floor((process.stdout.rows ?? 40) * 0.9));
				let viewCategory = state?.enabled ? state.category : undefined;
				// The backlog instance the view currently renders; refreshed from
				// disk on every picker round (a view round may have renamed or
				// added lists).
				let source: Backlog = initial;
				await ctx.ui.custom((tui, theme, _keybindings, done) => {
					// The stage currently rendered. Swapping stages does not close
					// the overlay, so the chat behind never flashes through.
					let stage: ListPicker | TodosView | undefined;
					const showStage = (next: ListPicker | TodosView) => {
						stage?.dispose();
						stage = next;
						tui.requestRender();
					};
					const showView = () => {
						showStage(
							createTodosView({
								backlog: source,
								tui,
								title,
								category: viewCategory,
								theme,
								height: viewHeight,
								requestRender: () => tui.requestRender(),
								onClose: () => done('quit'),
								onBack: hasPicker ? () => showPicker() : undefined,
								reload: loadBacklog,
								mutate: async (backlog, fn) => {
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
								},
								onStartLoop: (loopCategory) => {
									void startLoop(ctx, { specFile: DEFAULT_SPEC, todoFile: title, category: loopCategory, goal: false });
								}
							})
						);
					};
					const showPicker = () => {
						const fresh = loadBacklog();
						if (fresh) source = fresh;
						const lists = source.categories().map((name) => {
							const counts = source.counts(name);
							return { name, open: counts.open, total: counts.total };
						});
						showStage(
							createListPicker({
								title,
								lists,
								theme,
								height: viewHeight,
								requestRender: () => tui.requestRender(),
								onOpen: (name) => {
									viewCategory = name;
									showView();
								},
								onClose: () => done(undefined),
								onRename: async (oldName, newName) => {
									try {
										const target = loadBacklog() ?? source;
										target.renameCategory(oldName, newName);
										await writeFile(todoPath, target.render());
										return true;
									} catch {
										return false;
									}
								}
							})
						);
					};
					if (viewCategory === undefined && hasPicker) showPicker();
					else showView();
					return {
						render: (width: number) => stage?.render(width) ?? [],
						handleInput: (data: string) => stage?.handleInput(data),
						invalidate: () => stage?.invalidate(),
						dispose: () => stage?.dispose()
					};
				}, { overlay: true, overlayOptions: { width: '100%', maxHeight: OVERLAY_MAX_HEIGHT } });
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

	pi.registerCommand('ralph-rotate', {
		description: 'Internal command: start a fresh Ralph iteration',
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (!state?.enabled) {
				ctx.ui.notify('Ralph rotation ignored because the loop is stopped', 'info');
				return;
			}
			if (state.stopRequested) {
				stopLoop(ctx, 'Ralph loop stopped before starting another iteration');
				return;
			}
			if (state.blocked) {
				ctx.ui.notify('Ralph rotation is paused pending the session decision', 'info');
				return;
			}
			const reason: RotationReason =
				args.trim() === 'context-limit' ? 'context-limit' : 'completed-task';
			const parentSession = ctx.sessionManager.getSessionFile();
			let currentTodo: string;
			try {
				currentTodo = await readRequiredFile(state.todoPath);
				taskCount = countTodoTasks(currentTodo, state?.category);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Ralph loop could not create a fresh session: ${message}`, 'error');
				persistState({
					...state,
					rotationQueued: false,
					rotationReason: undefined,
					rotationCheckpointing: false
				});
				updateStatus(ctx);
				return;
			}

			// Goal mode is done when the goal is done, not when the plan is
			// exhausted: an empty plan is the planning state.
			if (state.mode !== 'goal' && isBacklogFinished(currentTodo, state?.category)) {
				stopLoop(ctx, 'Ralph loop stopped because all TODO items are complete');
				return;
			}

			// The replacement session first runs the progress-recording turn
			// (rotationQueued + rotationCheckpointing); its agent_settled handler
			// then starts the fresh iteration, which applies the iteration
			// increment and the max-iterations stop.
			const replacementState: RalphState = {
				...state,
				baselineTodo: currentTodo,
				rotationQueued: true,
				rotationReason: reason,
				rotationCheckpointing: true,
				completedTasks:
					reason === 'completed-task'
						? completedTaskNumbers(state.baselineTodo, currentTodo, state.category)
						: undefined,
				blocked: false,
				blockedItem: undefined
			};
			if (state.iteration + 1 > state.maxIterations) {
				stopLoop(ctx, `Ralph loop stopped after reaching the maximum of ${state.maxIterations} iterations`);
				return;
			}
			const result = await ctx.newSession({
				parentSession,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(STATE_TYPE, replacementState);
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify(
						reason === 'completed-task'
							? 'Ralph task complete; recording progress before a fresh context.'
							: 'Ralph context budget reached; recording progress before a fresh context.',
						'info'
					);
					await replacementCtx.sendUserMessage(
						reason === 'completed-task'
							? completionRecordingPrompt(replacementState)
							: contextCheckpointPrompt(replacementState)
					);
				}
			});
			if (result.cancelled) {
				persistState({
					...state,
					rotationQueued: false,
					rotationReason: undefined,
					rotationCheckpointing: false
				});
				updateStatus(ctx);
			}
		}
	});
}
