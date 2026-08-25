/**
 * qwen-reasoning.ts
 *
 * Manually enables Qwen-style reasoning (thinking) for models that do NOT
 * natively support reasoning.
 *
 * Commands:
 *   /enable-qwen-reasoning   Enable qwen reasoning for the current model
 *   /disable-qwen-reasoning  Disable it and restore the model to its catalog form
 *
 * When enabled, the current model is re-set with the same parameters used by
 * llama-qwen38-thinking.ts:
 *
 *   reasoning: true
 *   thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: "medium",
 *                       high: null, xhigh: "xhigh", max: null }
 *   compat: {
 *     thinkingFormat: "chat-template",
 *     chatTemplateKwargs: {
 *       enable_thinking: { $var: "thinking.enabled" },
 *       preserve_thinking: true,
 *       reasoning_effort: { $var: "thinking.effort", omitWhenOff: true }
 *     }
 *   }
 *
 * Constraints:
 *   - Only models without native reasoning support (model.reasoning falsy) can
 *     be enabled. Models that already reason are rejected.
 *
 * Persistence:
 *   - The enabled set is stored per provider/model combination in
 *     ${PI_CODING_AGENT_DIR}/qwen-reasoning.json (default ~/.pi/agent/).
 *   - On session_start and model_select, any enabled model that is not yet
 *     enhanced is re-enhanced (idempotent), so the setting survives restarts
 *     and model switches.
 *
 * Status:
 *   - A footer status line (key "qwen-reasoning") is shown while the current
 *     model has qwen reasoning enabled. It is a normal keyed status, so any
 *     other extension using the same key overrides it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATUS_KEY = "qwen-reasoning";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_DIR, "qwen-reasoning.json");

// The parameters applied to enabled models. Adjust here to change globally.
const THINKING = {
  reasoning: true,
  thinkingLevelMap: {
    off: "off",
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: "xhigh",
    max: null,
  },
  compat: {
    thinkingFormat: "chat-template",
    chatTemplateKwargs: {
      enable_thinking: { $var: "thinking.enabled" },
      preserve_thinking: true,
      reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
    },
  },
} as const;

interface EnabledEntry {
  provider: string;
  id: string;
}

interface State {
  enabled: EnabledEntry[];
}

function enhance(model: Model<any>): Model<any> {
  return {
    ...model,
    ...THINKING,
    thinkingLevelMap: { ...model.thinkingLevelMap, ...THINKING.thinkingLevelMap },
    compat: { ...model.compat, ...THINKING.compat },
  };
}

/** Detects a model that has been enhanced by this extension. Do not rely on
 * `model.reasoning` alone: it says nothing about the level map or the
 * chat-template kwargs. */
function isEnhanced(model: Model<any>): boolean {
  if (!model.reasoning || model.compat?.thinkingFormat !== THINKING.compat.thinkingFormat) return false;

  for (const [level, value] of Object.entries(THINKING.thinkingLevelMap)) {
    if (model.thinkingLevelMap?.[level as keyof typeof THINKING.thinkingLevelMap] !== value) return false;
  }

  const kwargs = model.compat?.chatTemplateKwargs;
  return (
    kwargs?.enable_thinking?.$var === "thinking.enabled" &&
    kwargs?.preserve_thinking === true &&
    kwargs?.reasoning_effort?.$var === "thinking.effort" &&
    kwargs.reasoning_effort.omitWhenOff === true
  );
}

/** Fallback restore when the catalog no longer has the model: strip the fields
 * this extension added. Non-reasoning models do not define their own
 * thinkingLevelMap, so removing it is safe. */
function stripEnhancement(model: Model<any>): Model<any> {
  const result: Model<any> = { ...model };
  result.reasoning = false;
  delete result.thinkingLevelMap;
  if (result.compat) {
    const compat = { ...result.compat };
    delete compat.thinkingFormat;
    delete compat.chatTemplateKwargs;
    result.compat = Object.keys(compat).length > 0 ? compat : undefined;
  }
  return result;
}

function loadState(): State {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (parsed && Array.isArray(parsed.enabled)) return parsed;
  } catch {
    // Missing or corrupt state file: start fresh.
  }
  return { enabled: [] };
}

