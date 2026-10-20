// browser-interact — in-page overlay: user-facing lens + chat dock.
//
// Injected by the extension with Page.addScriptToEvaluateOnNewDocument (runs
// at the start of every document, so it re-installs on reload/navigation) plus
// a runtime fallback when a re-attach lost the registration. It runs in the
// MAIN world: the DOM is shared with the page by design (the user sees the
// dock, the page can read the rendered transcript), and the only channel into
// the pi session is the polled signal queue — chat text is only accepted from
// IS-TRUSTED user events (a page script can set input.value or dispatch
// synthetic events, but neither reaches the signal).
//
// NEW-DOCUMENT QUIRK: when the script runs at document start,
// document.documentElement is still NULL, so all DOM construction is deferred
// to DOMContentLoaded (boot is idempotent; API calls boot lazily). A direct
// runtime injection (readyState already past loading) boots immediately.
//
// State lives in sessionStorage (lens notes + on/off, chat transcript tail,
// dock position/open state), so everything the user drew or typed survives a
// reload in the same tab.
//
// NOTE: no backticks / `${` interpolation inside the script body — it is one
// big TS template literal; the page code uses plain string concatenation.
// (OVERLAY_V is the single controlled interpolation.)
// Double-escape trap: TS template literals COOK escapes, so the page source
// sees one fewer backslash than the file. Regex classes/escapes in page
// code must be doubled in this file (`\\s`, `\\*`, `\\n` — a single `\\s`
// cooks to a bare `s` and silently breaks the regex), and `\"` inside a page
// string cooks to a raw quote that truncates it — use single-quoted page
// strings when they contain double quotes. `\\u0060` is the safe way to put
// a backtick in the page source (it cooks to the character). The
// "parses as a standalone script" test in overlay.test.ts is the backstop.

export const OVERLAY_V = 8;

