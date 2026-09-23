import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  getShellConfig,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * better-bash — wait discipline for the bash tool.
 *
 *  1. Fails any bash (or powershell) tool call that does not specify a
 *     timeout, and hard-caps the timeout at MAX_TIMEOUT_SECONDS. The bash
 *     tool has no configurable default timeout, so this extension enforces
 *     one by blocking timeout-less calls and telling the model to retry
 *     with an explicit `timeout` (seconds). Timeouts above the cap are
 *     blocked with a reason so the model can lower the value or split the
 *     work.
 *
 *  2. A lightweight bash parser extracts the command name at every command
 *     position in the command string (respecting quotes, comments,
 *     operators, subshells, command substitution, wrappers and here-docs)
 *     and blocks the call if any of them is in DISALLOWED_COMMANDS (sleep)
 *     or if the command contains a busy-wait loop.
 *
 *  3. Because a single call is capped at MAX_TIMEOUT_SECONDS, long work runs
 *     as a tracked background job: the bash tool (overridden by this
 *     extension) accepts `background: true`, which detaches the command
 *     (own session, output to a log file) and returns immediately with a
 *     job id, pid, and log path. The extension owns the spawn, so it reaps
 *     the child and knows the exit code — no `$!` parsing, no /proc
 *     guessing by the model.
 *
 *  4. Waiting on jobs (or on external shell conditions) without
 *     busy-waiting:
 *
 *     - wait_for: block (up to the cap) until a job finishes (job: N) or a
 *                 shell condition exits 0 (command).
 *     - alarm:    schedule a later wake-up (timed, job-based, or
 *                 condition-based) so the agent can do other work now and
 *                 be interrupted when it fires.
 *     - jobs:     list tracked background jobs or kill one.
 *
 *     Shell conditions must be one-shot tests (re-run every `interval`
 *     seconds): disallowed commands and busy-wait loops are blocked at
 *     entry, and `pgrep -f` / `pkill -f` patterns are audited for
 *     self-match (the polling shell's own command line contains the
 *     pattern, so the condition can never be true) and multi-match
 *     (ambiguous boolean).
 *
 *  5. Manual backgrounding is blocked and steered to `background: true`:
 *     bare `&` operators, `$!`, and daemon launchers (nohup, disown,
 *     setsid) at command position are rejected with a reason, because
 *     fire-and-forget jobs lose their pid and exit code.
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
/** Per-check timeout in SECONDS — ops.exec expects seconds, not milliseconds. */
const CHECK_TIMEOUT_SEC = 30;

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
  kind: "timed" | "condition" | "job";
  command?: string;
  job?: number;
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
  blocked?: boolean;
  elapsedSec?: number;
  jobExitCode?: number;
}

/** A background job started via the bash tool's `background: true`. */
interface JobEntry {
  id: number;
  pid: number;
  command: string;
  logPath: string;
  startedAt: number;
  exitCode: number | null;
  exitedAt: number | null;
  killTimer?: NodeJS.Timeout;
}

/** Truncate a command for a single-line tool-call display. */
function clipCommand(cmd: string, max = 80): string {
  return cmd.length > max ? `${cmd.slice(0, max - 1)}…` : cmd;
}

/** Extract the patterns of `pgrep -f` / `pkill -f` invocations in a shell command. */
export function extractPgrepPatterns(command: string): string[] {
  const out: string[] = [];
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "pgrep" && tokens[i] !== "pkill") continue;
    let full = false;
    i++;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      if (tokens[i].slice(tokens[i].startsWith("--") ? 2 : 1).includes("f")) full = true;
      i++;
    }
    if (!full || i >= tokens.length) continue;
    let pat = tokens[i];
    if ((pat.startsWith('"') && pat.endsWith('"')) || (pat.startsWith("'") && pat.endsWith("'"))) {
      pat = pat.slice(1, -1);
    }
    if (pat) out.push(pat);
  }
  return out;
}

/**
 * Audits a condition that uses `pgrep -f` / `pkill -f` for the two classic
 * failure modes:
 *   1. self-match — the polling shell runs as `sh -c <command>`, so its own
 *      command line contains the pattern; the condition can never be true.
 *   2. multi-match — the pattern matches several processes, so the boolean
 *      result is ambiguous.
 * Returns an explanation, or null if the condition looks sound.
 */
