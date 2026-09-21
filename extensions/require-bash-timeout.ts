import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Fails any bash (or powershell) tool call that does not specify a timeout,
 * and hard-caps the timeout at MAX_TIMEOUT_SECONDS.
 *
 * The bash tool has no configurable default timeout, so this extension
 * enforces one by blocking timeout-less calls and telling the model to
 * retry with an explicit `timeout` (seconds). Timeouts above the cap are
 * blocked with a reason so the model can lower the value or split the work.
 *
 * Additionally, a lightweight bash parser extracts the command name at every
 * command position in the command string (respecting quotes, comments,
 * operators, subshells, command substitution, wrappers and here-docs) and
 * blocks the call if any of them is in DISALLOWED_COMMANDS.
 *
 * Because a single call is capped at MAX_TIMEOUT_SECONDS, long work must run
 * in the background. To wait for it without busy-waiting (sleep is disallowed),
 * this extension also provides two tools:
 *
 *   - wait_for: block (up to the cap) until a shell condition exits 0.
 *   - alarm:    schedule a later wake-up (timed or condition-based) so the
 *               agent can do other work now and be interrupted when it fires.
 */
const MAX_TIMEOUT_SECONDS = 300;

/**
 * Commands that must never be executed via the bash tool.
 * Map command name -> explanation shown to the model when blocked.
 * Add entries here to disallow more commands.
 */
const DISALLOWED_COMMANDS: Record<string, string> = {
  sleep:
    "sleep is disallowed — do not use it to wait or pace yourself; " +
    "use wait_for to block until a condition is met, or alarm to be woken " +
    "later while you continue other work",
};

/** Wrappers whose actual command is the following word. */
const WRAPPER_COMMANDS = new Set([
  "sudo", "env", "nohup", "nice", "ionice", "command", "exec", "doas", "stdbuf", "time",
]);

/** xargs options that take their value as a separate word. */
const XARGS_VALUE_OPTS = new Set(["-a", "-d", "-E", "-e", "-I", "-L", "-l", "-n", "-P", "-s"]);

/** Shell keywords that appear at command position but are not commands. */
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "while", "until", "do", "done",
  "case", "esac", "for", "in", "function", "select", "!", "{", "}",
]);

const isOperator = (c: string) => ";|&()".includes(c);

/**
 * Pre-scan for here-doc bodies and return their character ranges [start, end).
 * A body starts at the beginning of the line after the line containing the
 * `<<DELIM` token and ends at the first line that is exactly DELIM (leading
 * tabs ignored for `<<-`). Quote- and comment-aware so `<<` inside strings
 * or comments is not treated as a here-doc. Pre-scanning (instead of skipping
 * inline) lets the rest of the opener line (e.g. `cat <<EOF | grep x`) still
 * be parsed as commands.
 */
