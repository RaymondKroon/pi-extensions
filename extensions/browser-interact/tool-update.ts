// browser-interact — pairing of assistant toolCall blocks with toolResult
// messages, for the chat dock's expandable tool rows.
//
// The dock only ever sees one message at a time (message_end), so the call's
// arguments are recorded when the assistant message arrives and paired with
// the result when it arrives. Everything is truncated: the dock is a glance
// surface, not a transcript — full output stays in the session.

export interface ToolUpdate {
  kind: "tool";
  name: string;
  ok: boolean;
  args: string;
  result: string;
}

export const MAX_TOOL_ARGS = 2000;
export const MAX_TOOL_RESULT = 4000;
const MAX_PENDING = 50;

export class ToolCallTracker {
  private pending = new Map<string, string>();

  /** Record the (truncated) serialized arguments of every toolCall block in an assistant message. */
  trackAssistant(m: unknown): void {
    const content = (m as { content?: unknown })?.content;
    if (!Array.isArray(content)) return;
    for (const c of content as any[]) {
      if (c?.type === "toolCall" && c.id) {
        let args = "";
        try {
          args = JSON.stringify(c.arguments ?? {});
        } catch {
          args = String(c.arguments);
        }
        if (args.length > MAX_TOOL_ARGS) args = args.slice(0, MAX_TOOL_ARGS) + "\u2026";
        this.pending.set(c.id, args);
        // Safety cap: a result that never arrives (aborted run) must not leak.
        while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      }
    }
  }

  /** Pair a toolResult with its recorded arguments and return the dock update. */
  toolResult(m: { toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown }): ToolUpdate {
    const args = this.pending.get(m.toolCallId ?? "") ?? "";
    this.pending.delete(m.toolCallId ?? "");
    let result = "";
    if (Array.isArray(m.content)) {
      result = (m.content as any[])
        .filter((c) => c?.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if ((m.content as any[]).some((c) => c?.type === "image")) result += "\n(image)";
    }
    return {
      kind: "tool",
      name: String(m.toolName ?? "tool"),
      ok: !m.isError,
      args,
      result: result.slice(0, MAX_TOOL_RESULT),
    };
  }
}