/** Static part of the audit: does a `pgrep -f` pattern match the polling shell's own command line? */
export function auditPgrepSelfMatch(command: string): string | null {
  for (const p of extractPgrepPatterns(command)) {
    let self: boolean;
    try {
      self = new RegExp(p).test(`sh -c ${command}`);
    } catch {
      self = true; // pattern not parseable as a regex — assume the worst
    }
    if (self) {
      return (
        `unreliable condition: the pattern of \`pgrep -f '${p}'\` self-matches the polling shell — ` +
        `the shell's own command line contains the pattern, so the condition can never be true. ` +
        `Use \`[ ! -d /proc/$PID ]\` or a marker file instead ` +
        `(or a bracket pattern like \`pgrep -f 'cargo[ ]test'\` so the literal text does not match itself).`
      );
    }
  }
  return null;
}

export function auditPgrepCondition(command: string): string | null {
  // 1) Static self-match: test each pattern against the polling shell's command line.
  const selfError = auditPgrepSelfMatch(command);
  if (selfError) return selfError;
  const patterns = extractPgrepPatterns(command);
  if (patterns.length === 0) return null;
  // 2) Runtime multi-match: scan /proc for processes whose command line matches.
  let dirs: string[];
  try {
    dirs = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return null; // not on Linux — skip the runtime check
  }
  const matchesPattern = (cmdline: string) =>
    patterns.some((p) => {
      try {
        return new RegExp(p).test(cmdline);
      } catch {
        return cmdline.includes(p);
      }
    });
  const hits: { pid: string; cmdline: string }[] = [];
  for (const pid of dirs) {
    let raw: Buffer;
    try {
      raw = readFileSync(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    const cmdline = raw.toString("utf8").split("\0").filter(Boolean).join(" ");
    if (!cmdline || cmdline.includes(command)) continue; // skip the polling shell itself
    if (matchesPattern(cmdline)) hits.push({ pid, cmdline });
  }
  if (hits.length > 1) {
    const list = hits.map((h) => `pid ${h.pid} ${clipCommand(h.cmdline, 50)}`).join("; ");
    return (
      `unreliable condition: \`pgrep -f\` matched ${hits.length} processes (${list}) — ` +
      `the boolean result is ambiguous; use a PID check or marker file instead.`
    );
  }
  return null;
}

/**
 * Guards wait_for/alarm conditions: no disallowed commands (sleep) and no
 * busy-wait loops — the condition is already re-run every `interval` seconds,
 * so it must be a one-shot test, not a loop that paces or spins itself.
 */
export function guardWaitCondition(command: string): string | null {
  const hits = [...new Set(extractCommandNames(command).filter((name) => name in DISALLOWED_COMMANDS))];
  if (hits.length > 0) {
    return (
      `"${hits.join('", "')}" in the wait condition — the condition is already re-checked every \`interval\` seconds, ` +
      `so it must be a one-shot test (e.g. \`[ -f done ]\`, \`[ ! -d /proc/$PID ]\`), not a loop that sleeps or paces itself.`
    );
  }
  const busyWaits = findBusyWaitLoops(command);
  if (busyWaits.length > 0) {
    return (
      `busy-wait loop in the wait condition (${busyWaits[0]}) — it spins the CPU; ` +
      `the condition is already re-checked every \`interval\` seconds, make it a one-shot test.`
    );
  }
  return null;
}

/** find options that take a separate value argument. */
const FIND_VALUE_OPTS = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename",
  "-perm", "-user", "-group", "-newer", "-anewer", "-cnewer", "-newerxt", "-newerac",
  "-mmin", "-cmin", "-amin", "-maxdepth", "-mindepth", "-size", "-fstype", "-gid", "-uid",
]);

/**
 * Detects filesystem-root searches: `find /` (or `find /*`) without
 * `-maxdepth 1` scans the entire disk and will run into the bash timeout
 * cap. Returns the offending path list, or null.
 * Token-based like extractPgrepPatterns; `find` only counts at a command
 * position (start of command or after a shell operator).
 */