function findHereDocRanges(command: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < command.length) {
    const c = command[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = command.length;
      let d = i + 2;
      let stripTabs = false;
      if (command[d] === ">") {
        stripTabs = true;
        d++;
      }
      const dStart = d;
      while (d < lineEnd && !/\s/.test(command[d])) d++;
      let delimiter = command.slice(dStart, d);
      if (delimiter !== "") {
        if (delimiter.startsWith("'") || delimiter.startsWith('"')) {
          const q = delimiter[0];
          const end = delimiter.indexOf(q, 1);
          delimiter = end === -1 ? delimiter.slice(1) : delimiter.slice(1, end);
        }
        if (delimiter !== "") {
          const bodyStart = lineEnd + 1;
          let j = bodyStart;
          let bodyEnd = command.length;
          while (j < command.length) {
            let le = command.indexOf("\n", j);
            if (le === -1) le = command.length;
            let line = command.slice(j, le);
            if (stripTabs) line = line.replace(/^\t+/, "");
            if (line === delimiter) {
              bodyEnd = le === command.length ? le : le + 1;
              break;
            }
            j = le + 1;
          }
          ranges.push([bodyStart, bodyEnd]);
        }
      }
      i = lineEnd;
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * Extract the command name (basename) at every command position in a bash
 * command string. Not a full shell parser — good enough to catch direct
 * invocations, pipelines, lists, subshells, $(...), backticks, wrappers and
 * here-docs.
 */
export function extractCommandNames(command: string): string[] {
  const names: string[] = [];
  const hereDocRanges = findHereDocRanges(command);
  let hereDocIdx = 0;
  let i = 0;
  let atCommandPosition = true;
  let skipNextWord = false; // set by `timeout` (skip its duration argument)
  let xargsMode = false;

  // Quote / substitution state stack. Quoted sections are skipped, but
  // command substitutions ($(...) and backticks) inside them are parsed,
  // remembering which quote mode to return to when they close.
  type Mode = "normal" | "single" | "double";
  type Frame = { kind: "single" | "double" | "subst" | "backtick"; resume: Mode; baseDepth: number };
  const stack: Frame[] = [];
  let mode: Mode = "normal";
  let parenDepth = 0;

  while (i < command.length) {
    // Jump over pre-scanned here-doc bodies.
    while (hereDocIdx < hereDocRanges.length && i >= hereDocRanges[hereDocIdx][1]) hereDocIdx++;
    const hereDoc = hereDocRanges[hereDocIdx];
    if (hereDoc && i >= hereDoc[0] && i < hereDoc[1]) {
      i = hereDoc[1];
      atCommandPosition = true; // the line after the delimiter starts a new command
      xargsMode = false;
      continue;
    }

    const c = command[i];

    if (mode === "single") {
      if (c === "'") mode = stack.pop()?.resume ?? "normal";
      i++;
      continue;
    }

    if (mode === "double") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        mode = stack.pop()?.resume ?? "normal";
        i++;
        continue;
      }
      if (c === "`") {
        stack.push({ kind: "backtick", resume: "double", baseDepth: 0 });
        mode = "normal";
        atCommandPosition = true;
        i++;
        continue;
      }
      if (c === "$" && command[i + 1] === "(") {
        stack.push({ kind: "subst", resume: "double", baseDepth: parenDepth });
        mode = "normal";
        parenDepth++;
        atCommandPosition = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // Normal mode.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      atCommandPosition = true;
      xargsMode = false;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      stack.push({ kind: "single", resume: "normal", baseDepth: 0 });
      mode = "single";
      i++;
      continue;
    }
    if (c === '"') {
      stack.push({ kind: "double", resume: "normal", baseDepth: 0 });
      mode = "double";
      i++;
      continue;
    }
    if (c === "`") {
      const top = stack[stack.length - 1];
      if (top?.kind === "backtick") {
        mode = top.resume;
        stack.pop();
      } else {
        stack.push({ kind: "backtick", resume: "normal", baseDepth: 0 });
        atCommandPosition = true;
      }
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      stack.push({ kind: "subst", resume: "normal", baseDepth: parenDepth });
      parenDepth++;
      atCommandPosition = true;
      i += 2;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      atCommandPosition = true;
      xargsMode = false;
      i++;
      continue;
    }
    if (c === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      const top = stack[stack.length - 1];
      if (top?.kind === "subst" && parenDepth === top.baseDepth) {
        mode = top.resume;
        stack.pop();
      }
      atCommandPosition = true;
      xargsMode = false;
      i++;
      continue;
    }
    if (isOperator(c)) {
      atCommandPosition = true;
      xargsMode = false;
      i++;
      continue;
    }

    // Read a full word (may contain quoted parts).
    let j = i;
    while (j < command.length) {
      const ch = command[j];
      if (/\s/.test(ch) || isOperator(ch) || ch === "`") break;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "'") {
        j++;
        while (j < command.length && command[j] !== "'") j++;
        j++;
        continue;
      }
      if (ch === '"') {
        // Peek: if the quoted section contains a command substitution, stop
        // the word here so the main loop parses the quote and its contents.
        let k = j + 1;
        let hasSubst = false;
        while (k < command.length && command[k] !== '"') {
          if (command[k] === "\\") k++;
          else if (command[k] === "$" && command[k + 1] === "(") {
            hasSubst = true;
            break;
          } else if (command[k] === "`") {
            hasSubst = true;
            break;
          }
          k++;
        }
        if (hasSubst) break;
        j = k + 1; // consume the quoted section as part of this word
        continue;
      }
      j++;
    }
    const word = command.slice(i, j);
    i = j;

    if (skipNextWord) {
      skipNextWord = false;
      continue;
    }

    if (!atCommandPosition) continue;

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // VAR=value assignment

    if (SHELL_KEYWORDS.has(word)) {
      // `for`/`select` variable lists and `in` word lists are not commands
      if (word === "in" || word === "for" || word === "select") atCommandPosition = false;
      continue;
    }

    if (word === "timeout") {
      skipNextWord = true; // skip the duration; the word after it is the command
      continue;
    }

    if (word === "xargs") {
      xargsMode = true; // the first non-option word is the command xargs runs
      continue;
    }
    if (xargsMode) {
      if (word.startsWith("-")) {
        let takesSeparateArg = false;
        for (const opt of XARGS_VALUE_OPTS) {
          if (word === opt) takesSeparateArg = true;
          else if (word.startsWith(opt + "=")) break; // attached value: -n=2
          else if (word.startsWith(opt)) break; // attached value: -n2
        }
        if (takesSeparateArg) skipNextWord = true;
        continue;
      }
      xargsMode = false; // fall through: this word is the command xargs runs
    }

    if (WRAPPER_COMMANDS.has(word)) continue; // next word is the real command

    names.push(word.split("/").pop() ?? word);
    atCommandPosition = false;
  }

  return names;
}