function saveState(state: State): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  } catch (error) {
    console.error(`qwen-reasoning: failed to save state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isEnabled(state: State, provider: string, id: string): boolean {
  return state.enabled.some((e) => e.provider === provider && e.id === id);
}

/** Reflects the current model's enhancement state in the footer. The status is
 * keyed, so other extensions using the same key override it. */
function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const model = ctx.model;
  if (model && isEnhanced(model)) {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "◆ qwen-reasoning on"));
  } else {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
  if (ctx.hasUI) {
    ctx.ui.notify(`qwen-reasoning: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  // Re-apply the enhancement to an enabled model that is not yet enhanced.
  // Idempotent: an already-enhanced model is left untouched, which also guards
  // against a model_select loop if setModel re-emits the event.
  const applyIfEnabled = async (ctx: ExtensionContext, model: Model<any> | undefined): Promise<void> => {
    if (!model || !isEnabled(loadState(), model.provider, model.id) || isEnhanced(model)) {
      updateStatus(ctx);
      return;
    }
    try {
      const ok = await pi.setModel(enhance(model));
      if (!ok && ctx.hasUI) {
        ctx.ui.notify(`qwen-reasoning: no API key for ${model.provider}/${model.id}`, "error");
      }
    } catch (error) {
      notifyError(ctx, error);
    }
    updateStatus(ctx);
  };

  // Covers pi startup (default/restored model) and /reload.
  pi.on("session_start", (_event, ctx) => {
    void applyIfEnabled(ctx, ctx.model);
  });

  // Covers /model selection and Ctrl+P cycling.
  pi.on("model_select", (event, ctx) => {
    void applyIfEnabled(ctx, event.model);
  });

  pi.registerCommand("enable-qwen-reasoning", {
    description: "Enable Qwen-style reasoning for the current model (non-reasoning models only)",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI) ctx.ui.notify("qwen-reasoning: no model selected", "error");
        updateStatus(ctx);
        return;
      }
      if (isEnhanced(model)) {
        if (ctx.hasUI) ctx.ui.notify("qwen-reasoning: already enabled for this model", "info");
        updateStatus(ctx);
        return;
      }
      if (model.reasoning) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `qwen-reasoning: ${model.provider}/${model.id} natively supports reasoning; only non-reasoning models can be enabled`,
            "warning",
          );
        }
        updateStatus(ctx);
        return;
      }
      try {
        const ok = await pi.setModel(enhance(model));
        if (!ok) {
          if (ctx.hasUI) ctx.ui.notify(`qwen-reasoning: no API key for ${model.provider}/${model.id}`, "error");
          updateStatus(ctx);
          return;
        }
      } catch (error) {
        notifyError(ctx, error);
        updateStatus(ctx);
        return;
      }
      const state = loadState();
      if (!isEnabled(state, model.provider, model.id)) {
        state.enabled.push({ provider: model.provider, id: model.id });
        saveState(state);
      }
      if (ctx.hasUI) ctx.ui.notify(`qwen-reasoning: enabled for ${model.provider}/${model.id}`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("disable-qwen-reasoning", {
    description: "Disable Qwen-style reasoning for the current model and restore it",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI) ctx.ui.notify("qwen-reasoning: no model selected", "error");
        updateStatus(ctx);
        return;
      }
      if (!isEnhanced(model)) {
        if (ctx.hasUI) ctx.ui.notify("qwen-reasoning: not enabled for this model", "info");
        updateStatus(ctx);
        return;
      }
      // Restore the catalog (non-enhanced) model; fall back to stripping the
      // enhancement if the catalog no longer has this model.
      const original = ctx.modelRegistry.find(model.provider, model.id) ?? stripEnhancement(model);
      try {
        const ok = await pi.setModel(original);
        if (!ok && ctx.hasUI) {
          ctx.ui.notify(`qwen-reasoning: no API key for ${model.provider}/${model.id}`, "error");
        }
      } catch (error) {
        notifyError(ctx, error);
        updateStatus(ctx);
        return;
      }
      const state = loadState();
      state.enabled = state.enabled.filter((e) => !(e.provider === model.provider && e.id === model.id));
      saveState(state);
      if (ctx.hasUI) ctx.ui.notify(`qwen-reasoning: disabled for ${model.provider}/${model.id}`, "info");
      updateStatus(ctx);
    },
  });
}
