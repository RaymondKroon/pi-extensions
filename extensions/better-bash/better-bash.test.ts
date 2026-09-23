import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import {
  auditPgrepCondition,
  auditPgrepSelfMatch,
  extractCommandNames,
  extractPgrepPatterns,
  findBackgrounding,
  findBusyWaitLoops,
  findDaemonLaunchers,
  findRootSearch,
  guardWaitCondition,
} from "./index.ts";

describe("extractCommandNames", () => {
  test("simple command", () => {
    expect(extractCommandNames("ls -la")).toEqual(["ls"]);
  });

  test("pipeline and lists", () => {
    expect(extractCommandNames("ls | grep foo; rm -rf x")).toEqual(["ls", "grep", "rm"]);
  });

  test("command substitution and subshells", () => {
    expect(extractCommandNames("echo $(rm x) && (cat y)")).toEqual(["echo", "rm", "cat"]);
  });

  test("wrappers resolve to the wrapped command", () => {
    expect(extractCommandNames("sudo rm x")).toEqual(["rm"]);
    expect(extractCommandNames("env FOO=bar sleep 1")).toEqual(["sleep"]);
  });

  test("timeout wrapper skips its duration argument", () => {
    expect(extractCommandNames("timeout 5 sleep 1")).toEqual(["sleep"]);
  });

  test("quoted strings are not command positions", () => {
    expect(extractCommandNames('echo "sudo rm -rf /"')).toEqual(["echo"]);
    expect(extractCommandNames("echo 'sleep 5'")).toEqual(["echo"]);
  });

  test("comments are ignored", () => {
    expect(extractCommandNames("ls # sleep 5")).toEqual(["ls"]);
  });

  test("here-doc bodies are not parsed as commands", () => {
    expect(extractCommandNames("cat <<EOF\nsleep 5\nrm -rf /\nEOF\nls")).toEqual(["cat", "ls"]);
  });
});