/**
 * Detect busy-wait loops: `while`/`until`/`for` loops whose body has no
 * `sleep` and does no real work (only no-ops like `:` / `true` / nothing).
 * These spin the CPU while waiting and should use wait_for / alarm instead.
 * Returns a short description for each detected loop.
 *
 * Conservative on purpose: a loop whose body contains a real command (or a
 * `$(...)`/backtick/`(...)` group) is left alone, so legitimate processing
 * loops are never flagged. Only command-position loop keywords are considered,
 * so `while`/`for` used as plain arguments are ignored.
 */
export function findBusyWaitLoops(command: string): string[] {
  const results: string[] = [];
  const n = command.length;
  const LOOP_KW = new Set(["while", "until", "for"]);
  const NOOP = new Set([":", "true"]);

  // Advance past a group starting at `start` ($( ... ), backticks, or ( ... ))
  // and return the index just past its closing delimiter. Contents are opaque.
  const skipGroup = (start: number): number => {
    const c = command[start];
    if (c === "$" && command[start + 1] === "(") {
      let depth = 1;
      let k = start + 2;
      while (k < n && depth > 0) {
        if (command[k] === "(") depth++;
        else if (command[k] === ")") depth--;
        k++;
      }
      return k;
    }
    if (c === "`") {
      let k = start + 1;
      while (k < n && command[k] !== "`") {
        if (command[k] === "\\") k++;
        k++;
      }
      return k + 1;
    }
    if (c === "(") {
      let depth = 1;
      let k = start + 1;
      while (k < n && depth > 0) {
        if (command[k] === "(") depth++;
        else if (command[k] === ")") depth--;
        k++;
      }
      return k;
    }
    return start + 1;
  };

  // Read one word starting at `start` (quote/comment aware), stopping at
  // whitespace or a shell operator. Returns the word and the index past it.
  const readWord = (start: number): { word: string; next: number } => {
    let k = start;
    while (k < n) {
      const ch = command[k];
      if (/\s/.test(ch) || ";|&()".includes(ch)) break;
      if (ch === "\\") {
        k += 2;
        continue;
      }
      if (ch === "'") {
        k++;
        while (k < n && command[k] !== "'") k++;
        k++;
        continue;
      }
      if (ch === '"') {
        k++;
        while (k < n && command[k] !== '"') k++;
        k++;
        continue;
      }
      k++;
    }
    // Never report zero progress: if the word is empty (e.g. the scanner
    // landed on a bare `)`), advance by one so callers can't spin.
    return { word: command.slice(start, k), next: k === start ? start + 1 : k };
  };

  // A body is a busy-wait if it has no `sleep` and no real command — only
  // no-ops (`:`, `true`) and separators, with no command/substitution groups.
  const isTrivialBusyWaitBody = (body: string): boolean => {
    if (/\bsleep\b/.test(body)) return false;
    const noComments = body.replace(/#[^\n]*/g, " ");
    const noQuotes = noComments.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
    if (/\$\(|`|[()]/.test(noQuotes)) return false; // does real work
    const tokens = noQuotes.split(/[\s;|&]+/).filter(Boolean);
    return tokens.every((t) => NOOP.has(t));
  };

  let i = 0;
  let atCmdPos = true;
  while (i < n) {
    const c = command[i];
    if (/\s/.test(c)) {
      if (c === "\n") atCmdPos = true;
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n && command[i] !== q) {
        if (command[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const end = skipGroup(i);
      results.push(...findBusyWaitLoops(command.slice(i + 2, end - 1)));
      i = end;
      continue;
    }
    if (c === "`" || c === "(") {
      const end = skipGroup(i);
      results.push(...findBusyWaitLoops(command.slice(i + 1, end - 1)));
      if (c === "(") atCmdPos = true;
      i = end;
      continue;
    }
    if (";|&)".includes(c)) {
      // A bare `)` (unbalanced from the scanner's point of view) is just a
      // separator — it must be consumed here, otherwise readWord() returns
      // an empty word and the loop never advances.
      atCmdPos = true;
      i++;
      continue;
    }

    const { word, next } = readWord(i);
    i = next;
    if (!atCmdPos) continue;
    atCmdPos = false;
    if (!LOOP_KW.has(word)) continue;

    // Scan forward for this loop's `do`, then its body up to the matching `done`.
    let j = i; // just past the loop keyword
    let doDoneDepth = 0;
    let sawDo = false;
    let bodyStart = -1;
    let bodyEnd = -1;
    while (j < n) {
      const ch = command[j];
      if (/\s/.test(ch)) {
        j++;
        continue;
      }
      if (ch === "#") {
        while (j < n && command[j] !== "\n") j++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch;
        j++;
        while (j < n && command[j] !== q) {
          if (command[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (ch === "$" && command[j + 1] === "(") {
        j = skipGroup(j);
        continue;
      }
      if (ch === "`" || ch === "(") {
        j = skipGroup(j);
        continue;
      }
      if (";|&)".includes(ch)) {
        j++;
        continue;
      }
      const wStart = j;
      const w = readWord(j);
      j = w.next;
      if (w.word === "do") {
        if (!sawDo) {
          sawDo = true;
          bodyStart = j;
        }
        doDoneDepth++;
        continue;
      }
      if (w.word === "done") {
        doDoneDepth--;
        if (sawDo && doDoneDepth === 0) {
          bodyEnd = wStart;
          break;
        }
        continue;
      }
    }

    if (sawDo && bodyEnd !== -1 && isTrivialBusyWaitBody(command.slice(bodyStart, bodyEnd))) {
      results.push(`${word} loop with no sleep and an empty/no-op body`);
    }
    // Continue the outer scan from just past the keyword (i already == next),
    // so nested loops in the body are also inspected.
  }

  return results;
}

/** Per-check cap so a hanging condition command can't block a wait forever. */
const CHECK_TIMEOUT_MS = 30_000;

/** Abortable sleep: resolves after `ms`, or immediately once `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

interface AlarmEntry {
  cancelled: boolean;
  controller: AbortController;
  timer?: NodeJS.Timeout;
  kind: "timed" | "condition";
  command?: string;
  delaySec?: number;
  intervalSec?: number;
  repeat?: boolean;
  note?: string;
  scheduledAt: number;
}

/** Details the wait_for tool attaches to its result, for rendering. */
interface WaitDetails {
  met: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  elapsedSec?: number;
}

/** Truncate a command for a single-line tool-call display. */
function clipCommand(cmd: string, max = 80): string {
  return cmd.length > max ? `${cmd.slice(0, max - 1)}…` : cmd;
}

export default function (pi: ExtensionAPI) {
  const GUARDED_TOOLS = ["bash", "powershell"] as const;

  const ops = createLocalBashOperations();
  const alarms = new Map<string, AlarmEntry>();
  let alarmSeq = 0;

  const cancelAlarm = (id: string): boolean => {
    const entry = alarms.get(id);
    if (!entry) return false;
    entry.cancelled = true;
    entry.controller.abort();
    if (entry.timer) clearTimeout(entry.timer);
    alarms.delete(id);
    return true;
  };

  const describeAlarm = (id: string, e: AlarmEntry): string => {
    const age = Math.round((Date.now() - e.scheduledAt) / 1000);
    if (e.kind === "timed") {
      const remaining = Math.max(0, Math.round((e.scheduledAt + (e.delaySec ?? 0) * 1000 - Date.now()) / 1000));
      return `alarm ${id}: timed, fires in ~${remaining}s (set ${age}s ago)${e.note ? ` — ${e.note}` : ""}`;
    }
    return `alarm ${id}: polling \`${clipCommand(e.command ?? "", 60)}\` every ${e.intervalSec}s${e.repeat ? ", repeats until met" : ""} (set ${age}s ago)${e.note ? ` — ${e.note}` : ""}`;
  };

  // Run a shell condition once and return its exit code (null on error/timeout).
  const runCheck = async (command: string, cwd: string, signal?: AbortSignal): Promise<number | null> => {
    try {
      const r = await ops.exec(command, cwd, { onData: () => {}, signal, timeout: CHECK_TIMEOUT_MS });
      return r.exitCode;
    } catch {
      return null;
    }
  };

  // ---- wait_for: block until a shell condition exits 0 (or a timeout) ----
  pi.registerTool({
    name: "wait_for",
    label: "Wait For",
    description:
      "Block until a shell command exits 0 (condition met) or a timeout elapses — use to wait for a background job instead of busy-waiting.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run as the check; exit code 0 means the condition is met." }),
      timeout: Type.Optional(Type.Number({ description: `Max seconds to wait (default and max ${MAX_TIMEOUT_SECONDS}).` })),
      interval: Type.Optional(Type.Number({ description: "Seconds between checks (default 2, min 1)." })),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("wait_for "));
      text += theme.fg("accent", clipCommand(args.command));
      if (args.timeout) text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const c = result.content?.[0];
      const msg = c?.type === "text" ? c.text : "";
      if (isPartial) return new Text(theme.fg("warning", msg || "Waiting…"), 0, 0);
      const d = result.details as WaitDetails | undefined;
      const color = d?.met ? "success" : d?.cancelled ? "muted" : "warning";
      return new Text(theme.fg(color, msg), 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const capMs = Math.min(Math.max(1, params.timeout ?? MAX_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) * 1000;
      const intervalMs = Math.max(1, params.interval ?? 2) * 1000;
      const start = Date.now();
      let checks = 0;
      for (;;) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: `Cancelled after ${((Date.now() - start) / 1000).toFixed(1)}s.` }],
            details: { met: false, cancelled: true },
          };
        }
        checks++;
        const exitCode = await runCheck(params.command, ctx.cwd, signal);
        if (exitCode === 0) {
          const s = (Date.now() - start) / 1000;
          return {
            content: [{ type: "text", text: `Condition met after ${s.toFixed(1)}s (${checks} check${checks === 1 ? "" : "s"}).` }],
            details: { met: true, elapsedSec: Number(s.toFixed(1)) },
          };
        }
        if (Date.now() - start >= capMs) {
          return {
            content: [{ type: "text", text: `Timed out after ${capMs / 1000}s waiting for: \`${params.command}\`` }],
            details: { met: false, timedOut: true },
          };
        }
        onUpdate?.({
          content: [{ type: "text", text: `Waiting… ${((Date.now() - start) / 1000).toFixed(0)}s / ${capMs / 1000}s` }],
          details: { met: false },
        });
        await sleep(intervalMs, signal);
      }
    },
  });

  // ---- alarm: schedule a later wake-up (timed or condition-based) ----
  pi.registerTool({
    name: "alarm",
    label: "Alarm",
    description:
      "Schedule a later wake-up — timed (delay) or condition (command that exits 0) — so you can do other work and be interrupted when it fires. Pass cancel to remove one, list to see pending alarms, or repeat to keep a condition alarm polling until it is met.",
    parameters: Type.Object({
      delay: Type.Optional(Type.Number({ description: `Seconds until a timed alarm fires (max ${MAX_TIMEOUT_SECONDS}).` })),
      command: Type.Optional(Type.String({ description: "Shell condition to poll; exit code 0 fires the alarm." })),
      interval: Type.Optional(Type.Number({ description: "Seconds between condition checks (default 2, min 1)." })),
      timeout: Type.Optional(Type.Number({ description: `For condition alarms: give up after this many seconds (default and max ${MAX_TIMEOUT_SECONDS}). Ignored with repeat.` })),
      repeat: Type.Optional(Type.Boolean({ description: "Condition alarms only: on timeout, silently keep polling (re-arm) instead of waking you — you are woken only when the condition is met or you cancel. Use to wait for something that may take a long time (e.g. a human returning to the console)." })),
      note: Type.Optional(Type.String({ description: "Message to include when the alarm wakes you." })),
      cancel: Type.Optional(Type.String({ description: "Cancel the pending alarm with this id instead of scheduling a new one." })),
      list: Type.Optional(Type.Boolean({ description: "List pending alarms instead of scheduling a new one." })),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm "));
      if (args.list) text += theme.fg("dim", "list");
      else if (args.cancel) text += theme.fg("dim", `cancel ${args.cancel}`);
      else if (args.delay != null) text += theme.fg("accent", `in ${args.delay}s`);
      else if (args.command) text += theme.fg("accent", clipCommand(args.command)) + (args.repeat ? theme.fg("dim", " (repeat)") : "");
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.list) {
        const items = [...alarms.entries()].map(([id, e]) => describeAlarm(id, e));
        return {
          content: [{ type: "text", text: items.length ? items.join("\n") : "No pending alarms." }],
          details: { alarms: items },
        };
      }

      if (params.cancel) {
        if (!cancelAlarm(params.cancel)) {
          return { content: [{ type: "text", text: `No pending alarm with id "${params.cancel}".` }], isError: true };
        }
        return { content: [{ type: "text", text: `Cancelled alarm ${params.cancel}.` }], details: { cancelled: true, id: params.cancel } };
      }

      if (params.delay == null && !params.command) {
        return {
          content: [{ type: "text", text: "Provide `delay` (timed) or `command` (condition), or `cancel` (id) / `list`." }],
          isError: true,
        };
      }

      const id = `a${++alarmSeq}`;
      const note = params.note?.trim();
      const timed = params.delay != null;
      const entry: AlarmEntry = {
        cancelled: false,
        controller: new AbortController(),
        kind: timed ? "timed" : "condition",
        command: params.command,
        delaySec: timed ? Math.min(Math.max(1, params.delay!), MAX_TIMEOUT_SECONDS) : undefined,
        intervalSec: timed ? undefined : Math.max(1, params.interval ?? 2),
        repeat: timed ? undefined : !!params.repeat,
        note,
        scheduledAt: Date.now(),
      };
      alarms.set(id, entry);

      const fire = (reason: string) => {
        if (entry.cancelled || !alarms.has(id)) return;
        alarms.delete(id);
        pi.sendMessage(
          {
            customType: "bash-wait-alarm",
            content: `⏰ Alarm ${id}: ${reason}${note ? ` — ${note}` : ""}`,
            display: true,
            details: { id, reason },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      };

      if (timed) {
        const sec = entry.delaySec!;
        entry.timer = setTimeout(() => fire(`fired after ${sec}s`), sec * 1000);
        return {
          content: [{ type: "text", text: `Scheduled timed alarm ${id} in ${sec}s. You will be woken when it fires.` }],
          details: { scheduled: true, id, delaySec: sec },
        };
      }

      const command = entry.command!;
      const intervalMs = entry.intervalSec! * 1000;
      const capMs = Math.min(Math.max(1, params.timeout ?? MAX_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) * 1000;
      const repeat = entry.repeat!;
      void (async () => {
        const start = Date.now();
        while (!entry.cancelled) {
          const exitCode = await runCheck(command, ctx.cwd, entry.controller.signal);
          if (entry.cancelled) return;
          if (exitCode === 0) {
            fire(`condition met: \`${command}\``);
            return;
          }
          if (!repeat && Date.now() - start >= capMs) {
            fire(`timed out after ${capMs / 1000}s; condition was still false at the last check — re-arm (or use repeat) if you expect it to resolve`);
            return;
          }
          await sleep(intervalMs, entry.controller.signal);
        }
      })();
      return {
        content: [
          {
            type: "text",
            text: repeat
              ? `Scheduled condition alarm ${id} (checking every ${intervalMs / 1000}s; repeats until the condition is met). You will be woken only when it is met — cancel ${id} to stop.`
              : `Scheduled condition alarm ${id} (checking every ${intervalMs / 1000}s, up to ${capMs / 1000}s). You will be woken when it is met or times out.`,
          },
        ],
        details: { scheduled: true, id, repeat },
      };
    },
  });

  pi.on("session_shutdown", () => {
    for (const id of [...alarms.keys()]) cancelAlarm(id);
  });

  for (const toolName of GUARDED_TOOLS) {
    pi.on("tool_call", (event) => {
      if (!isToolCallEventType(toolName, event)) return;

      const timeout = event.input.timeout;
      if (typeof timeout !== "number" || timeout <= 0) {
        return {
          block: true,
          reason:
            `Blocked: ${toolName} calls must specify a timeout. ` +
            `Re-run the same command with a "timeout" parameter (seconds) appropriate for the work, ` +
            `e.g. timeout: 60 for quick commands, up to ${MAX_TIMEOUT_SECONDS} for long-running ones.`,
        };
      }

      if (timeout > MAX_TIMEOUT_SECONDS) {
        return {
          block: true,
          reason:
            `Blocked: ${toolName} timeout ${timeout}s exceeds the hard cap of ${MAX_TIMEOUT_SECONDS}s. ` +
            `Re-run with timeout <= ${MAX_TIMEOUT_SECONDS}, or split the work into smaller steps, ` +
            `or run it in the background (e.g. nohup ... &) and use wait_for to block until it finishes, ` +
            `or alarm to be woken later while you do other work.`,
        };
      }

      if (toolName === "bash" && typeof event.input.command === "string") {
        const commands = extractCommandNames(event.input.command);
        const hits = [...new Set(commands.filter((name) => name in DISALLOWED_COMMANDS))];
        if (hits.length > 0) {
          const details = hits.map((name) => `"${name}" — ${DISALLOWED_COMMANDS[name]}`).join("; ");
          return {
            block: true,
            reason: `Blocked: disallowed command(s) in bash call: ${details}. Re-run without them.`,
          };
        }

        const busyWaits = findBusyWaitLoops(event.input.command);
        if (busyWaits.length > 0) {
          return {
            block: true,
            reason:
              `Blocked: busy-wait loop detected (${busyWaits[0]}) — it spins the CPU while waiting. ` +
              `Use wait_for to block until the condition is met, or alarm to be woken later while you do other work.`,
          };
        }
      }
    });
  }
}