export const OVERLAY_SCRIPT = `(() => {
  const OVERLAY_V = ${OVERLAY_V};
  if (window.__piOverlay && window.__piOverlay.__v === OVERLAY_V) return window.__piOverlay;
  // Fresh or stale version (including the legacy standalone lens): tear down
  // old DOM nodes and WINDOW listeners first, or every old version keeps
  // re-rendering markers and reacting to the user's mouse/keys.
  try {
    const L = window.__piOverlayListeners || window.__piLensListeners;
    if (L) {
      if (L.mousedown) window.removeEventListener("mousedown", L.mousedown, true);
      if (L.mousemove) window.removeEventListener("mousemove", L.mousemove, true);
      if (L.mouseup) window.removeEventListener("mouseup", L.mouseup, true);
      if (L.keydown) window.removeEventListener("keydown", L.keydown, true);
      if (L.scroll) window.removeEventListener("scroll", L.scroll);
    }
    document.querySelectorAll("[data-pi-lens], [data-pi-chat], .pi-lens-marker, .pi-lens-chip").forEach((n) => n.remove());
  } catch (e) {}
  window.__piOverlayListeners = null;
  window.__piLensListeners = null;
  window.__piOverlay = undefined;
  window.__piLens = undefined;

  const Z = 2147483647;

  // ---------- signal queue (polled by the extension; console events are
  // dropped by the Browser Bridge proxy, so the page cannot push directly) --
  let signals = [];
  const push = (sig) => { signals.push(sig); };

  // ---- minimal markdown for agent messages (escape-first; raw HTML in the
  // source can never reach the DOM as markup; no external libs, no backticks
  // in this template) ----
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inlineMd = (s) =>
    s
      .replace(/\u0060([^\u0060]+)\u0060/g, "<code>$1</code>")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?!\\*)/g, "$1<em>$2</em>")
      .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[^"'\\w])((?:https?:\\/\\/)[^\\s<>)\\]]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const isTableSep = (s) => {
  const t = s.trim();
  if (t.indexOf("|") === -1 || t.indexOf("-") === -1) return false;
  const cells = t.replace(/^[|]/, "").replace(/[|]$/, "").split("|");
  return cells.every((c) => /^:?\\s*-+\\s*:?\\s*$/.test(c));
  };
  const splitTableRow = (s) => {
  let t = s.trim();
  if (t.charAt(0) === "|") t = t.slice(1);
  if (t.charAt(t.length - 1) === "|") t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
  };
  const md = (text) => {
    const F = "\u0060\u0060\u0060";
    const lines = esc(text).split("\\n");
    const out = [];
    let para = [], listTag = null, listItems = [], quote = [];
    const flushPara = () => { if (para.length) { out.push("<p>" + para.map(inlineMd).join("<br>") + "</p>"); para = []; } };
    const flushList = () => { if (listTag) { out.push("<" + listTag + ">" + listItems.map((li) => "<li>" + inlineMd(li) + "</li>").join("") + "</" + listTag + ">"); listTag = null; listItems = []; } };
    const flushQuote = () => { if (quote.length) { out.push("<blockquote>" + quote.map(inlineMd).join("<br>") + "</blockquote>"); quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.indexOf(F) === 0) {
        flushAll();
        const buf = [];
        i++;
        while (i < lines.length && lines[i].indexOf(F) !== 0) { buf.push(lines[i]); i++; }
        out.push('<pre class="pi-md-code">' + buf.join("\\n") + "</pre>");
        continue;
      }
      if (ln.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushAll();
        const head = splitTableRow(ln);
        i += 2;
        const body = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") { body.push(splitTableRow(lines[i])); i++; }
        i--;
        out.push('<table class="pi-md-table"><thead><tr>' + head.map((c) => "<th>" + inlineMd(c) + "</th>").join("") + "</tr></thead><tbody>" + body.map((r) => "<tr>" + r.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>");
        continue;
      }
      const ul = ln.match(/^\\s*[-*]\\s+(.*)/);
      const ol = ln.match(/^\\s*\\d+[.)]\\s+(.*)/);
      const hd = ln.match(/^(#{1,4})\\s+(.*)/);
      const qt = ln.match(/^\\s*&gt;\\s?(.*)/);
      if (ul || ol) {
        flushPara(); flushQuote();
        const tag = ul ? "ul" : "ol";
        if (listTag && listTag !== tag) flushList();
        listTag = tag;
        listItems.push((ul || ol)[1]);
      } else if (hd) {
        flushAll();
        const lvl = Math.min(hd[1].length + 3, 6);
        out.push("<h" + lvl + ">" + inlineMd(hd[2]) + "</h" + lvl + ">");
      } else if (qt) {
        flushPara(); flushList();
        quote.push(qt[1]);
      } else if (ln.trim() === "") {
        flushAll();
      } else {
        flushList(); flushQuote();
        para.push(ln);
      }
    }
    flushAll();
    return out.join("");
  };

  // ---------------- lens state --------------------------------------------
  const NKEY = "__pi_lens_notes";
  const EKEY = "__pi_lens_enabled";
  let notes = [];
  try { notes = JSON.parse(sessionStorage.getItem(NKEY) || "[]"); } catch (e) { notes = []; }
  let lensOn = false;
  try { lensOn = sessionStorage.getItem(EKEY) === "1"; } catch (e) {}
  const saveNotes = () => { try { sessionStorage.setItem(NKEY, JSON.stringify(notes)); } catch (e) {} };

  // ---------------- chat state ---------------------------------------------
  const MKEY = "__pi_chat_msgs";
  const OKEY = "__pi_chat_open";
  const PKEY = "__pi_chat_pos";
  const MAX_STORED = 50;
  const MAX_DOM_MSGS = 200;
  let msgs = [];
  try { msgs = JSON.parse(sessionStorage.getItem(MKEY) || "[]"); } catch (e) { msgs = []; }
  let chatOpen = false;
  try { chatOpen = sessionStorage.getItem(OKEY) === "1"; } catch (e) {}
  let pos = null;
  try { pos = JSON.parse(sessionStorage.getItem(PKEY) || "null"); } catch (e) { pos = null; }
  let busy = false;
  let shadow = ""; // trusted-only copy of the input value (page scripts can
                   // set input.value or dispatch fake events; neither updates
                   // this, so only real user keystrokes can be sent)

  const saveMsgs = () => { try { sessionStorage.setItem(MKEY, JSON.stringify(msgs.slice(-MAX_STORED))); } catch (e) {} };
  const saveChatOpen = () => { try { sessionStorage.setItem(OKEY, chatOpen ? "1" : "0"); } catch (e) {} };
  const savePos = () => { try { sessionStorage.setItem(PKEY, JSON.stringify(pos)); } catch (e) {} };

  // ---------------- DOM (deferred: documentElement is NULL at document
  // start, so this boots on DOMContentLoaded or immediately when injected
  // into an already-loaded document) ----------------------------------------
  let booted = false;
  let log, chatPanel, chatInput, dot, chatBtn, head, lensBtn;
  let box, panel, input;
  let markers = [];

  const boot = () => {
    if (booted || !document.documentElement) return;
    booted = true;

    // ---- lens nodes
    box = document.createElement("div"); box.id = "__pi_lens_box";
    panel = document.createElement("div"); panel.id = "__pi_lens_panel";
    input = document.createElement("input"); input.id = "__pi_lens_input"; input.maxLength = 500; input.placeholder = "note for the agent...";
    const hint = document.createElement("div"); hint.id = "__pi_lens_hint"; hint.textContent = "enter = save \u00b7 esc = cancel";
    panel.appendChild(input); panel.appendChild(hint);
    box.setAttribute("data-pi-lens", "1"); panel.setAttribute("data-pi-lens", "1");
    input.setAttribute("data-pi-lens", "1"); hint.setAttribute("data-pi-lens", "1");

    // ---- chat nodes
    chatBtn = document.createElement("button"); chatBtn.id = "__pi_chat_btn"; chatBtn.textContent = "\ud83d\udcac pi";
    chatPanel = document.createElement("div"); chatPanel.id = "__pi_chat_panel";
    const chatHead = document.createElement("div"); chatHead.id = "__pi_chat_head";
    dot = document.createElement("span"); dot.id = "__pi_chat_dot";
    const headTitle = document.createElement("span"); headTitle.textContent = "pi chat";
    const headSpacer = document.createElement("span"); headSpacer.style.flex = "1";
    lensBtn = document.createElement("button"); lensBtn.className = "pi-chat-hbtn"; lensBtn.id = "__pi_chat_lensbtn"; lensBtn.textContent = "\ud83d\udd0d"; lensBtn.title = "toggle pi-lens (drag boxes to point at things)";
    const switchBtn = document.createElement("button"); switchBtn.className = "pi-chat-hbtn"; switchBtn.id = "__pi_chat_switch"; switchBtn.textContent = "\u21c4"; switchBtn.title = "Switch this dock to another tab: bring the Chrome tab you want to the front, then click here (same as /tab use <active>)";
    const detachBtn = document.createElement("button"); detachBtn.className = "pi-chat-hbtn"; detachBtn.id = "__pi_chat_detach"; detachBtn.textContent = "\u2702"; detachBtn.title = "Detach the dock from this tab (the browser tab stays open)";
    const minBtn = document.createElement("button"); minBtn.className = "pi-chat-hbtn"; minBtn.textContent = "\u2013"; minBtn.title = "minimize (click \u201c\u2009pi\u201d to reopen)";
    const closeBtn = document.createElement("button"); closeBtn.className = "pi-chat-hbtn"; closeBtn.textContent = "\u2715"; closeBtn.title = "close";
    chatHead.appendChild(dot); chatHead.appendChild(headTitle); chatHead.appendChild(headSpacer);
    chatHead.appendChild(lensBtn); chatHead.appendChild(switchBtn); chatHead.appendChild(detachBtn); chatHead.appendChild(minBtn); chatHead.appendChild(closeBtn);
    log = document.createElement("div"); log.id = "__pi_chat_log";
    const inRow = document.createElement("div"); inRow.id = "__pi_chat_inrow";
    chatInput = document.createElement("textarea"); chatInput.id = "__pi_chat_input"; chatInput.maxLength = 4000; chatInput.rows = 2;
    chatInput.placeholder = "ask the agent\u2026 (enter = send, shift+enter = newline)";
    const sendBtn = document.createElement("button"); sendBtn.id = "__pi_chat_send"; sendBtn.textContent = "\u27a4"; sendBtn.title = "send";
    inRow.appendChild(chatInput); inRow.appendChild(sendBtn);
    const resize = document.createElement("div"); resize.className = "pi-chat-resize"; resize.id = "__pi_chat_resize";
    chatPanel.appendChild(chatHead); chatPanel.appendChild(log); chatPanel.appendChild(inRow); chatPanel.appendChild(resize);
    head = chatHead;
    [chatBtn, chatPanel, chatHead, dot, headTitle, lensBtn, switchBtn, detachBtn, minBtn, closeBtn, log, inRow, chatInput, sendBtn, resize].forEach((n) => n.setAttribute("data-pi-chat", "1"));

    // ---- transcript rendering
    const nearBottom = () => log.scrollTop + log.clientHeight >= log.scrollHeight - 80;
    const scrollDown = (force) => { if (force || nearBottom()) log.scrollTop = log.scrollHeight; };
    const trimDom = () => { let n = 0; while (log.children.length > MAX_DOM_MSGS && n++ < 100) if (log.firstChild) log.removeChild(log.firstChild); else break; };
    const renderMsg = (m) => {
      if (m.kind === "tool") {
        const d = document.createElement("div"); d.className = "pi-chat-tool";
        const head = document.createElement("span"); head.className = "pi-chat-tool-head";
        head.textContent = "\u2699 " + m.name + (m.ok ? " \u2713" : " \u2717 failed");
        d.appendChild(head);
        const hasDetail = !!(m.args || m.result);
        if (hasDetail) {
          d.classList.add("has-detail");
          const det = document.createElement("div"); det.className = "pi-chat-tool-detail";
          if (m.args) {
            const ah = document.createElement("div"); ah.className = "pi-chat-tool-sec"; ah.textContent = "arguments";
            const ap = document.createElement("pre"); ap.textContent = m.args;
            det.appendChild(ah); det.appendChild(ap);
          }
          if (m.result) {
            const rh = document.createElement("div"); rh.className = "pi-chat-tool-sec" + (m.ok ? "" : " err"); rh.textContent = m.ok ? "result" : "error";
            const rp = document.createElement("pre"); rp.textContent = m.result;
            det.appendChild(rh); det.appendChild(rp);
          }
          d.appendChild(det);
          d.addEventListener("click", (ev) => { if (ev.isTrusted) d.classList.toggle("open"); });
        }
        log.appendChild(d);
      } else {
        const d = document.createElement("div");
        d.className = "pi-chat-msg " + (m.role === "user" ? "user" : "agent");
        if (m.role === "agent") {
          if (m.thinking) {
            const th = document.createElement("details");
            th.className = "pi-chat-thinking";
            const sum = document.createElement("summary");
            sum.textContent = "thinking";
            th.appendChild(sum);
            const tp = document.createElement("pre");
            tp.textContent = m.thinking;
            th.appendChild(tp);
            d.appendChild(th);
          }
          const b = document.createElement("div");
          b.className = "pi-chat-md";
          b.innerHTML = md(m.text || "");
          d.appendChild(b);
        } else {
          d.textContent = m.text || "";
        }
        log.appendChild(d);
      }
      trimDom();
    };
    window.__piOverlayRender = (m, forceScroll) => { if (!booted) return; if (chatOpen) { const keep = nearBottom(); renderMsg(m); scrollDown(forceScroll || keep); } };

    for (const m of msgs) renderMsg(m);
    if (!msgs.length) {
      const h = document.createElement("div"); h.className = "pi-chat-hint";
      h.textContent = "The agent drives this browser via trusted input. Ask it to inspect, click, or fix things on this page \u2014 or drag a box with the \ud83d\udd0d lens to point at something.";
      log.appendChild(h);
    }

    // ---- shared mouse state (lens box drag + chat drag/resize)
    let drag = null, lensDrag = null, lensPending = null;
    const place = (el, x, y, w, h) => { el.style.left = x + "px"; el.style.top = y + "px"; el.style.width = w + "px"; el.style.height = h + "px"; };
    const overOverlay = (t) => !!(t && t.closest && (t.closest("[data-pi-chat]") || t.closest("[data-pi-lens]") || t.closest(".pi-lens-chip")));

    const removeNote = (i) => {
      if (i < 1 || i > notes.length) return;
      notes.splice(i - 1, 1); saveNotes(); renderMarkers();
      push({ type: "note-removed", index: i });
    };
    const renderMarkers = () => {
      for (const m of markers) m.remove(); markers.length = 0;
      if (!lensOn) return;
      notes.forEach((n, i) => {
        const x = n.docX - window.scrollX, y = n.docY - window.scrollY;
        if (x > window.innerWidth || y > window.innerHeight || x + n.w < 0 || y + n.h < 0) return;
        const d = document.createElement("div"); d.className = "pi-lens-marker"; place(d, Math.max(0, x), Math.max(0, y), n.w, n.h);
        document.documentElement.appendChild(d); markers.push(d);
        const c = document.createElement("div"); c.className = "pi-lens-chip";
        c.textContent = (i + 1) + (n.text ? " " + n.text : "") + " \u2715";
        c.title = "click to remove this note";
        c.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); removeNote(i + 1); }, true);
        c.style.left = Math.max(0, x) + "px";
        c.style.top = Math.max(0, y - 18) + "px";
        document.documentElement.appendChild(c); markers.push(c);
      });
    };

    // ---- chat send (trusted-only)
    const send = () => {
      const t = shadow.trim();
      if (!t) return;
      shadow = ""; chatInput.value = "";
      msgs.push({ role: "user", text: t.slice(0, 4000) });
      saveMsgs();
      window.__piOverlayRender({ role: "user", text: t.slice(0, 4000) }, true);
      push({ type: "chat", text: t.slice(0, 4000) });
    };
    chatInput.addEventListener("input", (e) => { if (e.isTrusted) shadow = chatInput.value; });
    chatInput.addEventListener("keydown", (e) => {
      if (!e.isTrusted) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      else if (e.key === "Escape") { e.preventDefault(); chatInput.blur(); }
    });
    sendBtn.addEventListener("click", (e) => { if (e.isTrusted) send(); });

    const setBusy = (b) => {
      busy = !!b;
      if (!booted) return;
      dot.className = busy ? "busy" : "";
      chatBtn.classList.toggle("busy", busy);
    };

    // ---- layout / drag / resize
    const layoutPanel = () => {
      const w = pos && pos.w ? Math.max(280, Math.min(pos.w, window.innerWidth - 16)) : 400;
      const h = pos && pos.h ? Math.max(200, Math.min(pos.h, window.innerHeight - 16)) : 320;
      chatPanel.style.width = w + "px";
      chatPanel.style.height = h + "px";
      let x, y;
      if (pos && pos.x !== undefined && pos.y !== undefined) { x = pos.x; y = pos.y; }
      else { x = window.innerWidth - w - 16; y = window.innerHeight - h - 76; }
      x = Math.max(0, Math.min(x, window.innerWidth - 60));
      y = Math.max(0, Math.min(y, window.innerHeight - 40));
      chatPanel.style.left = x + "px";
      chatPanel.style.top = y + "px";
    };
    head.addEventListener("mousedown", (e) => {
      if (!e.isTrusted || e.button !== 0 || !head.contains(e.target)) return;
      if (e.target.closest("button")) return;
      e.preventDefault();
      const r = chatPanel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    }, true);
    resize.addEventListener("mousedown", (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      e.preventDefault();
      const r = chatPanel.getBoundingClientRect();
      drag = { resizing: true, w0: r.width, h0: r.height, x0: e.clientX, y0: e.clientY };
    }, true);
    const onMousedown = (e) => {
      if (drag || lensDrag) return;
      if (!lensOn || e.button !== 0 || overOverlay(e.target)) return;
      e.preventDefault();
      lensDrag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      box.style.display = "block";
    };
    const onMousemove = (e) => {
      if (lensDrag) {
        lensDrag.x1 = e.clientX; lensDrag.y1 = e.clientY;
        place(box, Math.min(lensDrag.x0, lensDrag.x1), Math.min(lensDrag.y0, lensDrag.y1), Math.abs(lensDrag.x1 - lensDrag.x0), Math.abs(lensDrag.y1 - lensDrag.y0));
        return;
      }
      if (!drag) return;
      if (drag.resizing) {
        pos = { x: parseInt(chatPanel.style.left, 10) || 0, y: parseInt(chatPanel.style.top, 10) || 0, w: Math.max(280, drag.w0 + e.clientX - drag.x0), h: Math.max(200, drag.h0 + e.clientY - drag.y0) };
      } else {
        pos = { x: Math.max(-200, Math.min(e.clientX - drag.dx, window.innerWidth - 60)), y: Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - 40)), w: parseInt(chatPanel.style.width, 10) || 400, h: parseInt(chatPanel.style.height, 10) || 320 };
      }
      layoutPanel();
    };
    const onMouseup = (e) => {
      if (lensDrag) {
        const x = Math.min(lensDrag.x0, lensDrag.x1), y = Math.min(lensDrag.y0, lensDrag.y1);
        const w = Math.abs(lensDrag.x1 - lensDrag.x0), h = Math.abs(lensDrag.y1 - lensDrag.y0);
        lensDrag = null;
        if (w < 8 || h < 8) { box.style.display = "none"; return; } // accidental click, ignore
        lensPending = { x, y, w, h };
        input.value = "";
        panel.style.display = "block";
        const pw = 340;
        panel.style.left = Math.max(8, Math.min(x + w / 2, window.innerWidth - pw)) + "px";
        const above = y - 90 > 8 ? y - 90 : y + h + 10; // prefer above the box
        panel.style.top = Math.max(8, Math.min(above, window.innerHeight - 90)) + "px";
        input.focus();
        return;
      }
      if (drag) { drag = null; savePos(); }
    };

    // ---- lens enable/disable
    const setLensOn = (on) => {
      lensOn = !!on;
      try { sessionStorage.setItem(EKEY, lensOn ? "1" : "0"); } catch (e) {}
      if (!booted) return;
      document.documentElement.classList.toggle("__pi_lens_on", lensOn);
      lensBtn.classList.toggle("on", lensOn);
      lensBtn.title = lensOn
        ? "pi-lens ARMED — drag a box around something and type a note; click to turn off"
        : "toggle pi-lens (drag boxes to point at things)";
      if (!lensOn) {
        box.style.display = "none"; panel.style.display = "none";
        lensDrag = null; lensPending = null;
        for (const m of markers) m.remove(); markers.length = 0;
      } else {
        renderMarkers();
      }
    };
    lensBtn.addEventListener("click", () => setLensOn(!lensOn));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!lensPending) return;
        notes.push({
          docX: Math.round(lensPending.x + window.scrollX),
          docY: Math.round(lensPending.y + window.scrollY),
          w: Math.round(lensPending.w),
          h: Math.round(lensPending.h),
          text: input.value.trim(),
          t: new Date().toISOString(),
        });
        saveNotes();
        lensPending = null;
        panel.style.display = "none";
        box.style.display = "none";
        renderMarkers();
        push({ type: "note-saved", index: notes.length, text: notes[notes.length - 1].text });
      } else if (e.key === "Escape") {
        e.preventDefault();
        lensPending = null;
        panel.style.display = "none";
        box.style.display = "none";
      }
    });
    const onKeydown = (e) => {
      if (e.key !== "Escape" || !lensOn || e.target === input) return; // input handler owns its own esc
      if (lensPending) { lensPending = null; panel.style.display = "none"; box.style.display = "none"; return; }
      setLensOn(false);
    };
    const onScroll = () => { if (lensOn) renderMarkers(); };
    window.addEventListener("mousedown", onMousedown, true);
    window.addEventListener("mousemove", onMousemove, true);
    window.addEventListener("mouseup", onMouseup, true);
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    // Track window listeners so a newer overlay version can remove them.
    window.__piOverlayListeners = { mousedown: onMousedown, mousemove: onMousemove, mouseup: onMouseup, keydown: onKeydown, scroll: onScroll };

    // ---- chat dock open/close + wiring
    const setChatOpen = (o) => {
      chatOpen = !!o;
      saveChatOpen();
      if (!booted) return;
      chatPanel.classList.toggle("open", chatOpen);
      if (chatOpen) { layoutPanel(); scrollDown(true); try { chatInput.focus(); } catch (e) {} }
    };
    chatBtn.addEventListener("click", (e) => { if (e.isTrusted) setChatOpen(!chatOpen); });
    minBtn.addEventListener("click", (e) => { if (e.isTrusted) setChatOpen(false); });
    closeBtn.addEventListener("click", (e) => { if (e.isTrusted) setChatOpen(false); });
    // Dock-switching controls: signals are popped by the poller WITH the
    // tab's identity, so the session knows exactly which tab asked.
    switchBtn.addEventListener("click", (e) => { if (e.isTrusted) push({ type: "dock-connect-active" }); });
    detachBtn.addEventListener("click", (e) => { if (e.isTrusted) push({ type: "dock-detach" }); });

    // ---- styles
    const style = document.createElement("style");
    style.setAttribute("data-pi-chat", "style");
    style.textContent =
      "html.__pi_lens_on, html.__pi_lens_on body { cursor: crosshair !important; }" +
      "#__pi_lens_box { position: fixed; z-index: " + (Z - 1) + "; pointer-events: none; display: none; border: 2px solid #2563eb; background: rgba(37,99,235,.10); }" +
      ".pi-lens-marker { position: fixed; z-index: " + (Z - 2) + "; pointer-events: none; border: 1px solid rgba(37,99,235,.8); background: rgba(37,99,235,.06); }" +
      ".pi-lens-chip { position: fixed; z-index: " + (Z - 1) + "; pointer-events: auto; cursor: pointer; background: #2563eb; color: #fff; border-radius: 4px 4px 4px 0; padding: 1px 6px; font: 11px/1.5 ui-sans-serif, system-ui, sans-serif; white-space: nowrap; }" +
      ".pi-lens-chip:hover { background: #dc2626; }" +
      "#__pi_lens_panel { position: fixed; z-index: " + Z + "; pointer-events: auto; display: none; background: #fff; color: #111827; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.25); font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }" +
      "#__pi_lens_input { width: 320px; max-width: 60vw; padding: 6px 8px; border: 1px solid #9ca3af; border-radius: 6px; font: inherit; }" +
      "#__pi_lens_hint { margin-top: 4px; color: #6b7280; font-size: 11px; }" +
      "#__pi_chat_btn { position: fixed; right: 16px; bottom: 16px; z-index: " + Z + "; pointer-events: auto; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 999px; padding: 6px 12px; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.4); }" +
      "#__pi_chat_btn.busy { background: #b45309; border-color: #f59e0b; color: #fff; }" +
      "#__pi_chat_panel { position: fixed; z-index: " + Z + "; pointer-events: auto; display: none; flex-direction: column; background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5); font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; overflow: hidden; }" +
      "#__pi_chat_panel.open { display: flex; }" +
      "#__pi_chat_head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: move; border-bottom: 1px solid #374151; background: #111827; user-select: none; }" +
      "#__pi_chat_dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: none; }" +
      "#__pi_chat_dot.busy { background: #f59e0b; }" +
      ".pi-chat-hbtn { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 13px; line-height: 1; padding: 3px 5px; border-radius: 4px; }" +
      ".pi-chat-hbtn:hover { color: #fff; background: #374151; }" +
      ".pi-chat-hbtn.on { background: #1d4ed8; color: #fff; }" +
      "#__pi_chat_log { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }" +
      ".pi-chat-hint { color: #6b7280; font-size: 12px; margin-bottom: 8px; }" +
      ".pi-chat-msg { margin: 0 0 8px; padding: 6px 9px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }" +
      ".pi-chat-msg.user { background: #1d4ed8; margin-left: 18%; }" +
      ".pi-chat-msg.agent { background: #374151; margin-right: 18%; white-space: normal; }" +
      ".pi-chat-md p { margin: 2px 0 6px; }" +
      ".pi-chat-md p:last-child { margin-bottom: 0; }" +
      ".pi-chat-md h4, .pi-chat-md h5, .pi-chat-md h6 { margin: 6px 0 2px; font-size: 12px; }" +
      ".pi-chat-md ul, .pi-chat-md ol { margin: 2px 0 6px; padding-left: 18px; }" +
      ".pi-chat-md li { margin: 1px 0; }" +
      ".pi-chat-md code { background: #111827; border: 1px solid #374151; border-radius: 3px; padding: 0 3px; font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; }" +
      ".pi-chat-md pre.pi-md-code { background: #111827; border: 1px solid #374151; border-radius: 6px; padding: 5px 8px; margin: 3px 0 6px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: #d1d5db; }" +
      ".pi-chat-md a { color: #60a5fa; }" +
      ".pi-chat-md blockquote { border-left: 2px solid #4b5563; margin: 3px 0 6px; padding-left: 8px; color: #9ca3af; }" +
      ".pi-md-table { border-collapse: collapse; margin: 3px 0 6px; max-width: 100%; }" +
      ".pi-md-table th, .pi-md-table td { border: 1px solid #4b5563; padding: 2px 8px; text-align: left; }" +
      ".pi-md-table th { background: #111827; }" +
      ".pi-chat-thinking { margin: 0 0 6px; }" +
      ".pi-chat-thinking summary { cursor: pointer; color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; user-select: none; }" +
      ".pi-chat-thinking[open] summary { margin-bottom: 3px; }" +
      ".pi-chat-thinking pre { margin: 0; padding: 5px 8px; background: #111827; border: 1px solid #374151; border-radius: 6px; max-height: 120px; overflow-y: auto; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: #9ca3af; }" +
      ".pi-chat-tool { color: #6b7280; font-size: 11px; margin: 2px 0 6px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
      ".pi-chat-tool.has-detail { display: flex; flex-direction: column; white-space: normal; cursor: pointer; }" +
      ".pi-chat-tool.has-detail .pi-chat-tool-head { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
      ".pi-chat-tool.has-detail:hover .pi-chat-tool-head { color: #d1d5db; }" +
      ".pi-chat-tool-head::before { content: none; }" +
      ".pi-chat-tool.has-detail .pi-chat-tool-head::before { content: '\\u25b8  '; color: #4b5563; }" +
      ".pi-chat-tool.open .pi-chat-tool-head::before { content: '\\u25be  '; color: #4b5563; }" +
      ".pi-chat-tool-detail { display: none; margin-top: 3px; padding: 4px 8px; background: #111827; border: 1px solid #374151; border-radius: 6px; max-height: 160px; overflow-y: auto; }" +
      ".pi-chat-tool.open .pi-chat-tool-detail { display: block; }" +
      ".pi-chat-tool-sec { color: #6b7280; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; margin-top: 3px; }" +
      ".pi-chat-tool-sec.err { color: #f87171; }" +
      ".pi-chat-tool-detail pre { margin: 2px 0 6px; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: #d1d5db; }" +
      "#__pi_chat_inrow { display: flex; align-items: flex-end; gap: 6px; padding: 0 8px 8px; }" +
      "#__pi_chat_input { flex: 1; resize: none; height: 54px; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; padding: 6px 8px; font: inherit; }" +
      "#__pi_chat_input:focus { outline: none; border-color: #3b82f6; }" +
      "#__pi_chat_send { background: #1d4ed8; color: #fff; border: none; border-radius: 8px; height: 54px; padding: 0 12px; cursor: pointer; font-size: 15px; }" +
      "#__pi_chat_send:hover { background: #2563eb; }" +
      ".pi-chat-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, #4b5563 50%); }";
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(panel);
    document.documentElement.appendChild(chatBtn);
    document.documentElement.appendChild(chatPanel);

    // ---- initial visual state
    setLensOn(lensOn);
    layoutPanel();
    setChatOpen(chatOpen);

    // ---- hooks for the lazy API (assigned once the DOM exists)
    window.__piOverlayLens = {
      setEnabled: setLensOn,
      clear: () => { notes = []; saveNotes(); renderMarkers(); },
      remove: removeNote,
    };
    window.__piOverlayChat = { setOpen: setChatOpen };
    window.__piOverlayBusy = setBusy;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // ---------------- API (boot lazily so early calls are safe) ---------------
  const snapshot = () => ({
    enabled: lensOn,
    url: location.href,
    title: document.title,
    notes: notes.map((n, i) => ({
      index: i + 1,
      x: Math.round(n.docX - window.scrollX), // viewport coords at snapshot time
      y: Math.round(n.docY - window.scrollY),
      docX: n.docX, docY: n.docY, w: n.w, h: n.h,
      text: n.text,
      time: n.t,
    })),
  });

  // Agent-side rendering hook set inside boot(); used by tick below.
  const addAgent = (text, thinking) => {
    const t = String(text ?? "");
    const th = String(thinking ?? "").trim();
    if (!t.trim() && !th) return;
    const m = { role: "agent", text: t.slice(0, 8000) };
    if (th) m.thinking = th.slice(0, 4000);
    msgs.push(m); saveMsgs();
    if (window.__piOverlayRender) window.__piOverlayRender(m, true);
  };
  const addTool = (name, ok, args, result) => {
    const m = { kind: "tool", name: String(name || "tool"), ok: !!ok, args: String(args ?? "").slice(0, 2000), result: String(result ?? "").slice(0, 4000) };
    msgs.push(m); saveMsgs();
    if (window.__piOverlayRender) window.__piOverlayRender(m, false);
  };
  const setBusy = (b) => {
    busy = !!b;
    if (window.__piOverlayBusy) window.__piOverlayBusy(!!b);
  };

  /** Apply extension-side updates (polled) and return the popped signals. */
  const tick = (updates) => {
    if (Array.isArray(updates)) {
      for (const u of updates) {
        if (!u || typeof u !== "object") continue;
        if (u.kind === "status") setBusy(!!u.busy);
        else if (u.kind === "msg") addAgent(u.text, u.thinking);
        else if (u.kind === "tool") addTool(u.name, u.ok, u.args, u.result);
      }
    }
    const out = signals;
    signals = [];
    return out;
  };

  window.__piOverlay = {
    __v: OVERLAY_V,
    lens: {
      setEnabled: (v) => { boot(); window.__piOverlayLens.setEnabled(v); },
      snapshot: snapshot,
      clear: () => { notes = []; saveNotes(); if (window.__piOverlayLens) window.__piOverlayLens.clear(); },
      remove: (i) => { if (window.__piOverlayLens) window.__piOverlayLens.remove(i); },
    },
    chat: {
      setOpen: (o) => { boot(); window.__piOverlayChat.setOpen(!!o); },
      isOpen: () => chatOpen,
    },
    tick: tick,
  };
  return window.__piOverlay;
})();`;
