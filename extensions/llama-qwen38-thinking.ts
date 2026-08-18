/**
 * llama-qwen38-thinking.ts
 *
 * Automatically enables thinking support for llama.cpp Qwen 3.8 models
 * (ids like "unsloth/qwen3.8-27b@q4_k_m", "unsloth/Qwen3.8-27B-GGUF:Q8_0").
 *
 * When such a model becomes the session's model (session start or model
 * selection), the model is re-set with the parameters needed for thinking:
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
 * llama.cpp's top-level OpenAI-compatible `enable_thinking` field is not
 * reliable for Qwen3.8: it can leave thinking enabled. The template kwargs
 * are the path that the Qwen3.8 GGUF template actually consumes.
 *
 * The model id is unchanged; this is equivalent to the per-model
 * modelOverrides entry in models.json, applied on the fly. The re-set
 * is idempotent: an already reasoning-capable model is still normalized if
 * it has stale or incomplete thinking settings. This is important after an
 * extension reload, where the session may retain a previous enhanced copy.
 *
 * Active only on session_start (covers fresh startup and /reload) and
 * model_select (covers /model and Ctrl+P). No per-prompt logic, no file
 * writes, no router queries.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

const PROVIDER_ID = "llama.cpp";

// Matches "qwen3.8", "qwen-3.8", "qwen_3.8" (case-insensitive) in router ids.
const QWEN38 = /qwen[._ -]?3\.8/i;

// The parameters applied to matching models. Adjust here to change globally.
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

function enhance(model: Model<any>): Model<any> {
  return {
    ...model,
    ...THINKING,
    thinkingLevelMap: { ...model.thinkingLevelMap, ...THINKING.thinkingLevelMap },
    compat: { ...model.compat, ...THINKING.compat },
  };
}

/** Do not use `model.reasoning` as the loop guard: it says nothing about the
 * level map or the chat-template kwargs, and can leave an old enhanced copy
 * permanently configured with the wrong effort mapping after /reload. */
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

export default function (pi: ExtensionAPI) {
  const apply = async (ctx: ExtensionContext, model: Model<any> | undefined): Promise<void> => {
    if (!model || model.provider !== PROVIDER_ID || !QWEN38.test(model.id) || isEnhanced(model)) {
      return;
    }
    try {
      await pi.setModel(enhance(model));
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`llama-qwen38-thinking: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  };

  // Covers pi startup (default/restored model) and /reload.
  pi.on("session_start", (_event, ctx) => {
    void apply(ctx, ctx.model);
  });

  // Covers /model selection and Ctrl+P cycling.
  pi.on("model_select", (event, ctx) => {
    void apply(ctx, event.model);
  });
}
