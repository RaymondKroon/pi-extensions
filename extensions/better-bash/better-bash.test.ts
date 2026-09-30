import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import betterBash from "./index.ts";
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

const integrationSessionDirs: string[] = [];
const integrationProcessGroups: number[] = [];

afterEach(() => {
  for (const pid of integrationProcessGroups.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  for (const dir of integrationSessionDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createJobHarness(sessionId: string, sessionDir: string) {
  const tools = new Map<string, any>();
  const api = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  betterBash(api);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
    },
  };
  return {
    async call(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} was not registered`);
      return tool.execute("integration-test", params, undefined, undefined, ctx);
    },
  };
}

function createSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "better-bash-session-"));
  integrationSessionDirs.push(dir);
  return dir;
}

function registryFile(sessionDir: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(sessionDir, "better-bash-jobs", `${safeId}.json`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function resultText(result: any): string {
  return result.content?.find((item: any) => item.type === "text")?.text ?? "";
}

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

describe("background-job recovery integration", () => {
  test("a fresh extension instance lists and waits for a live job", async () => {
    const sessionDir = createSessionDir();
    const sessionId = "resume-live-job";
    const first = createJobHarness(sessionId, sessionDir);
    const started = await first.call("bash", {
      command: `node -e 'console.log("recovered-output"); setTimeout(() => {}, 1500)'`,
      background: true,
    });
    const pid = Number(resultText(started).match(/pid: (\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    integrationProcessGroups.push(pid);

    const invalidJob = await first.call("jobs", { kill: 0 });
    expect(resultText(invalidJob)).toContain("No persisted record for job j0 in this session.");
    expect(resultText(invalidJob)).toContain("Current active jobs are: 1.");

    const resumed = createJobHarness(sessionId, sessionDir);
    const listing = await resumed.call("jobs", {});
    expect(resultText(listing)).toContain("j1  running");
    expect(resultText(listing)).toContain(`pid ${pid}`);

    const waited = await resumed.call("wait_for", { job: 1, timeout: 8, interval: 1 });
    expect(resultText(waited)).toContain("Job j1 finished with exit code 0");
    expect(waited.details).toMatchObject({ met: true, jobExitCode: 0 });

    const next = await resumed.call("bash", {
      command: `node -e 'setTimeout(() => {}, 10000)'`,
      background: true,
    });
    expect(resultText(next)).toContain("Background job j2 started.");
    const nextPid = Number(resultText(next).match(/pid: (\d+)/)?.[1]);
    expect(nextPid).toBeGreaterThan(0);
    integrationProcessGroups.push(nextPid);
  }, 15_000);

  test("a process that exited while pi was offline is recovered with unknown exit code", async () => {
    const sessionDir = createSessionDir();
    const sessionId = "resume-offline-exit";
    const first = createJobHarness(sessionId, sessionDir);
    const started = await first.call("bash", { command: "node -e 'process.exit(9)'", background: true });
    const pid = Number(resultText(started).match(/pid: (\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    integrationProcessGroups.push(pid);

    const filePath = registryFile(sessionDir, sessionId);
    await waitUntil(() => {
      try {
        const registry = JSON.parse(readFileSync(filePath, "utf8"));
        return registry.jobs[0]?.exitCode === 9;
      } catch {
        return false;
      }
    });
    const registry = JSON.parse(readFileSync(filePath, "utf8"));
    registry.jobs[0].exitCode = null;
    registry.jobs[0].exitedAt = null;
    writeFileSync(filePath, JSON.stringify(registry));

    const resumed = createJobHarness(sessionId, sessionDir);
    const listing = await resumed.call("jobs", {});
    expect(resultText(listing)).toContain("j1  exited (exit code unavailable)");
    const waited = await resumed.call("wait_for", { job: 1, timeout: 1, interval: 1 });
    expect(resultText(waited)).toContain("process ended while pi was offline; exit code unavailable");
    expect(waited.details).toMatchObject({ met: true });
    expect(waited.details).not.toHaveProperty("jobExitCode");
  }, 10_000);

  test.skipIf(process.platform !== "linux")("boot ID and start-token mismatches prevent signaling a reused PID", async () => {
    const sessionDir = createSessionDir();
    const sessionId = "resume-reused-pid";
    const readyPath = join(sessionDir, "decoy-ready");
    const signaledPath = join(sessionDir, "decoy-signaled");
    const script = [
      `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
      `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(signaledPath)}, 'signaled'))`,
      "setTimeout(() => {}, 30000)",
    ].join(";");
    const decoy = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    const pid = decoy.pid!;
    integrationProcessGroups.push(pid);
    await waitUntil(() => existsSync(readyPath));

    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const actualStartToken = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const baseRecord = {
      pid,
      command: "original tracked process",
      logPath: join(sessionDir, "job.log"),
      startedAt: Date.now() - 1000,
      exitCode: null,
      exitedAt: null,
    };
    const filePath = registryFile(sessionDir, sessionId);
    mkdirSync(join(sessionDir, "better-bash-jobs"), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      nextId: 3,
      jobs: [
        { ...baseRecord, id: 1, processBootId: bootId, processStartToken: "stale-process-start-token" },
        { ...baseRecord, id: 2, processBootId: "stale-boot-id", processStartToken: actualStartToken },
        { ...baseRecord, id: 3, processStartToken: actualStartToken },
      ],
    }));

    const resumed = createJobHarness(sessionId, sessionDir);
    const listing = await resumed.call("jobs", {});
    expect(resultText(listing)).toContain("j1  exited (exit code unavailable)");
    expect(resultText(listing)).toContain("j2  exited (exit code unavailable)");
    expect(resultText(listing)).toContain(`j3  unknown (pid ${pid} not verified)`);
    for (const id of [1, 2]) {
      const killed = await resumed.call("jobs", { kill: id });
      expect(resultText(killed)).toContain("process is gone (exit code unavailable)");
    }
    const legacyKill = await resumed.call("jobs", { kill: 3 });
    expect(resultText(legacyKill)).toContain("cannot be safely verified after reload");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(signaledPath)).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 10_000);

  test("restored kill deadline is armed and session IDs are isolated", async () => {
    const sessionDir = createSessionDir();
    const first = createJobHarness("deadline-session", sessionDir);
    const started = await first.call("bash", {
      command: `node -e 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 30000)'`,
      background: true,
      timeout: 60,
    });
    const pid = Number(resultText(started).match(/pid: (\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    integrationProcessGroups.push(pid);

    const filePath = registryFile(sessionDir, "deadline-session");
    const registry = JSON.parse(readFileSync(filePath, "utf8"));
    registry.jobs[0].killDeadlineAt = Date.now() + 500;
    writeFileSync(filePath, JSON.stringify(registry));

    const resumed = createJobHarness("deadline-session", sessionDir);
    expect(resultText(await resumed.call("jobs", {}))).toContain("j1  running");
    const waited = await resumed.call("wait_for", { job: 1, timeout: 5, interval: 1 });
    expect(resultText(waited)).toMatch(/Job j1 (finished with exit code 0|process ended while pi was offline)/);
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });

    const isolated = createJobHarness("other-session", sessionDir);
    expect(resultText(await isolated.call("jobs", {}))).toContain("No recoverable background jobs");
    const otherStarted = await isolated.call("bash", {
      command: `node -e 'setTimeout(() => {}, 10000)'`,
      background: true,
    });
    const otherPid = Number(resultText(otherStarted).match(/pid: (\d+)/)?.[1]);
    expect(otherPid).toBeGreaterThan(0);
    integrationProcessGroups.push(otherPid);
    expect(resultText(await isolated.call("jobs", {}))).toContain("j1  running");
    expect(resultText(await resumed.call("jobs", {}))).toContain("j1  exited");
  }, 15_000);
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
