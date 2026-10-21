import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { OVERLAY_SCRIPT, OVERLAY_V } from "./overlay";

/** Boot the overlay in a fresh happy-dom window and return the API it exposes. */
function bootOverlay() {
  const win = new Window({ url: "http://localhost/" }) as any;
  const overlay = win.eval(OVERLAY_SCRIPT);
  return { win, overlay };
}

const trustedClick = (win: any, el: any) => {
  const ev = new win.MouseEvent("click", { bubbles: true });
  Object.defineProperty(ev, "isTrusted", { value: true });
  el.dispatchEvent(ev);
};

describe("OVERLAY_SCRIPT", () => {
  test("parses as a standalone script", () => {
    expect(() => new Function(OVERLAY_SCRIPT)).not.toThrow();
  });

  test("boots at the current version", () => {
    const { overlay } = bootOverlay();
    expect(overlay.__v).toBe(OVERLAY_V);
  });

  describe("expandable tool rows", () => {
    test("renders arguments and result, expandable via trusted click", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([
        { kind: "tool", name: "bash", ok: true, args: '{"command":"ls"}', result: "file1\nfile2" },
      ]);
      const row = win.document.querySelector(".pi-chat-tool");
      expect(row?.textContent).toContain("⚙ bash ✓");
      expect(row?.classList.contains("has-detail")).toBe(true);
      const detail = row.querySelector(".pi-chat-tool-detail");
      expect(detail.textContent).toContain('{"command":"ls"}');
      expect(detail.textContent).toContain("file1\nfile2");
      expect(row.classList.contains("open")).toBe(false);
      trustedClick(win, row);
      expect(row.classList.contains("open")).toBe(true);
      trustedClick(win, row);
      expect(row.classList.contains("open")).toBe(false);
    });

    test("untrusted (page-script) clicks do not toggle", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "tool", name: "read", ok: true, args: "{}", result: "x" }]);
      const row = win.document.querySelector(".pi-chat-tool");
      row.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      expect(row.classList.contains("open")).toBe(false);
    });

    test("failed call labels its output 'error'", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "tool", name: "bash", ok: false, args: "{}", result: "boom" }]);
      const row = win.document.querySelector(".pi-chat-tool");
      expect(row?.textContent).toContain("✗ failed");
      const err = row.querySelector(".pi-chat-tool-sec.err");
      expect(err?.textContent).toBe("error");
    });

    test("legacy rows (no args/result) stay plain and non-interactive", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "tool", name: "read", ok: true }]);
      const row = win.document.querySelector(".pi-chat-tool");
      expect(row?.classList.contains("has-detail")).toBe(false);
      expect(row.querySelector(".pi-chat-tool-detail")).toBeNull();
    });

    test("details persist with the stored transcript", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "tool", name: "bash", ok: true, args: '{"a":1}', result: "out" }]);
      const stored = JSON.parse(win.sessionStorage.getItem("__pi_chat_msgs"));
      expect(stored[0]).toMatchObject({ kind: "tool", name: "bash", ok: true, args: '{"a":1}', result: "out" });
    });
  });

  describe("dock header detach control", () => {
    test("trusted ⏏ click queues a dock-detach signal", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      const detachBtn = win.document.querySelector("#__pi_chat_detach");
      expect(detachBtn).not.toBeNull();
      // the retired ⇄ switch button must be gone
      expect(win.document.querySelector("#__pi_chat_switch")).toBeNull();
      trustedClick(win, detachBtn);
      expect(overlay.tick([])).toEqual([{ type: "dock-detach" }]);
      // queue is empty now
      expect(overlay.tick([])).toEqual([]);
    });

    test("untrusted (page-script) clicks do not queue detach", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      win.document.querySelector("#__pi_chat_detach").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      expect(overlay.tick([])).toEqual([]);
    });
  });

  describe("dock chat origin", () => {
    test("a sent chat signal carries the live page URL (context for the agent)", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      const input = win.document.querySelector("#__pi_chat_input");
      input.value = "summarize the news";
      const ev = new win.Event("input", { bubbles: true });
      Object.defineProperty(ev, "isTrusted", { value: true });
      input.dispatchEvent(ev);
      trustedClick(win, win.document.querySelector("#__pi_chat_send"));
      const sigs = overlay.tick([]);
      expect(sigs).toEqual([{ type: "chat", text: "summarize the news", url: "http://localhost/" }]);
    });
  });

  describe("off is off (destroy)", () => {
    test("destroy() removes all overlay DOM, listeners, and stored state", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "msg", role: "agent", text: "hi" }]);
      expect(win.document.querySelector("#__pi_chat_panel")).not.toBeNull();
      expect(win.document.querySelector("#__pi_chat_btn")).not.toBeNull();
      expect(win.sessionStorage.getItem("__pi_chat_msgs")).not.toBeNull();
      overlay.destroy();
      // every overlay node is gone (panel, button, style tag)
      expect(win.document.querySelector("[data-pi-chat]")).toBeNull();
      expect(win.document.querySelector("[data-pi-lens]")).toBeNull();
      // stored state is cleared, so a future re-attach starts fresh
      expect(win.sessionStorage.getItem("__pi_chat_msgs")).toBeNull();
      expect(win.sessionStorage.getItem("__pi_chat_open")).toBeNull();
      expect(win.sessionStorage.getItem("__pi_chat_pos")).toBeNull();
      expect(win.sessionStorage.getItem("__pi_lens_notes")).toBeNull();
      expect(win.sessionStorage.getItem("__pi_lens_enabled")).toBeNull();
      // globals are gone, so the next overlay script install re-boots fresh
      expect(win.__piOverlay).toBeUndefined();
      expect(win.__piOverlayListeners).toBeNull();
    });
  });

  describe("agent message rendering", () => {
    test("renders markdown: headings, bold, code, fence, lists, links — and escapes raw HTML", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([
        {
          kind: "msg",
          role: "agent",
          text: ["## Title here", "", "Some **bold** and `code` and [docs](https://example.com/a).", "", "- one", "- two", "", "Visit https://example.com/b now.", "<script>alert(1)</script>", "", "```js", "const x = 1; // a < tag", "```"].join("\n"),
        },
      ]);
      const msg = win.document.querySelector(".pi-chat-msg.agent");
      const body = msg.querySelector(".pi-chat-md");
      expect(body.querySelector("h5")?.textContent).toBe("Title here");
      expect(body.querySelector("strong")?.textContent).toBe("bold");
      expect(body.querySelector("code")?.textContent).toBe("code");
      const link = [...body.querySelectorAll("a")].find((a) => a.textContent === "docs");
      expect(link?.getAttribute("href")).toBe("https://example.com/a");
      const auto = [...body.querySelectorAll("a")].find((a) => a.textContent === "https://example.com/b");
      expect(auto?.getAttribute("href")).toBe("https://example.com/b");
      expect(body.querySelectorAll("li").length).toBe(2);
      const pre = body.querySelector("pre.pi-md-code");
      expect(pre?.textContent).toBe("const x = 1; // a < tag");
      // raw HTML in the message must stay inert text
      expect(msg.querySelector("script")).toBeNull();
      expect(msg.textContent).toContain("<script>alert(1)</script>");
    });

    test("renders a collapsed thinking block and persists it", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "msg", role: "agent", text: "answer", thinking: "let me think" }]);
      const msg = win.document.querySelector(".pi-chat-msg.agent");
      const det = msg.querySelector("details.pi-chat-thinking");
      expect(det).not.toBeNull();
      expect(det.open).toBe(false);
      det.open = true;
      expect(det.open).toBe(true);
      expect(det.querySelector("pre")?.textContent).toBe("let me think");
      const stored = JSON.parse(win.sessionStorage.getItem("__pi_chat_msgs"));
      expect(stored[0].thinking).toBe("let me think");
    });

    test("renders markdown tables (th/td, inline md + escaping in cells)", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([
        {
          kind: "msg",
          role: "agent",
          text: ["| Tool | Purpose |", "|------|---------|", "| `tab` | Click **things** |", "| <img src=x onerror=alert(1)> | y |"].join("\n"),
        },
      ]);
      const body = win.document.querySelector(".pi-chat-md");
      const table = body.querySelector("table.pi-md-table");
      expect(table).not.toBeNull();
      expect([...table.querySelectorAll("thead th")].map((t) => t.textContent)).toEqual(["Tool", "Purpose"]);
      const rows = table.querySelectorAll("tbody tr");
      expect(rows.length).toBe(2);
      expect(rows[0].querySelector("td code")?.textContent).toBe("tab");
      expect(rows[0].querySelectorAll("td")[1].querySelector("strong")?.textContent).toBe("things");
      // raw HTML in a cell stays inert text
      expect(table.querySelector("img")).toBeNull();
      expect(table.textContent).toContain("<img");
    });

    test("pipe lines without a separator row are not tables", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "msg", role: "agent", text: "either/or | fallback\nnext line" }]);
      const body = win.document.querySelector(".pi-chat-md");
      expect(body.querySelector("table")).toBeNull();
      expect(body.textContent).toContain("either/or | fallback");
    });

    test("chat messages do not scroll internally (no per-message max-height)", () => {
      const { win, overlay } = bootOverlay();
      overlay.chat.setOpen(true);
      const css = win.document.querySelector("style")?.textContent || "";
      const msgRule = css.match(/\.pi-chat-msg \{[^}]*\}/)?.[0] || "";
      expect(msgRule).not.toContain("max-height");
      expect(msgRule).not.toContain("overflow-y");
      // the log itself still scrolls
      expect(css).toContain("#__pi_chat_log { flex: 1; overflow-y: auto;");
    });

    test("user messages (from stored transcript) and thinking-less agent messages stay plain (no markdown, no details)", () => {
      const win = new Window({ url: "http://localhost/" }) as any;
      win.sessionStorage.setItem("__pi_chat_msgs", JSON.stringify([{ role: "user", text: "**not md** <b>x</b>" }]));
      const overlay = win.eval(OVERLAY_SCRIPT);
      overlay.chat.setOpen(true);
      overlay.tick([{ kind: "msg", role: "agent", text: "plain answer" }]);
      const user = win.document.querySelector(".pi-chat-msg.user");
      expect(user.textContent).toBe("**not md** <b>x</b>");
      expect(user.querySelector(".pi-chat-md")).toBeNull();
      const agent = win.document.querySelector(".pi-chat-msg.agent");
      expect(agent.querySelector("details")).toBeNull();
      expect(agent.querySelector(".pi-chat-md")?.textContent).toBe("plain answer");
    });
  });
});
