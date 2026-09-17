import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

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
    "restructure the work or poll for completion instead",
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

export default function (pi: ExtensionAPI) {
  const GUARDED_TOOLS = ["bash", "powershell"] as const;

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
            `or run it in the background (e.g. nohup ... &) and poll for completion.`,
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
      }
    });
  }
}
