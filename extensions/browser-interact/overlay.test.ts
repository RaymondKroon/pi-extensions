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
});