export function findRootSearch(command: string): string | null {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "find") continue;
    const prev = i > 0 ? tokens[i - 1] : "";
    const atCmdPos =
      prev === "" || ["&&", "||", "|", ";", "&", "(", ")", "`"].includes(prev) || /[;|&)(`]$/.test(prev);
    if (!atCmdPos) continue;
    let j = i + 1;
    let maxDepth1 = false;
    const paths: string[] = [];
    while (j < tokens.length) {
      const a = tokens[j];
      if (/[;|&]/.test(a)) break; // next pipeline element
      if (/^\d*(>>?|<)/.test(a)) {
        // Redirection: `2>/dev/null` (attached) or `> /dev/null` (separate target).
        j++;
        if (/^\d*(>>?|<)$/.test(a)) j++; // skip the separate target
        continue;
      }
      if (a.startsWith("-")) {
        if (a === "-maxdepth" && tokens[j + 1] === "1") maxDepth1 = true;
        j++;
        if (FIND_VALUE_OPTS.has(a)) j++; // skip the option's value
        continue;
      }
      if (["!", "not", "and", "or", "(", ")"].includes(a)) break; // expression started
      paths.push(a);
      j++;
    }
    if (!maxDepth1 && paths.some((p) => p === "/" || p === "/*")) return paths.join(" ");
  }
  return null;
}

export interface BackgroundingFindings {
  /** Context snippets, one per bare `&` background operator found. */
  ops: string[];
  /** True if a `$!` appears outside single quotes. */
  dollarBang: boolean;
}

/**
 * Find shell backgrounding constructs that the bash tool must not use:
 * bare `&` operators and `$!` (pid capture of a job the tool did not
 * launch). Quote-, comment- and here-doc-aware. Not flagged: `&&`, the
 * `&>` / `N>&M` redirections, and `&` inside arithmetic (`$((…))`, `((…))`).
 * A `&` inside a command substitution IS flagged — backgrounding there is
 * always a red flag.
 */
export function findBackgrounding(command: string): BackgroundingFindings {
  const hereDocRanges = findHereDocRanges(command);
  const ops: string[] = [];
  let dollarBang = false;
  let hereDocIdx = 0;
  let mode: "normal" | "single" | "double" = "normal";
  let i = 0;

  const snippet = (at: number) =>
    "…" + command.slice(Math.max(0, at - 20), at + 21).replace(/\n/g, " ⏎ ") + "…";

  while (i < command.length) {
    while (hereDocIdx < hereDocRanges.length && i >= hereDocRanges[hereDocIdx][1]) hereDocIdx++;
    const hd = hereDocRanges[hereDocIdx];
    if (hd && i >= hd[0] && i < hd[1]) {
      i = hd[1];
      continue;
    }

    const c = command[i];
    if (mode === "single") {
      if (c === "'") mode = "normal";
      i++;
      continue;
    }
    if (mode === "double") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        mode = "normal";
        i++;
        continue;
      }
      if (c === "$" && command[i + 1] === "!") dollarBang = true; // "$!" still expands
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
    if (c === "'") {
      mode = "single";
      i++;
      continue;
    }
    if (c === '"') {
      mode = "double";
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
      i = skipArithmetic(command, i + 1);
      continue;
    }
    if (c === "(" && command[i + 1] === "(" && (i === 0 || /[\s;|&(]/.test(command[i - 1]))) {
      i = skipArithmetic(command, i);
      continue;
    }
    if (c === "$" && command[i + 1] === "!") {
      dollarBang = true;
      i += 2;
      continue;
    }
    if (
      c === "&" &&
      command[i + 1] !== "&" && // &&
      command[i - 1] !== "&" && // second half of &&
      command[i + 1] !== ">" && // &> redirection
      command[i - 1] !== ">" && // N>&M / >&M redirection
      !/\d/.test(command[i - 1] ?? "") // 2>&1
    ) {
      ops.push(snippet(i));
    }
    i++;
  }
  return { ops, dollarBang };
}

/** Skip a `(( … ))` arithmetic expression; `start` points at the first `(`. */
function skipArithmetic(command: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < command.length) {
    if (command[i] === "(" && command[i + 1] === "(") {
      depth++;
      i += 2;
      continue;
    }
    if (command[i] === ")" && command[i + 1] === ")") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return command.length;
}

/**
 * Launchers that detach a job from the shell, escaping tracking.
 * Map command name -> explanation shown to the model when blocked.
 */
const DAEMON_LAUNCHERS: Record<string, string> = {
  nohup: "nohup is not needed — background: true already detaches the job and captures its log",
  disown: "disown detaches the job from the shell, escaping tracking",
  setsid: "setsid moves the job to a new session, escaping tracking",
};

/**
 * Find daemon launchers (nohup, disown, setsid) at a command position.
 * Token-based like findRootSearch: quoted names and plain arguments
 * (e.g. `man nohup`) do not count.
 */
export function findDaemonLaunchers(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const hits: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!(t in DAEMON_LAUNCHERS)) continue;
    const prev = i > 0 ? tokens[i - 1] : "";
    const atCmdPos =
      prev === "" || ["&&", "||", "|", ";", "&", "(", ")", "`"].includes(prev) || /[;|&)(`]$/.test(prev);
    if (atCmdPos) hits.push(t);
  }
  return [...new Set(hits)];
}

