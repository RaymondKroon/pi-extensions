// Focused tests for the loop status text shown in the pi-web chat strip and
// the panel's Loop card (pi-web/status-text.js). The expectations are the
// TUI's own (index.ts updateStatus) — except the TUI's task counter, which
// the web deliberately omits (the next-open-task position is not a reliable
// indicator of which task the agent is working on).

import { describe, expect, test } from "bun:test";

import { contextThresholdFor, contextUsageLabel, modelKeyOf, tuiStatusText } from "./status-text.js";

const CONFIG = {
	autoMode: "on",
	autoApproveDecisions: false,
	compactionMode: false,
	cycleOn: { auto: "budget", tasks: "task", goal: "budget" },
	contextThresholds: { __default__: 0.7 },
};

describe("modelKeyOf", () => {
	test("builds the provider/modelId key", () => {
		expect(modelKeyOf({ provider: "anthropic", id: "claude-opus-4-6" })).toBe("anthropic/claude-opus-4-6");
	});

	test("falls back to the default key without a model", () => {
		expect(modelKeyOf(undefined)).toBe("__default__");
		expect(modelKeyOf({ provider: "anthropic" })).toBe("__default__");
	});
});

describe("contextThresholdFor", () => {
	test("prefers the model's own threshold", () => {
		expect(contextThresholdFor({ contextThresholds: { "anthropic/claude": 0.8, __default__: 0.7 } }, "anthropic/claude")).toBe(0.8);
	});

	test("falls back to the default threshold", () => {
		expect(contextThresholdFor({ contextThresholds: { __default__: 0.7 } }, "other/model")).toBe(0.7);
	});

	test("falls back to 50% without a config", () => {
		expect(contextThresholdFor(null, "other/model")).toBe(0.5);
	});
});

describe("contextUsageLabel", () => {
	test("rounds percentages at 10% and above", () => {
		expect(contextUsageLabel(58.44, 0.7)).toBe("58% / 70%");
	});

	test("keeps one decimal below 10%", () => {
		expect(contextUsageLabel(6.4, 0.7)).toBe("6.4% / 70%");
	});

	test("renders the calculating form without a percentage", () => {
		expect(contextUsageLabel(undefined, 0.7)).toBe("calculating… / 70%");
		expect(contextUsageLabel(null, 0.5)).toBe("calculating… / 50%");
	});

	test("keeps a user-entered fractional threshold", () => {
		expect(contextUsageLabel(58.44, 0.65)).toBe("58% / 65%");
	});
});

