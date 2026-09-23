// Pure helpers for the compact Ralph loop status shown in the pi-web chat
// (injected below the prompt editor).
//
// The text mirrors the TUI's status line EXACTLY (index.ts updateStatus):
// the same label, state word, modifiers, cycle policy, iteration/category/
// task counters, goal state, and context percentage. The TUI does not show
// the current task's title — neither does this.
//
// The strip polls the backend proxy itself (the `summary` op) plus the
// pi-web session status (context usage percent, the same data the TUI reads
// via ctx.getContextUsage()).

export const DEFAULT_MODEL_CONFIG_KEY = "__default__";
export const DEFAULT_CONTEXT_THRESHOLD = 0.5;

/** The session's active model key ("provider/modelId"), like the TUI's modelConfigKey. */
export function modelKeyOf(model) {
	return model && typeof model.provider === "string" && typeof model.id === "string"
		? `${model.provider}/${model.id}`
		: DEFAULT_MODEL_CONFIG_KEY;
}

/** The per-model context threshold, like the TUI's contextThresholdFor. */
export function contextThresholdFor(config, modelKey) {
	return (
		config?.contextThresholds?.[modelKey] ??
		config?.contextThresholds?.[DEFAULT_MODEL_CONFIG_KEY] ??
		DEFAULT_CONTEXT_THRESHOLD
	);
}

/** The threshold as the TUI renders it (no float noise, fractional % kept). */
export function contextThresholdLabel(threshold) {
	return `${Number((threshold * 100).toFixed(10))}%`;
}

/**
 * The "context:" segment, like the TUI's contextUsageLabel. `percent` is pi's
 * context-usage percentage points (e.g. 6.4 for 6.4%); null/undefined renders
 * the TUI's "calculating…" form.
 */
export function contextUsageLabel(percent, threshold) {
	if (percent === null || percent === undefined) return `calculating… / ${contextThresholdLabel(threshold)}`;
	const percentage = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
	return `${percentage} / ${contextThresholdLabel(threshold)}`;
}

/**
 * The loop status line shown in the pi-web chat strip and the panel's Loop
 * card. It mirrors the TUI's status line (index.ts updateStatus) with one
 * deliberate difference: the TUI's task counter ("task: X/Y (iteration K)")
 * is omitted — the position of the next open task is not a reliable indicator
 * of which task the agent is working on, so the web does not show it.
 *
 * @param {object} data
 * @param {undefined | {enabled?: boolean, mode?: string, paused?: boolean, blocked?: boolean,
 *   cycleCheckpointing?: boolean, cycleReason?: string, stopRequested?: boolean, cycleQueued?: boolean,
 *   iteration?: number, maxIterations?: number, category?: string,
 *   autoApproveDecisions?: boolean, contextThreshold?: number, cycleOn?: string, baselinePhase?: string}} data.state
 *   The persisted loop state (null when the session has no loop state). The
 *   server adds the derived baselinePhase (the goal phase at the iteration
 *   baseline) so this stays a pure function of the summary payload.
 * @param {undefined | {autoMode?: string, autoApproveDecisions?: boolean, compactionMode?: boolean,
 *   cycleOn?: {auto?: string, tasks?: string, goal?: string}, contextThresholds?: Record<string, number>}} data.config
 *   The resolved ralph config (null when none).
 * @param {string} [data.goalState] The backlog goal's status (open/claimed/done).
 * @param {number | null} [data.contextPercent] pi's context-usage percentage points.
 * @param {string} [data.modelKey] The active model key ("provider/modelId").
 * @returns {string} The status line (e.g. "Ralph (auto): on · cycle: budget · …").
 */
export function tuiStatusText(data) {
	const state = data.state;
	const config = data.config;
	const autoApproveDecisions = state?.enabled ? state.autoApproveDecisions : config?.autoApproveDecisions;
	const mode = state?.blocked
		? "waiting"
		: state?.paused
			? "paused"
			: state?.cycleCheckpointing
				? state.cycleReason === "completed-task" || state.cycleReason === "plan-updated"
					? "recording"
					: state.mode === "goal" && state.baselinePhase !== "execution"
						? "checkpointing"
						: "finishing"
				: state?.stopRequested
					? "stopping"
					: state?.cycleQueued
						? "starting"
						: "on";
	const label = state?.enabled
		? state.mode === "goal"
			? "Ralph (goal)"
			: state.mode === "auto"
				? "Ralph (auto)"
				: "Ralph"
		: config?.autoMode !== "on" && state?.mode === "goal"
			? "Ralph (goal)"
			: "Ralph";
	// Idle state word: the auto mode setting itself: "auto" is armed (the
	// loop arms itself at the context budget), not off.
	const idleState = label === "Ralph" ? (config?.autoMode === "on" ? "auto" : "off") : "off";
	// Non-default modifiers, compact: (auto-approve) and/or (compaction).
	const modifiers = [autoApproveDecisions ? "auto-approve" : undefined, config?.compactionMode ? "compaction" : undefined]
		.filter((part) => part !== undefined)
		.join(", ");
	const modifierSuffix = modifiers ? ` (${modifiers})` : "";
	// The cycle policy: the active loop's resolved value, or the armed auto
	// loop's configured value when idle.
	const cycle = state?.enabled ? state.cycleOn : config?.autoMode === "on" ? config.cycleOn?.auto : undefined;
	const cycleSuffix = cycle ? ` · cycle: ${cycle}` : "";
	// In the idle on/auto states the context percentage is still shown.
	const idleContext =
		idleState !== "off" ? ` · context: ${contextUsageLabel(data.contextPercent, contextThresholdFor(config, data.modelKey))}` : "";
	return !state?.enabled
		? `${label}: ${idleState}${modifierSuffix}${cycleSuffix}${idleContext}`
		: `${label}: ${mode}${modifierSuffix}${cycleSuffix} · iteration ${state.iteration}/${state.maxIterations}${state.category ? ` · category: ${state.category}` : ""}${state.mode === "goal" && data.goalState ? ` · goal: ${data.goalState}` : ""} · context: ${contextUsageLabel(data.contextPercent, state.contextThreshold)}`;
}