export default function (pi: ExtensionAPI) {
  const GUARDED_TOOLS = ["bash", "powershell"] as const;

  const ops = createLocalBashOperations();
  const alarms = new Map<string, AlarmEntry>();
  let alarmSeq = 0;

  // ---- background jobs (bash background: true) ----
  const jobs = new Map<number, JobEntry>();
  let jobSeq = 0;

  const SIGNAL_NUMBERS: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGSEGV: 11,
  };

  /**
   * Spawn a command detached (own session, output appended to a log file)
   * and track it. The child is a direct child of this process, so we reap
   * it and know the exit code — no $! parsing or /proc guessing needed.
   * Jobs survive the session ending (nohup semantics).
   */
  const startBackgroundJob = (command: string, cwd: string, killDeadlineSec?: number): JobEntry => {
    const id = ++jobSeq;
    const logPath = join(tmpdir(), `better-bash-job-${id}-${Date.now()}.log`);
    const shellConfig = getShellConfig();
    const out = openSync(logPath, "a");
    const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", out, out],
    });
    closeSync(out);
    const entry: JobEntry = {
      id,
      pid: child.pid ?? -1,
      command,
      logPath,
      startedAt: Date.now(),
      exitCode: null,
      exitedAt: null,
    };
    child.on("exit", (code, signal) => {
      entry.exitCode = code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : null);
      entry.exitedAt = Date.now();
      if (entry.killTimer) clearTimeout(entry.killTimer);
    });
    child.on("error", () => {
      entry.exitCode = entry.exitCode ?? 127;
      entry.exitedAt = Date.now();
    });
    if (killDeadlineSec != null && killDeadlineSec > 0) {
      entry.killTimer = setTimeout(() => {
        killJob(entry);
      }, killDeadlineSec * 1000);
      entry.killTimer.unref?.();
    }
    child.unref();
    jobs.set(id, entry);
    return entry;
  };

  /** Kill a job's whole process tree (it leads its own session). */
  const killJob = (job: JobEntry): void => {
    try {
      if (process.platform !== "win32") process.kill(-job.pid, "SIGTERM");
      else process.kill(job.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };

  const describeJob = (j: JobEntry): string => {
    const now = Date.now();
    const status = j.exitCode == null ? `running (pid ${j.pid})` : `exited ${j.exitCode}`;
    const dur = Math.round(((j.exitedAt ?? now) - j.startedAt) / 1000);
    return `j${j.id}  ${status}  ${dur}s  \`${clipCommand(j.command, 50)}\`  log: ${j.logPath}`;
  };

  /** Last lines of a job log (for non-zero exits), or null. */
  const tailLog = (logPath: string, maxLines = 15, maxChars = 2000): string | null => {
    try {
      const text = readFileSync(logPath, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      const tail = lines.slice(-maxLines).join("\n");
      if (!tail) return null;
      return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
    } catch {
      return null;
    }
  };

  // ---- bash: override the built-in to add `background: true` ----
  const bashMeta = createBashToolDefinition(process.cwd());
  pi.registerTool({
    name: "bash",
    label: bashMeta.label,
    description:
      bashMeta.description +
      " Pass background: true to run a long command as a tracked background job: the call returns immediately with a job id, pid, and log path, and the job keeps running (its timeout becomes a kill deadline, exempt from the cap). Wait on it with wait_for {job: N} or alarm {job: N}; list or kill it with the jobs tool. Do not background commands with &, nohup, or $! — those are blocked.",
    promptSnippet: bashMeta.promptSnippet,
    promptGuidelines: [
      ...(bashMeta.promptGuidelines ?? []),
      "For long-running work (tests, builds, watchers) pass background: true instead of &, nohup, or $! — the tool returns a job id you can pass to wait_for/alarm and a log path to read.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(Type.Number({
        description: `Seconds before the command is killed (max ${MAX_TIMEOUT_SECONDS} for foreground calls; with background: true it becomes the job's kill deadline and may exceed the cap).`,
      })),
      background: Type.Optional(Type.Boolean({
        description: "Run as a tracked background job and return immediately with the job id, pid, and log path. Use for work that may exceed the timeout cap.",
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.background) {
        const entry = startBackgroundJob(params.command, ctx.cwd, params.timeout);
        const lines = [
          `Background job j${entry.id} started.`,
          `pid: ${entry.pid}`,
          `log: ${entry.logPath}`,
          params.timeout ? `kill deadline: ${params.timeout}s` : null,
          `Wait on it with wait_for {job: ${entry.id}} or alarm {job: ${entry.id}}; list or kill it with the jobs tool.`,
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: undefined,
        };
      }
      const builtin = createBashToolDefinition(ctx.cwd);
      return builtin.execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate, ctx);
    },
    renderCall: bashMeta.renderCall,
    renderResult: bashMeta.renderResult,
  });

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
    if (e.kind === "job") {
      return `alarm ${id}: waiting on job j${e.job} (set ${age}s ago)${e.note ? ` — ${e.note}` : ""}`;
    }
    return `alarm ${id}: polling \`${clipCommand(e.command ?? "", 60)}\` every ${e.intervalSec}s${e.repeat ? ", repeats until met" : ""} (set ${age}s ago)${e.note ? ` — ${e.note}` : ""}`;
  };

  // Run a shell condition once and return its exit code (null on error/timeout),
  // plus an auditError if the condition uses an unreliable `pgrep -f` pattern.
  const runCheck = async (
    command: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; auditError?: string }> => {
    // Fail fast on the deterministic self-match before spending the check timeout.
    const selfError = auditPgrepSelfMatch(command);
    if (selfError) return { exitCode: null, auditError: selfError };
    let exitCode: number | null;
    try {
      const r = await ops.exec(command, cwd, { onData: () => {}, signal, timeout: CHECK_TIMEOUT_SEC });
      exitCode = r.exitCode;
    } catch {
      exitCode = null;
    }
    return { exitCode, auditError: auditPgrepCondition(command) ?? undefined };
  };

  // ---- wait_for: block until a job finishes or a shell condition exits 0 ----
  pi.registerTool({
    name: "wait_for",
    label: "Wait For",
    description:
      "Block until a background job finishes (job: N) or a shell condition is met (command) — use to wait for background work instead of busy-waiting. " +
      "Prefer `job` for jobs started via bash background: true — the exit code and log are reported. " +
      "A `command` is a one-shot test re-run every `interval` seconds — no loops or sleep inside it.",
    parameters: Type.Object({
      job: Type.Optional(Type.Number({
        description: "Id of a background job (from a background: true bash call) to wait for. Preferred over shell conditions — the exit code and log path are reported.",
      })),
      command: Type.Optional(Type.String({
        description:
          "Shell command to run as the check; exit code 0 means the condition is met. Provide either `job` or `command`, not both. " +
          "For processes you did not launch via background: true, prefer a robust completion check (e.g. `[ ! -d /proc/$PID ]` " +
          "or a marker file the job writes when done) over `pgrep -f` — the polling shell's own " +
          "command line contains the pattern, so `pgrep -f` self-matches and the condition can never be true (use a bracket pattern like `pgrep -f 'cargo[ ]test'` if you must).",
      })),
      timeout: Type.Optional(Type.Number({ description: `Max seconds to wait (default and max ${MAX_TIMEOUT_SECONDS}).` })),
      interval: Type.Optional(Type.Number({ description: "Seconds between checks (default 2, min 1)." })),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("wait_for "));
      text += theme.fg("accent", args.job != null ? `job j${args.job}` : clipCommand(args.command ?? ""));
      const parts: string[] = [];
      parts.push(`every ${args.interval ?? 2}s`);
      if (args.timeout) parts.push(`timeout: ${args.timeout}s`);
      text += theme.fg("dim", ` (${parts.join(", ")})`);
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
      if (params.job != null && params.command) {
        return {
          content: [{ type: "text", text: "Provide either `job` or `command`, not both." }],
          isError: true,
          details: { met: false, blocked: true },
        };
      }
      if (params.job == null && !params.command) {
        return {
          content: [{ type: "text", text: "Provide `job` (id of a background: true bash job) or `command` (shell condition)." }],
          isError: true,
          details: { met: false, blocked: true },
        };
      }
      const capMs = Math.min(Math.max(1, params.timeout ?? MAX_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) * 1000;
      const intervalMs = Math.max(1, params.interval ?? 2) * 1000;
      const start = Date.now();
      let checks = 0;

      if (params.job != null) {
        const job = jobs.get(params.job);
        if (!job) {
          return {
            content: [{ type: "text", text: `No job with id ${params.job} — use the jobs tool to list tracked jobs.` }],
            isError: true,
            details: { met: false, blocked: true },
          };
        }
        for (;;) {
          if (signal?.aborted) {
            return {
              content: [{ type: "text", text: `Cancelled after ${((Date.now() - start) / 1000).toFixed(1)}s.` }],
              details: { met: false, cancelled: true },
            };
          }
          checks++;
          if (job.exitCode != null) {
            const s = (Date.now() - start) / 1000;
            const ranFor = Math.round((job.exitedAt! - job.startedAt) / 1000);
            const tail = job.exitCode !== 0 ? tailLog(job.logPath) : null;
            return {
              content: [{
                type: "text",
                text:
                  `Job j${job.id} finished with exit code ${job.exitCode} (ran ${ranFor}s). Log: ${job.logPath}` +
                  (tail ? `\n\nLast log lines:\n${tail}` : ""),
              }],
              details: { met: true, elapsedSec: Number(s.toFixed(1)), jobExitCode: job.exitCode },
            };
          }
          if (Date.now() - start >= capMs) {
            return {
              content: [{ type: "text", text: `Timed out after ${capMs / 1000}s — job j${job.id} (pid ${job.pid}) is still running. Log so far: ${job.logPath}` }],
              details: { met: false, timedOut: true },
            };
          }
          onUpdate?.({
            content: [{ type: "text", text: `Waiting… job j${job.id} (pid ${job.pid}) ${((Date.now() - start) / 1000).toFixed(0)}s / ${capMs / 1000}s` }],
            details: { met: false },
          });
          await sleep(intervalMs, signal);
        }
      }

      const guardError = guardWaitCondition(params.command!);
      if (guardError) {
        return {
          content: [{ type: "text", text: `Blocked: ${guardError}` }],
          isError: true,
          details: { met: false, blocked: true },
        };
      }
      for (;;) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: `Cancelled after ${((Date.now() - start) / 1000).toFixed(1)}s.` }],
            details: { met: false, cancelled: true },
          };
        }
        checks++;
        const { exitCode, auditError } = await runCheck(params.command!, ctx.cwd, signal);
        if (auditError) {
          return {
            content: [{ type: "text", text: `Blocked: ${auditError}` }],
            isError: true,
            details: { met: false, blocked: true },
          };
        }
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
      "Schedule a later wake-up — timed (delay), job-based (job: N), or condition (command that exits 0) — so you can do other work and be interrupted when it fires. Pass cancel to remove one, list to see pending alarms, or repeat to keep a condition alarm polling until it is met.",
    parameters: Type.Object({
      delay: Type.Optional(Type.Number({ description: `Seconds until a timed alarm fires (max ${MAX_TIMEOUT_SECONDS}).` })),
      job: Type.Optional(Type.Number({
        description: "Id of a background job (from a background: true bash call) to wake on — fires when the job finishes, reporting its exit code and log path.",
      })),
      command: Type.Optional(Type.String({
        description:
          "Shell condition to poll; exit code 0 fires the alarm. One-shot test re-run every `interval` seconds — no loops or sleep inside. " +
          "Prefer `job` for tracked jobs; for external processes prefer a robust check (e.g. `[ ! -d /proc/$PID ]` or a marker file) over `pgrep -f`, which can match unrelated processes.",
      })),
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
      else if (args.job != null) text += theme.fg("accent", `job j${args.job}`);
      else if (args.command) {
        const parts: string[] = [theme.fg("accent", clipCommand(args.command))];
        parts.push(theme.fg("dim", `every ${args.interval ?? 2}s`));
        if (args.repeat) parts.push(theme.fg("dim", "(repeat)"));
        text += parts.join("");
      }
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
          return { content: [{ type: "text", text: `No pending alarm with id "${params.cancel}".` }], isError: true, details: undefined };
        }
        return { content: [{ type: "text", text: `Cancelled alarm ${params.cancel}.` }], details: { cancelled: true, id: params.cancel } };
      }

      if (params.delay == null && params.job == null && !params.command) {
        return {
          content: [{ type: "text", text: "Provide `delay` (timed), `job` (background job id), or `command` (condition), or `cancel` (id) / `list`." }],
          isError: true,
          details: undefined,
        };
      }

      if (params.job != null && (params.delay != null || params.command)) {
        return {
          content: [{ type: "text", text: "`job` cannot be combined with `delay` or `command`." }],
          isError: true,
          details: undefined,
        };
      }

      if (params.job != null && !jobs.has(params.job)) {
        return {
          content: [{ type: "text", text: `No job with id ${params.job} — use the jobs tool to list tracked jobs.` }],
          isError: true,
          details: undefined,
        };
      }

      const id = `a${++alarmSeq}`;
      const note = params.note?.trim();
      const timed = params.delay != null;
      if (!timed && params.job == null) {
        const guardError = guardWaitCondition(params.command!);
        if (guardError) {
          return { content: [{ type: "text", text: `Blocked: ${guardError}` }], isError: true, details: undefined };
        }
      }
      const entry: AlarmEntry = {
        cancelled: false,
        controller: new AbortController(),
        kind: timed ? "timed" : params.job != null ? "job" : "condition",
        command: params.command,
        job: params.job,
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

      if (params.job != null) {
        const job = jobs.get(params.job)!;
        const intervalMs = entry.intervalSec! * 1000;
        const capMs = Math.min(Math.max(1, params.timeout ?? MAX_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) * 1000;
        const repeat = entry.repeat!;
        const start = Date.now();
        void (async () => {
          while (!entry.cancelled) {
            if (job.exitCode != null) {
              fire(`job j${job.id} finished with exit code ${job.exitCode} — log: ${job.logPath}`);
              return;
            }
            if (!repeat && Date.now() - start >= capMs) {
              fire(`timed out after ${capMs / 1000}s — job j${job.id} (pid ${job.pid}) is still running; log so far: ${job.logPath}`);
              return;
            }
            await sleep(intervalMs, entry.controller.signal);
          }
        })();
        return {
          content: [
            {
              type: "text",
              text: `Scheduled job alarm ${id} (checking job j${job.id} every ${intervalMs / 1000}s${repeat ? ", repeats until it finishes" : `, up to ${capMs / 1000}s`}). You will be woken when it finishes or times out.`,
            },
          ],
          details: { scheduled: true, id, job: params.job },
        };
      }

      const command = entry.command!;
      const intervalMs = entry.intervalSec! * 1000;
      const capMs = Math.min(Math.max(1, params.timeout ?? MAX_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) * 1000;
      const repeat = entry.repeat!;
      void (async () => {
        const start = Date.now();
        while (!entry.cancelled) {
          const { exitCode, auditError } = await runCheck(command, ctx.cwd, entry.controller.signal);
          if (entry.cancelled) return;
          if (auditError) {
            fire(`unreliable condition: ${auditError}`);
            return;
          }
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

  // ---- jobs: list or kill tracked background jobs ----
  const jobsParamsSchema = Type.Object({
    kill: Type.Optional(Type.Number({ description: "Job id to terminate (SIGTERM to its whole process tree) instead of listing." })),
  });
  pi.registerTool<typeof jobsParamsSchema, { killed?: number; jobs?: string[] } | undefined>({
    name: "jobs",
    label: "Jobs",
    description:
      "List tracked background jobs (started via bash background: true) with id, status, pid, runtime, exit code, and log path — or kill one. Check this after launching background work to see what is still running.",
    parameters: jobsParamsSchema,
    async execute(_toolCallId, params) {
      if (params.kill != null) {
        const job = jobs.get(params.kill);
        if (!job) {
          return { content: [{ type: "text", text: `No job with id ${params.kill}.` }], isError: true, details: undefined };
        }
        if (job.exitCode != null) {
          return { content: [{ type: "text", text: `Job j${job.id} already finished (exit ${job.exitCode}). Log: ${job.logPath}` }], details: undefined };
        }
        killJob(job);
        return {
          content: [{ type: "text", text: `Sent SIGTERM to job j${job.id} (pid ${job.pid}).` }],
          details: { killed: job.id },
        };
      }
      const items = [...jobs.values()].sort((a, b) => a.id - b.id).map(describeJob);
      return {
        content: [{ type: "text", text: items.length ? items.join("\n") : "No tracked background jobs." }],
        details: { jobs: items },
      };
    },
  });

  pi.on("session_shutdown", () => {
    for (const id of [...alarms.keys()]) cancelAlarm(id);
  });

  for (const toolName of GUARDED_TOOLS) {
    pi.on("tool_call", (event) => {
      if (!isToolCallEventType(toolName, event)) return;

      const input = event.input as { command?: unknown; timeout?: number; background?: boolean };
      const isBackground = input.background === true;
      const timeout = input.timeout;
      if (!isBackground && (typeof timeout !== "number" || timeout <= 0)) {
        return {
          block: true,
          reason:
            `Blocked: ${toolName} calls must specify a timeout. ` +
            `Re-run the same command with a "timeout" parameter (seconds) appropriate for the work, ` +
            `e.g. timeout: 60 for quick commands, up to ${MAX_TIMEOUT_SECONDS} for long-running ones, ` +
            `or background: true for work that may run longer.`,
        };
      }

      if (isBackground && timeout != null && (typeof timeout !== "number" || timeout <= 0)) {
        return {
          block: true,
          reason: `Blocked: with background: true the "timeout" parameter is the job's kill deadline and must be a positive number of seconds (or omitted).`,
        };
      }

      if (!isBackground && typeof timeout === "number" && timeout > MAX_TIMEOUT_SECONDS) {
        return {
          block: true,
          reason:
            `Blocked: ${toolName} timeout ${timeout}s exceeds the hard cap of ${MAX_TIMEOUT_SECONDS}s. ` +
            `Re-run with timeout <= ${MAX_TIMEOUT_SECONDS}, or split the work into smaller steps, ` +
            `or re-run with background: true — the call returns immediately with a job id, pid, and log path; ` +
            `then use wait_for {job: N} to block until it finishes or alarm {job: N} to be woken later while you do other work.`,
        };
      }

      if (toolName === "bash" && typeof input.command === "string") {
        const commands = extractCommandNames(input.command);
        const hits = [...new Set(commands.filter((name) => name in DISALLOWED_COMMANDS))];
        if (hits.length > 0) {
          const details = hits.map((name) => `"${name}" — ${DISALLOWED_COMMANDS[name]}`).join("; ");
          return {
            block: true,
            reason: `Blocked: disallowed command(s) in bash call: ${details}. Re-run without them.`,
          };
        }

        const busyWaits = findBusyWaitLoops(input.command);
        if (busyWaits.length > 0) {
          return {
            block: true,
            reason:
              `Blocked: busy-wait loop detected (${busyWaits[0]}) — it spins the CPU while waiting. ` +
              `Use wait_for to block until the condition is met, or alarm to be woken later while you do other work.`,
          };
        }

        const rootFind = findRootSearch(input.command);
        if (rootFind) {
          return {
            block: true,
            reason:
              `Blocked: filesystem-root search (find ${rootFind}) — scanning the entire disk takes minutes ` +
              `and will hit the ${MAX_TIMEOUT_SECONDS}s timeout cap. Scope the search to the directories you ` +
              `actually mean (a project dir, $HOME, /tmp, …), or use fd/locate if available. ` +
              `\`find / -maxdepth 1\` is allowed.`,
          };
        }

        const bg = findBackgrounding(input.command);
        if (bg.ops.length > 0) {
          return {
            block: true,
            reason:
              `Blocked: background operator & (${bg.ops[0]}) — fire-and-forget jobs lose their pid and exit code. ` +
              `Re-run with the background: true parameter instead: it returns a job id, pid, and log path, ` +
              `and wait_for {job: N} / alarm {job: N} / jobs track it for you. ` +
              `If you need several commands in parallel, make one background: true call per command.`,
          };
        }
        if (bg.dollarBang) {
          return {
            block: true,
            reason:
              `Blocked: $! — you cannot capture the pid of a job the tool did not launch. ` +
              `Re-run with the background: true parameter, which returns the pid directly.`,
          };
        }

        const daemons = findDaemonLaunchers(input.command);
        if (daemons.length > 0) {
          return {
            block: true,
            reason:
              `Blocked: ${daemons.map((name) => `"${name}" — ${DAEMON_LAUNCHERS[name]}`).join("; ")}. ` +
              `Re-run with the background: true parameter, which detaches the job and tracks it for you.`,
          };
        }
      }
    });
  }
}
