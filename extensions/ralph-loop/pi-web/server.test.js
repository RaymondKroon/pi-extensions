// Focused tests for the pi-web ralph backend's state auto-creation (the TUI
// parity: /ralph's home view creates an empty backlog at the session ralph
// file when none exists, so the view is usable from the start).
//
// The provider is exercised directly with a temp agent directory
// (PI_CODING_AGENT_DIR), so no real ~/.pi state is touched.

import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import plugin from "./server.js";

const SESSION_ID = "019f0000-0000-7000-8000-000000000001";

let agentDir;
let projectPath;
let provider;

const project = () => ({ id: "test-project", name: "test", path: projectPath });

const request = (operation, input) => provider.request({ project: project(), operation, input, signal: undefined });

beforeAll(async () => {
	agentDir = join(await mkTemp("ralph-server-agent-"), "agent");
	projectPath = join(await mkTemp("ralph-server-project-"), "proj");
	await mkdir(agentDir, { recursive: true });
	await mkdir(projectPath, { recursive: true });
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	const context = {
		logger: { error: () => {}, warn: () => {} },
		execFile: async () => {
			throw new Error("git is not used by these tests");
		},
	};
	provider = (await plugin.activate(context)).workspaceProvider;
});

afterAll(async () => {
	delete process.env["PI_CODING_AGENT_DIR"];
	await rm(agentDir, { recursive: true, force: true });
	await rm(dirnameOf(projectPath), { recursive: true, force: true });
});

