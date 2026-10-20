import { describe, expect, test } from "bun:test";
import { MAX_TOOL_ARGS, MAX_TOOL_RESULT, ToolCallTracker } from "./tool-update";

const assistantMsg = (toolCalls: { id: string; name: string; arguments: unknown }[]) => ({
  role: "assistant",
  content: [
    { type: "text", text: "thinking out loud" },
    ...toolCalls.map((t) => ({ type: "toolCall", id: t.id, name: t.name, arguments: t.arguments })),
  ],
});

const resultMsg = (toolCallId: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId,
  toolName: "bash",
  isError: false,
  ...extra,
  content,
});

describe("ToolCallTracker", () => {
  test("pairs recorded arguments with the result", () => {
    const t = new ToolCallTracker();
    t.trackAssistant(assistantMsg([{ id: "c1", name: "bash", arguments: { command: "ls" } }]));
    const u = t.toolResult(resultMsg("c1", [{ type: "text", text: "a\nb" }]));
    expect(u).toEqual({
      kind: "tool",
      name: "bash",
      ok: true,
      args: '{"command":"ls"}',
      result: "a\nb",
    });
    // consumed: a duplicate result for the same id has no args
    const again = t.toolResult(resultMsg("c1", [{ type: "text", text: "x" }]));
    expect(again.args).toBe("");
  });

  test("result without a recorded call has empty args", () => {
    const t = new ToolCallTracker();
    expect(t.toolResult(resultMsg("unknown", [])).args).toBe("");
  });

  test("joins text parts and notes images", () => {
    const t = new ToolCallTracker();
    const u = t.toolResult(resultMsg("c1", [
      { type: "text", text: "part1" },
      { type: "image", data: "xx", mimeType: "image/png" },
      { type: "text", text: "part2" },
    ]));
    expect(u.result).toBe("part1\npart2\n(image)");
  });

  test("isError maps to ok:false", () => {
    const t = new ToolCallTracker();
    const u = t.toolResult(resultMsg("c1", [{ type: "text", text: "boom" }], { isError: true }));
    expect(u.ok).toBe(false);
  });

  test("truncates long arguments with an ellipsis", () => {
    const t = new ToolCallTracker();
    const big = { command: "x".repeat(5000) };
    t.trackAssistant(assistantMsg([{ id: "c1", name: "bash", arguments: big }]));
    const u = t.toolResult(resultMsg("c1", []));
    expect(u.args).toHaveLength(MAX_TOOL_ARGS + 1);
    expect(u.args.endsWith("\u2026")).toBe(true);
  });

  test("truncates long results", () => {
    const t = new ToolCallTracker();
    const u = t.toolResult(resultMsg("c1", [{ type: "text", text: "y".repeat(10000) }]));
    expect(u.result).toHaveLength(MAX_TOOL_RESULT);
  });

  test("evicts the oldest pending call past the cap", () => {
    const t = new ToolCallTracker();
    const calls = [];
    for (let i = 0; i < 60; i++) calls.push({ id: `c${i}`, name: "bash", arguments: { i } });
    t.trackAssistant(assistantMsg(calls));
    // c0..c9 evicted (cap 50), c59 kept
    expect(t.toolResult(resultMsg("c0", [])).args).toBe("");
    expect(t.toolResult(resultMsg("c59", [])).args).toBe('{"i":59}');
  });

  test("ignores non-toolCall blocks and messages without content", () => {
    const t = new ToolCallTracker();
    t.trackAssistant({ role: "assistant", content: "just a string" });
    t.trackAssistant({ role: "assistant" });
    t.trackAssistant({ role: "assistant", content: [{ type: "text", text: "hi" }] });
    expect(t.toolResult(resultMsg("nope", [])).args).toBe("");
  });
});