describe("tuiStatusText", () => {
	test("running auto loop, TUI-exact (minus the task counter)", () => {
		expect(
			tuiStatusText({
				state: {
					enabled: true,
					mode: "auto",
					iteration: 10,
					maxIterations: 50,
					category: "General",
					cycleOn: "budget",
					contextThreshold: 0.7,
				},
				config: CONFIG,
				contextPercent: 58.44,
				modelKey: "anthropic/claude-opus-4-6",
			}),
		).toBe("Ralph (auto): on · cycle: budget · iteration 10/50 · category: General · context: 58% / 70%");
	});

	test("running task loop without a category", () => {
		expect(
			tuiStatusText({
				state: {
					enabled: true,
					mode: "tasks",
					iteration: 3,
					maxIterations: 20,
					cycleOn: "task",
					contextThreshold: 0.5,
				},
				config: CONFIG,
				contextPercent: 12,
			}),
		).toBe("Ralph: on · cycle: task · iteration 3/20 · context: 12% / 50%");
	});

	test("paused wins over running", () => {
		expect(
			tuiStatusText({
				state: { enabled: true, mode: "auto", paused: true, iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.7 },
				config: CONFIG,
				contextPercent: 10,
			}),
		).toBe("Ralph (auto): paused · cycle: budget · iteration 1/50 · context: 10% / 70%");
	});

	test("blocked renders as 'waiting'", () => {
		expect(
			tuiStatusText({
				state: { enabled: true, mode: "auto", blocked: true, paused: true, iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.7 },
				config: CONFIG,
				contextPercent: 10,
			}),
		).toBe("Ralph (auto): waiting · cycle: budget · iteration 1/50 · context: 10% / 70%");
	});

	test("stopRequested renders as 'stopping'", () => {
		expect(
			tuiStatusText({
				state: { enabled: true, mode: "auto", stopRequested: true, iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.7 },
				config: CONFIG,
				contextPercent: 10,
			}),
		).toBe("Ralph (auto): stopping · cycle: budget · iteration 1/50 · context: 10% / 70%");
	});

	test("cycleQueued renders as 'starting'", () => {
		expect(
			tuiStatusText({
				state: { enabled: true, mode: "auto", cycleQueued: true, iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.7 },
				config: CONFIG,
				contextPercent: 10,
			}),
		).toBe("Ralph (auto): starting · cycle: budget · iteration 1/50 · context: 10% / 70%");
	});

	test("checkpointing states: recording, checkpointing, finishing", () => {
		const base = { enabled: true, iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.7 };
		expect(
			tuiStatusText({ state: { ...base, mode: "auto", cycleCheckpointing: true, cycleReason: "completed-task" }, config: CONFIG, contextPercent: 10 }),
		).toBe("Ralph (auto): recording · cycle: budget · iteration 1/50 · context: 10% / 70%");
		expect(
			tuiStatusText({
				state: { ...base, mode: "goal", cycleCheckpointing: true, cycleReason: "iteration", baselinePhase: "planning" },
				config: CONFIG,
				contextPercent: 10,
			}),
		).toBe("Ralph (goal): checkpointing · cycle: budget · iteration 1/50 · context: 10% / 70%");
		expect(
			tuiStatusText({
				state: { ...base, mode: "goal", cycleCheckpointing: true, cycleReason: "iteration", baselinePhase: "execution" },
				config: CONFIG,
				contextPercent: 10,
			}),
		).toBe("Ralph (goal): finishing · cycle: budget · iteration 1/50 · context: 10% / 70%");
	});

	test("idle with auto mode on shows 'auto' and the armed cycle policy", () => {
		expect(tuiStatusText({ state: null, config: CONFIG, contextPercent: 6.4, modelKey: "anthropic/claude-opus-4-6" })).toBe(
			"Ralph: auto · cycle: budget · context: 6.4% / 70%",
		);
	});

	test("idle without auto mode shows 'off' and no context", () => {
		expect(tuiStatusText({ state: null, config: { ...CONFIG, autoMode: "off" }, contextPercent: 6.4 })).toBe("Ralph: off");
	});

	test("idle without any config shows 'off'", () => {
		expect(tuiStatusText({ state: null, config: null, contextPercent: 6.4 })).toBe("Ralph: off");
	});

	test("stopped goal loop keeps its marker while auto mode is off", () => {
		expect(
			tuiStatusText({ state: { enabled: false, mode: "goal" }, config: { ...CONFIG, autoMode: "off" }, contextPercent: 6.4 }),
		).toBe("Ralph (goal): off");
	});

	test("modifiers: auto-approve and compaction", () => {
		expect(
			tuiStatusText({
				state: {
					enabled: true,
					mode: "auto",
					autoApproveDecisions: true,
					iteration: 1,
					maxIterations: 50,
					cycleOn: "budget",
					contextThreshold: 0.7,
				},
				config: { ...CONFIG, compactionMode: true },
				contextPercent: 10,
			}),
		).toBe("Ralph (auto): on (auto-approve, compaction) · cycle: budget · iteration 1/50 · context: 10% / 70%");
	});

	test("idle modifiers come from the config", () => {
		expect(tuiStatusText({ state: null, config: { ...CONFIG, autoApproveDecisions: true }, contextPercent: 10 })).toBe(
			"Ralph: auto (auto-approve) · cycle: budget · context: 10% / 70%",
		);
	});

	test("goal loop shows the goal state segment", () => {
		expect(
			tuiStatusText({
				state: {
					enabled: true,
					mode: "goal",
					iteration: 2,
					maxIterations: 30,
					cycleOn: "budget",
					contextThreshold: 0.7,
				},
				config: CONFIG,
				goalState: "open",
				contextPercent: 42,
			}),
		).toBe("Ralph (goal): on · cycle: budget · iteration 2/30 · goal: open · context: 42% / 70%");
	});

	test("context percentage unknown renders the calculating form", () => {
		expect(
			tuiStatusText({
				state: { enabled: true, mode: "auto", iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.7 },
				config: CONFIG,
				contextPercent: undefined,
			}),
		).toBe("Ralph (auto): on · cycle: budget · iteration 1/50 · context: calculating… / 70%");
	});

	test("idle context uses the per-model threshold", () => {
		expect(
			tuiStatusText({
				state: null,
				config: { ...CONFIG, contextThresholds: { "anthropic/claude-opus-4-6": 0.8, __default__: 0.7 } },
				contextPercent: 10,
				modelKey: "anthropic/claude-opus-4-6",
			}),
		).toBe("Ralph: auto · cycle: budget · context: 10% / 80%");
	});

	test("running loop uses the state's own threshold, not the config's", () => {
		expect(
			tuiStatusText({
				state: { enabled: true, mode: "auto", iteration: 1, maxIterations: 50, cycleOn: "budget", contextThreshold: 0.6 },
				config: CONFIG,
				contextPercent: 10,
				modelKey: "anthropic/claude-opus-4-6",
			}),
		).toBe("Ralph (auto): on · cycle: budget · iteration 1/50 · context: 10% / 60%");
	});
});