describe("findBusyWaitLoops", () => {
  test("flags no-op while loops", () => {
    expect(findBusyWaitLoops("while :; do :; done").length).toBeGreaterThan(0);
    expect(findBusyWaitLoops("while true; do true; done").length).toBeGreaterThan(0);
  });

  test("allows loops with real work in the body", () => {
    expect(findBusyWaitLoops("while pgrep -f x >/dev/null; do sleep 5; done")).toEqual([]);
    expect(findBusyWaitLoops("for f in *.ts; do echo $f; done")).toEqual([]);
  });

  test("ignores loop keywords used as plain arguments", () => {
    expect(findBusyWaitLoops("echo while until for")).toEqual([]);
  });

  test("regression: bare ) must not spin the parser (9097c30)", () => {
    const cases = [
      "python3 -c \"print('(&[')\"",
      "cat <<'EOF'\nline.strip().startswith('(&[')\nEOF",
      "for x in ); do :; done",
      "a ) b",
      "echo 'Some(' | grep )",
    ];
    for (const c of cases) {
      const start = Date.now();
      expect(() => findBusyWaitLoops(c)).not.toThrow();
      expect(Date.now() - start).toBeLessThan(1000);
    }
  });

  test("fuzz: paren/quote/substitution soup never hangs or throws", () => {
    const parts = ["(", ")", "$(", "`", "'", '"', ";", "|", "&", "while", "do", "done", "echo", "x", "EOF", "<<"];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const start = Date.now();
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rand() * 12);
      const cmd = Array.from({ length: n }, () => parts[Math.floor(rand() * parts.length)]).join(" ");
      expect(() => findBusyWaitLoops(cmd)).not.toThrow();
      expect(() => extractCommandNames(cmd)).not.toThrow();
    }
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("extractPgrepPatterns", () => {
  test("standalone -f with quoted pattern", () => {
    expect(extractPgrepPatterns('! pgrep -f "cargo test"')).toEqual(["cargo test"]);
  });

  test("combined flags (-af) are detected", () => {
    expect(extractPgrepPatterns("pgrep -af 'zzjo[b]1'")).toEqual(["zzjo[b]1"]);
  });

  test("pkill and unquoted patterns", () => {
    expect(extractPgrepPatterns("pkill -f foo")).toEqual(["foo"]);
  });

  test("no -f flag means no pattern", () => {
    expect(extractPgrepPatterns("pgrep -x foo")).toEqual([]);
    expect(extractPgrepPatterns("pgrep -f")).toEqual([]);
  });

  test("pgrep as a plain argument is ignored", () => {
    expect(extractPgrepPatterns("grep -q pgrep /var/log/x")).toEqual([]);
  });
});

describe("auditPgrepSelfMatch", () => {
  test("flags patterns that match the polling shell's own command line", () => {
    expect(auditPgrepSelfMatch('! pgrep -f "cargo test"')).not.toBeNull();
    expect(auditPgrepSelfMatch('[ ! -d /proc/284062 ] && ! pgrep -f "cargo test|test-tee"')).not.toBeNull();
  });

  test("bracket trick does not self-match", () => {
    expect(auditPgrepSelfMatch("pgrep -f 'cargo[ ]test'")).toBeNull();
  });

  test("non-pgrep conditions pass", () => {
    expect(auditPgrepSelfMatch("[ ! -d /proc/123 ]")).toBeNull();
    expect(auditPgrepSelfMatch('grep -q "test result:" /tmp/x.log')).toBeNull();
  });
});

describe("auditPgrepCondition (multi-match)", () => {
  const isLinux = (() => {
    try {
      readdirSync("/proc");
      return true;
    } catch {
      return false;
    }
  })();

  const decoys: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const d of decoys.splice(0)) {
      try {
        d.kill("SIGKILL");
      } catch {}
    }
  });

  const spawnDecoy = (marker: string) => {
    const p = spawn("/bin/bash", ["-c", `exec -a ${marker} sleep 30`], { stdio: "ignore" });
    decoys.push(p);
    return p;
  };

  test.skipIf(!isLinux)("errors when the pattern matches multiple processes", async () => {
    const marker = `bbmm${Date.now()}x`;
    spawnDecoy(marker);
    spawnDecoy(marker);
    await new Promise((r) => setTimeout(r, 200));
    // Bracket pattern: matches the decoys but not its own condition text.
    const bracket = marker.slice(0, 3) + `[${marker[3]}]` + marker.slice(4);
    const result = auditPgrepCondition(`pgrep -af "${bracket}"`);
    expect(result).not.toBeNull();
    expect(result).toContain("matched");
  });

  test.skipIf(!isLinux)("passes when nothing matches", async () => {
    const marker = `bbmn${Date.now()}y`;
    const bracket = marker.slice(0, 3) + `[${marker[3]}]` + marker.slice(4);
    expect(auditPgrepCondition(`pgrep -af "${bracket}"`)).toBeNull();
  });
});

describe("guardWaitCondition", () => {
  test("blocks sleep inside the condition", () => {
    expect(guardWaitCondition("while kill -0 $(pgrep -f difftest.py) 2>/dev/null; do sleep 5; done")).not.toBeNull();
    expect(guardWaitCondition("sleep 5 && [ -f /tmp/done ]")).not.toBeNull();
  });

  test("blocks busy-wait loops", () => {
    expect(guardWaitCondition("while :; do :; done")).not.toBeNull();
  });

  test("allows one-shot tests", () => {
    expect(guardWaitCondition("[ -f /tmp/done ]")).toBeNull();
    expect(guardWaitCondition("[ ! -d /proc/123 ]")).toBeNull();
    expect(guardWaitCondition('grep -q "test result:" /tmp/x.log')).toBeNull();
  });

  test("quoted disallowed commands are not flagged", () => {
    expect(guardWaitCondition('grep -q "sleep" /var/log/x')).toBeNull();
  });
});