async function mkTemp(prefix) {
	return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function dirnameOf(path) {
	const index = path.lastIndexOf("/");
	return path.slice(0, index);
}

// The session directory pi creates for a cwd (mirrors the server's encoding).
function sessionDirFor(cwd) {
	const safe = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
	return join(agentDir, "sessions", safe);
}

describe("probe claim", () => {
	test("passes when the project has no session directory and no config entry", async () => {
		expect(await provider.probe(project(), undefined)).toBe("pass");
	});

	test("claims when a pi session directory exists for the project (even empty)", async () => {
		await mkdir(sessionDirFor(projectPath), { recursive: true });
		expect(await provider.probe(project(), undefined)).toBe("claim");
	});

	test("claims when the config store has a dirs entry for the project", async () => {
		const other = join(projectPath, "other");
		await mkdir(join(agentDir, "ralph"), { recursive: true });
		await Bun.write(join(agentDir, "ralph", "config.json"), JSON.stringify({ dirs: { [other]: { main: {} } } }));
		// No session directory for `other` — the config entry alone claims.
		expect(await provider.probe({ id: "p2", name: "other", path: other }, undefined)).toBe("claim");
	});
});

describe("init op (TUI-style auto-creation)", () => {
	test("creates an empty backlog at the session ralph file", async () => {
		const result = await request("init", { sessionId: SESSION_ID });
		const expected = join(agentDir, "ralph", `${SESSION_ID}.db`);
		expect(result.path).toBe(expected);
		expect(result.created).toBe(true);
		expect((await stat(expected)).isFile()).toBe(true);
		expect(result.tasks).toEqual([]);
		expect(result.goal).toBeNull();
	});

	test("is idempotent and leaves an existing backlog untouched", async () => {
		await request("task.add", { path: join(agentDir, "ralph", `${SESSION_ID}.db`), title: "ZZZ TEST - safe to delete" });
		const result = await request("init", { sessionId: SESSION_ID });
		expect(result.created).toBe(false);
		expect(result.tasks.map((task) => task.title)).toEqual(["ZZZ TEST - safe to delete"]);
	});

	test("rejects an invalid sessionId", async () => {
		await expect(request("init", { sessionId: "../evil" })).rejects.toThrow("invalid sessionId");
	});
});

describe("status op", () => {
	test("rejects a session with no ralph state at all", async () => {
		await expect(request("status", { sessionId: "019f0000-0000-7000-8000-000000000002" })).rejects.toThrow(
			"no ralph state for session 019f0000-0000-7000-8000-000000000002",
		);
	});

	test("reports a session with a backlog but no loop state as state:null + todoPath", async () => {
		const result = await request("status", { sessionId: SESSION_ID });
		expect(result.session.sessionId).toBe(SESSION_ID);
		expect(result.session.state).toBeNull();
		expect(result.session.todoPath).toBe(join(agentDir, "ralph", `${SESSION_ID}.db`));
	});
});

describe("summary op (chat strip status)", () => {
	const SUMMARY_SESSION = "019f0000-0000-7000-8000-000000000003";
	const dbPath = () => join(agentDir, "ralph", `${SUMMARY_SESSION}.db`);

	// Write a pi session file with a persisted ralph loop state (the same
	// custom-entry format listRalphSessions reads).
	async function writeLoopState(data) {
		const dir = sessionDirFor(projectPath);
		await mkdir(dir, { recursive: true });
		const line = JSON.stringify({ type: "custom", customType: "ralph-loop-state", data });
		await Bun.write(join(dir, `test_${SUMMARY_SESSION}.jsonl`), `${line}\n`);
	}

	test("rejects an invalid sessionId", async () => {
		await expect(request("summary", { sessionId: "../evil" })).rejects.toThrow("invalid sessionId");
	});

	test("rejects a session with no ralph state at all", async () => {
		await expect(request("summary", { sessionId: "019f0000-0000-7000-8000-000000000004" })).rejects.toThrow(
			"no ralph state for session 019f0000-0000-7000-8000-000000000004",
		);
	});

	test("reports a running loop's state without a task counter", async () => {
		await request("init", { sessionId: SUMMARY_SESSION });
		await request("task.add", { path: dbPath(), title: "ZZZ first task - safe to delete" });
		await request("task.add", { path: dbPath(), title: "ZZZ second task - safe to delete" });
		await writeLoopState({
			enabled: true,
			mode: "auto",
			iteration: 1,
			maxIterations: 50,
			cycleOn: "budget",
			contextThreshold: 0.7,
			todoPath: dbPath(),
		});
		const result = await request("summary", { sessionId: SUMMARY_SESSION });
		expect(result.state.enabled).toBe(true);
		expect(result.state.mode).toBe("auto");
		expect(result.state.iteration).toBe(1);
		// The TUI's task counter is deliberately not part of the web status.
		expect(result.taskCount).toBeUndefined();
		expect(result.goalState).toBeUndefined();
		expect(result.config).toBeNull();
	});

	test("reports goalState and the derived baselinePhase for a goal loop", async () => {
		await request("goal.set", { path: dbPath(), body: "ZZZ test goal - safe to delete" });
		await writeLoopState({
			enabled: true,
			mode: "goal",
			iteration: 1,
			maxIterations: 30,
			cycleOn: "budget",
			contextThreshold: 0.7,
			baseline: { ralph: true, phase: "planning" },
			todoPath: dbPath(),
		});
		const result = await request("summary", { sessionId: SUMMARY_SESSION });
		expect(result.state.baselinePhase).toBe("planning");
		expect(result.goalState).toBe("open");
	});

	test("omits baselinePhase outside a goal loop with a ralph baseline", async () => {
		await writeLoopState({
			enabled: true,
			mode: "auto",
			iteration: 1,
			maxIterations: 50,
			cycleOn: "budget",
			contextThreshold: 0.7,
			baseline: { ralph: true, phase: "planning" },
			todoPath: dbPath(),
		});
		const result = await request("summary", { sessionId: SUMMARY_SESSION });
		expect(result.state.baselinePhase).toBeUndefined();
	});

	test("reports a session with a backlog but no loop state as state:null", async () => {
		const result = await request("summary", { sessionId: SESSION_ID });
		expect(result.state).toBeNull();
		expect(result.goalState).toBeUndefined();
		expect(result.config).toBeNull();
	});

	test("reports the resolved config from the global defaults", async () => {
		await Bun.write(
			join(agentDir, "ralph", "config.json"),
			JSON.stringify({
				defaults: {
					autoMode: "on",
					autoApproveDecisions: false,
					maxIterations: 50,
					compactionMode: false,
					cycleOn: { auto: "budget", tasks: "task", goal: "budget" },
					contextThresholds: { __default__: 0.7 },
				},
			}),
		);
		const result = await request("summary", { sessionId: SESSION_ID });
		expect(result.config).toEqual({
			autoMode: "on",
			autoApproveDecisions: false,
			maxIterations: 50,
			compactionMode: false,
			cycleOn: { auto: "budget", tasks: "task", goal: "budget" },
			contextThresholds: { __default__: 0.7 },
		});
	});
});