describe("findBackgrounding", () => {
  test("flags bare & operators", () => {
    expect(findBackgrounding("nohup cargo test > /tmp/x.log 2>&1 & echo $!").ops.length).toBe(1);
    expect(findBackgrounding("a & b & wait").ops.length).toBe(2);
    expect(findBackgrounding("cmd &\nnext").ops.length).toBe(1);
    expect(findBackgrounding("cmd&").ops.length).toBe(1);
  });

  test("allows && and redirections", () => {
    expect(findBackgrounding("ls && grep x").ops).toEqual([]);
    expect(findBackgrounding("cmd &> /tmp/all.log").ops).toEqual([]);
    expect(findBackgrounding("cmd 2>&1 | tee x").ops).toEqual([]);
    expect(findBackgrounding("cmd >&2").ops).toEqual([]);
    expect(findBackgrounding("cmd 2>>&1").ops).toEqual([]);
  });

  test("ignores arithmetic &", () => {
    expect(findBackgrounding("echo $((3 & 5))").ops).toEqual([]);
    expect(findBackgrounding("if (( mask & 0x2 )); then echo y; fi").ops).toEqual([]);
    expect(findBackgrounding("x=$((a & b)) && echo $x").ops).toEqual([]);
  });

  test("ignores quoted and commented &", () => {
    expect(findBackgrounding('echo "a & b"').ops).toEqual([]);
    expect(findBackgrounding("echo 'a & b'").ops).toEqual([]);
    expect(findBackgrounding("ls # & nohup").ops).toEqual([]);
  });

  test("ignores here-doc bodies but not the opener line", () => {
    expect(findBackgrounding("cat <<EOF\nnohup x &\nEOF").ops).toEqual([]);
    expect(findBackgrounding("cat <<EOF &\nbody\nEOF").ops.length).toBe(1);
  });

  test("flags & inside command substitution", () => {
    expect(findBackgrounding("x=$(nohup y &)").ops.length).toBe(1);
  });

  test("detects $! except in single quotes", () => {
    expect(findBackgrounding("echo $!").dollarBang).toBe(true);
    expect(findBackgrounding('echo "$!"').dollarBang).toBe(true);
    expect(findBackgrounding("echo '$!'").dollarBang).toBe(false);
    expect(findBackgrounding("echo dollar-bang").dollarBang).toBe(false);
  });

  test("fuzz: quote/paren/& soup never throws or hangs", () => {
    const parts = ["&", "&&", "&>", "2>&1", "$((", "((", "))", "'", '"', "$()", "#", "echo", "x", "<<EOF", "EOF"];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const start = Date.now();
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rand() * 10);
      const cmd = Array.from({ length: n }, () => parts[Math.floor(rand() * parts.length)]).join(" ");
      expect(() => findBackgrounding(cmd)).not.toThrow();
    }
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("findDaemonLaunchers", () => {
  test("flags launchers at command position", () => {
    expect(findDaemonLaunchers("nohup cargo test > /tmp/x.log 2>&1 &")).toEqual(["nohup"]);
    expect(findDaemonLaunchers("setsid longrun &")).toEqual(["setsid"]);
    expect(findDaemonLaunchers("a; disown")).toEqual(["disown"]);
  });

  test("ignores names as arguments or in quotes", () => {
    expect(findDaemonLaunchers("man nohup")).toEqual([]);
    expect(findDaemonLaunchers('echo "nohup"')).toEqual([]);
    expect(findDaemonLaunchers("ls nohup")).toEqual([]);
  });
});

describe("findRootSearch", () => {
  test("blocks filesystem-root searches", () => {
    expect(findRootSearch("find / -name effect_scattered.py")).toBe("/");
    expect(findRootSearch("find / -name x -not -path '*/target/*' 2>/dev/null | head")).toBe("/");
    expect(findRootSearch("find /* -name x")).toBe("/*");
    expect(findRootSearch("ls /x || find / -name x")).toBe("/");
  });

  test("allows scoped searches and -maxdepth 1", () => {
    expect(findRootSearch("find /home/raymond -name x")).toBeNull();
    expect(findRootSearch("find / -maxdepth 1 -name x")).toBeNull();
    expect(findRootSearch("find /etc /var -name x")).toBeNull();
  });

  test("ignores find as a plain argument", () => {
    expect(findRootSearch("echo find /")).toBeNull();
    expect(findRootSearch("grep find /var/log/x")).toBeNull();
  });
});
