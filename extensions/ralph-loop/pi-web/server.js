// PI WEB server entry for the Ralph panel.
//
// Runs in the session daemon (Node). Reuses the ralph-loop pi extension's own
// logic instead of re-implementing it:
//   - Backlog class + formatters from the pi-extensions checkout
//     (the same code the /ralph TUI uses)
//   - ralph's persisted loop state and config, read from the same places the
//     extension writes them:
//       * session entries  { type: "custom", customType: "ralph-loop-state" | "ralph-loop-config" }
//       * global config store  <agentDir>/ralph/config.json
//       * backlogs        <agentDir>/ralph/<sessionId>.db (or a user path)
//
// The provider claims a project when ralph state exists for it (a config
// store entry) or a pi session was ever started in it (the session directory
// exists) — anywhere the user can type /ralph in the TUI, the panel can
// manage (and auto-create) ralph state. When it claims, it mirrors the
// bundled Git provider's workspace listing so the project's workspaces look
// exactly as before.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RALPH_STATE_TYPE = "ralph-loop-state";
const RALPH_CONFIG_TYPE = "ralph-loop-config";
const RALPH_DIR_NAME = "ralph"; // ralph-loop's AUTO_TODO_DIR
const CONFIG_STORE_NAME = "config.json";
const DEFAULT_BRANCH_KEY = "default";
const DEFAULT_MODEL_CONFIG_KEY = "__default__";
const MAX_BACKLOG_BYTES = 50 * 1024 * 1024;

const GIT_LOCAL_ENV_VARS = Object.freeze([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_WORK_TREE",
]);

function agentDir() {
	const configured = process.env["PI_CODING_AGENT_DIR"];
	return configured ? resolve(configured) : join(homedir(), ".pi", "agent");
}

/** Encode cwd into pi's session directory name (mirrors pi's session manager). */
function sessionDirForCwd(cwd) {
	const resolved = resolve(cwd);
	const safePath = `--${resolved.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
	return join(agentDir(), "sessions", safePath);
}

/**
 * Locate the ralph-loop package directory. Prefers the source registered in
 * the agent settings (pi install records it there); falls back to the
 * conventional git checkout location.
 */
async function ralphLoopDir() {
	const settingsPath = join(agentDir(), "settings.json");
	try {
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		const packages = Array.isArray(settings?.packages) ? settings.packages : [];
		for (const source of packages) {
			if (typeof source !== "string" || !source.includes("ralph-loop")) continue;
			const candidate = resolve(agentDir(), source);
			if (existsSync(join(candidate, "backlog.ts"))) return candidate;
		}
	}
	catch {
		// settings missing or unreadable: fall through to the conventional path
	}
	const fallback = join(agentDir(), "git/github.com/RaymondKroon/pi-extensions/extensions/ralph-loop");
	if (existsSync(join(fallback, "backlog.ts"))) return fallback;
	return undefined;
}

const plugin = {
	apiVersion: 1,
	name: "Ralph",
	async activate(context) {
		let ralph;
		try {
			// Bundled with the ralph-loop package: backlog.ts sits one level up.
			try {
				ralph = await import(new URL("../backlog.ts", import.meta.url).href);
			}
			catch {
				// Standalone copy (not colocated): resolve the installed package.
				const dir = await ralphLoopDir();
				if (dir === undefined) {
					throw new Error("ralph-loop package not found (expected in the agent directory; install it with `pi install`)");
				}
				ralph = await import(pathToFileURL(join(dir, "backlog.ts")).href);
			}
		}
		catch (error) {
			// Without the ralph-loop module the panel cannot show data; fail
			// activation loudly instead of serving a broken provider.
			context.logger.error(`ralph panel unavailable: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		return { workspaceProvider: createProvider(context, ralph) };
	},
};

export default plugin;

// --- mutation input helpers --------------------------------------------------

function reqStr(input, key) {
	const value = input?.[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`missing ${key}`);
	return value;
}

function optStr(input, key) {
	const value = input?.[key];
	return typeof value === "string" ? value : undefined;
}

function reqNum(input, key) {
	const value = input?.[key];
	if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`invalid ${key}`);
	return value;
}

function reqDirection(input) {
	const direction = input?.direction;
	if (direction !== "up" && direction !== "down") throw new Error("direction must be up or down");
	return direction;
}

function taskChanges(input) {
	const changes = {};
	if (typeof input?.title === "string") changes.title = input.title;
	if (input?.body !== undefined) changes.body = typeof input.body === "string" ? input.body : null;
	if (input?.category !== undefined) changes.category = typeof input.category === "string" ? input.category : null;
	return changes;
}

/** Today's date as YYYY-MM-DD (local time), for completion log entries. */
function todayDate() {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Move a task by id within the view scope the browser is showing. `scope` is
 * the category name, or undefined for the "all" (global) view; the task's
 * position number is resolved within that scope, matching the TUI.
 */
function moveById(backlog, id, direction, scope) {
	const number = backlog.taskNumbers(scope).get(id);
	if (!number) throw new Error(`no task ${id} in this list`);
	backlog.moveTask(number, direction, 1, scope);
}

/** Toggle a task done/open by id and record the reason as a completion log entry. */
function setDoneWithLog(backlog, id, done, reason, scope) {
	const number = backlog.taskNumbers(scope).get(id);
	if (!number) throw new Error(`no task ${id} in this list`);
	backlog.setDoneById(id, done);
	backlog.addLogEntry({ task: number, date: todayDate(), note: reason, kind: done ? "done" : "reopen" }, scope);
}

function createProvider(context, ralph) {
	const { Backlog, formatBacklog } = ralph;

	// The full backlog snapshot the browser renders from (read and mutation
	// responses share it so a mutation returns the fresh state to re-render).
	const snapshot = (backlog) => ({
		counts: backlog.counts(),
		categories: backlog.categories(),
		createdLists: backlog.createdLists(),
		sources: backlog.sources(),
		goal: backlog.goal() ?? null,
		tasks: backlog.listTasks(),
		log: backlog.listLogEntries(),
		// Per-category task numbering, exactly as the TUI scopes it
		// (taskNumbers(category): task id -> 1-based position).
		taskNumbers: Object.fromEntries([
			...[...backlog.categories()].map((category) => [
				category,
				Object.fromEntries(backlog.taskNumbers(category).entries()),
			]),
			// Uncategorized tasks: position within the uncategorized
			// subset (listTasks(null) would match nothing in SQLite).
			[
				"",
				Object.fromEntries(
					backlog
						.listTasks()
						.filter((task) => task.category === null)
						.map((task, index) => [task.id, String(index + 1)]),
				),
			],
		]),
		// The exact text the /ralph TUI renders (kept for parity/debugging).
		rendered: formatBacklog(backlog),
	});

	// Resolve + validate the backlog path from a request input and open it.
	const openAt = async (input) => {
		const rawPath = typeof input?.path === "string" ? input.path : "";
		if (rawPath === "") throw new Error("missing backlog path");
		const path = resolve(rawPath);
		const info = await stat(path).catch(() => undefined);
		if (info === undefined) throw new Error(`backlog file not found: ${path}`);
		if (!info.isFile()) throw new Error(`not a file: ${path}`);
		if (info.size > MAX_BACKLOG_BYTES) throw new Error("backlog file too large");
		let backlog;
		try {
			backlog = Backlog.open(path);
		}
		catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}
		return { path, backlog };
	};

	// The session's ralph state: from the session file (persisted loop state)
	// or from the session ralph file alone (a backlog without loop state).
	const findSession = async (projectPath, sessionId) => {
		const sessions = await listRalphSessions(projectPath);
		let session = sessions.find((candidate) => candidate.sessionId === sessionId);
		if (session === undefined) {
			// No loop state persisted in the session file yet, but the
			// session may have a ralph backlog (created by the TUI's
			// /ralph home view or the panel's init): report it with a
			// null state so the panel can show the home view.
			const dbPath = join(agentDir(), RALPH_DIR_NAME, `${sessionId}.db`);
			if (existsSync(dbPath)) {
				const info = await stat(dbPath).catch(() => undefined);
				session = { sessionId, updatedAt: info?.mtimeMs ?? null, state: null, todoPath: dbPath };
			}
		}
		return session;
	};

	// Apply a mutation, persist it, and return the fresh snapshot. The same
	// open -> mutate -> save discipline the /ralph TUI uses; save() is atomic.
	const mutate = async (input, fn) => {
		const { path, backlog } = await openAt(input);
		fn(backlog);
		backlog.save(path);
		return { path, ...snapshot(backlog) };
	};

	/**
	 * Create the session's ralph backlog file when it does not exist yet —
	 * the same auto-creation the /ralph TUI's home view performs ("No backlog
	 * yet: create an empty one at the session ralph file"). Idempotent: an
	 * existing backlog is opened and returned untouched.
	 */
	const initSessionBacklog = (sessionId) => {
		const path = join(agentDir(), RALPH_DIR_NAME, `${sessionId}.db`);
		const created = !existsSync(path);
		if (created) Backlog.empty().save(path);
		return { path, created, ...snapshot(Backlog.open(path)) };
	};

	return Object.freeze({
	async probe(project, signal) {
		try {
			if (signal?.aborted === true) throw new Error("probe aborted");
			const store = await readConfigStore();
			if (store?.dirs?.[project.path] !== undefined && store?.dirs?.[project.path] !== null) return "claim";
			// A pi session was started in this directory (pi creates the session
			// directory when the session starts, even before its first message is
			// persisted): the user can use /ralph there, so the panel can manage
			// — and auto-create, like the TUI — ralph state for it.
			return existsSync(sessionDirForCwd(project.path)) ? "claim" : "pass";
		}
		catch (error) {
			context.logger.warn(`ralph probe failed for ${project.path}: ${error instanceof Error ? error.message : String(error)}`);
			return "pass";
		}
	},
		async list(project, signal) {
			// Mirror the bundled Git provider's listing for git projects so a
			// claimed project's workspaces are unchanged; non-git projects are
			// exposed as a single workspace.
			const inside = await runGit(context, project.path, ["rev-parse", "--is-inside-work-tree"], signal);
			if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
				return [singleWorkspace(project)];
			}
			const rootResult = await requireGit(runGit(context, project.path, ["rev-parse", "--show-toplevel"], signal), "resolve the Git worktree root");
			const mainRootOutput = rootResult.stdout.trim();
			if (mainRootOutput === "") throw new Error("Git returned an empty worktree root");
			const mainRoot = resolve(mainRootOutput);
			const commonDirectoryResult = await requireGit(runGit(context, project.path, ["rev-parse", "--git-common-dir"], signal), "resolve the Git common directory");
			const commonDirectoryOutput = commonDirectoryResult.stdout.trim();
			if (commonDirectoryOutput === "") throw new Error("Git returned an empty common directory");
			const commonDirectory = resolve(project.path, commonDirectoryOutput);
			const listResult = await requireGit(runGit(context, project.path, ["worktree", "list", "--porcelain", "-z"], signal), "list Git worktrees");
			const worktrees = parseGitWorktreeList(listResult.stdout)
				.filter((worktree) => worktree.bare !== true)
				.map((worktree) => {
					const path = resolve(worktree.path);
					return { worktree: { ...worktree, path }, path };
				});
			const mainWorkspacePath = worktrees.some(({ path }) => path === mainRoot) ? mainRoot : commonDirectory;
			const selectable = worktrees
				.map(({ worktree, path }) => ({ worktree, path, isMain: path === mainWorkspacePath }))
				.filter(({ worktree, path, isMain }) => worktree.prunable !== true || isMain || path === project.path);
			if (selectable.length === 0) return [singleWorkspace(project)];
			const workspaces = selectable.map(({ worktree, path, isMain }) => {
				const label = worktree.branch ?? (worktree.detached === true ? "detached" : basename(worktree.path) || worktree.path);
				return {
					key: path,
					path,
					label,
					isMain,
					data: { worktreePath: worktree.path, ...(worktree.branch === undefined ? {} : { branch: worktree.branch }) },
					publicMetadata: {
						isGitRepo: true,
						isGitWorktree: true,
						...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
						...(worktree.detached === undefined ? {} : { detached: worktree.detached }),
					},
					...(isMain ? {} : { removal: removalPresentation(label, path) }),
				};
			});
			// The project's own directory may not be a worktree (a subdirectory of
			// the repository): pi sessions started there are keyed by that cwd, so
			// expose it as a workspace too or they are invisible in the UI. No
			// removal presentation: it is not a worktree that can be removed.
			if (!workspaces.some((workspace) => workspace.path === project.path)) {
				const label = basename(project.path) || project.path;
				workspaces.push({
					key: project.path,
					path: project.path,
					label,
					isMain: false,
					data: { worktreePath: project.path },
					publicMetadata: { isGitRepo: true, isProjectDirectory: true },
				});
			}
			return workspaces;
		},
		async request(requestContext) {
			const { project, operation, input } = requestContext;
			switch (operation) {
				case "sessions":
					return listRalphSessions(project.path);
				case "status": {
					const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
					if (!/^[0-9a-f][0-9a-f-]{0,64}$/iu.test(sessionId)) throw new Error("invalid sessionId");
					const session = await findSession(project.path, sessionId);
					if (session === undefined) throw new Error(`no ralph state for session ${sessionId}`);
					const config = await configForDir(context, project.path);
					// Both sources, so the panel's config form can re-display the
					// rows when the user switches "Save to" (like the TUI).
					const sources = await configSources(context, project.path);
					return { session, config, sources };
				}
				case "summary": {
					// The loop status for the chat strip and the panel's Loop card:
					// the persisted loop state (plus the derived baselinePhase,
					// which the TUI computes from state.baseline), the resolved
					// config, and the backlog's goal state. The TUI's task counter
					// is deliberately not included: the next-open-task position is
					// not a reliable indicator of which task the agent is working
					// on, so the web does not show it. The context percentage and
					// model come from the pi-web session status (the browser fetches
					// them itself). The proxy requires JSON-only results, so
					// optional fields are omitted instead of set to undefined.
					const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
					if (!/^[0-9a-f][0-9a-f-]{0,64}$/iu.test(sessionId)) throw new Error("invalid sessionId");
					const session = await findSession(project.path, sessionId);
					if (session === undefined) throw new Error(`no ralph state for session ${sessionId}`);
					const state = session.state;
					const config = (await configForDir(context, project.path)).config;
					// The persisted state is JSON (session custom entry), so it is
					// proxy-safe as is; add the derived goal phase the TUI's
					// baselineGoalPhase computes (no file access).
					const baselinePhase = state?.mode === "goal" && state?.baseline?.ralph ? state.baseline.phase : undefined;
					const result = {
						state: state === null || state === undefined ? null : baselinePhase === undefined ? state : { ...state, baselinePhase },
						config: config ?? null,
					};
					// todoPath is persisted inside the loop state (the state:null
					// case has no loop, hence no goal state either).
					if (state?.enabled === true && typeof state.todoPath === "string") {
						try {
							const { backlog } = await openAt({ path: state.todoPath });
							const goal = backlog.goal();
							if (typeof goal?.status === "string") result.goalState = goal.status;
						} catch {
							// Unreadable backlog: the strip shows without the goal state.
						}
					}
					return result;
				}
				case "init": {
					const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
					if (!/^[0-9a-f][0-9a-f-]{0,64}$/iu.test(sessionId)) throw new Error("invalid sessionId");
					return initSessionBacklog(sessionId);
				}
				case "backlog": {
					const { path, backlog } = await openAt(input);
					return { path, ...snapshot(backlog) };
				}
				case "task.add":
					return mutate(input, (b) =>
						b.addTask({ title: reqStr(input, "title"), body: optStr(input, "body"), category: optStr(input, "category") }),
					);
				case "task.update":
					return mutate(input, (b) => b.updateTaskById(reqNum(input, "id"), taskChanges(input)));
				case "task.delete":
					return mutate(input, (b) => b.deleteTaskById(reqNum(input, "id")));
				case "task.move":
					return mutate(input, (b) => moveById(b, reqNum(input, "id"), reqDirection(input), optStr(input, "category")));
				case "task.set-done":
					return mutate(input, (b) => setDoneWithLog(b, reqNum(input, "id"), input.done === true, reqStr(input, "reason"), optStr(input, "category")));
				case "list.rename":
					return mutate(input, (b) => b.renameCategory(reqStr(input, "oldName"), reqStr(input, "newName")));
				case "list.create":
					return mutate(input, (b) => b.createList(reqStr(input, "name")));
				case "goal.set":
					return mutate(input, (b) => b.setGoal(reqStr(input, "body")));
				case "goal.delete":
					return mutate(input, (b) => b.deleteGoal());
				case "config":
					return configForDir(context, project.path);
				case "config.set":
					return setConfig(context, project.path, input);
				default:
					throw new Error(`unknown operation: ${String(operation)}`);
			}
		},
		async prepareRemove({ project, workspace, signal }) {
			const data = workspace.data;
			if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("workspace removal data is unavailable");
			const worktreePath = Reflect.get(data, "worktreePath");
			if (typeof worktreePath !== "string" || worktreePath === "" || resolve(worktreePath) !== workspace.path) {
				throw new Error("workspace removal data no longer matches the current workspace path");
			}
			const listResult = await requireGit(runGit(context, project.path, ["worktree", "list", "--porcelain", "-z"], signal), "validate the Git worktree before removal");
			const current = parseGitWorktreeList(listResult.stdout).find((worktree) => resolve(worktree.path) === workspace.path);
			if (current === undefined || current.prunable === true) throw new Error("Git worktree is no longer available for removal");
			if (current.bare === true) throw new Error("A bare Git workspace cannot be removed as a linked worktree");
			return {
				title: `Delete workspace: ${workspace.label}`,
				command: `git worktree remove ${shellQuote(workspace.path)}`,
			};
		},
	});
}

// --- ralph state readers -----------------------------------------------------

async function readConfigStore() {
	try {
		return JSON.parse(await readFile(join(agentDir(), RALPH_DIR_NAME, CONFIG_STORE_NAME), "utf8"));
	}
	catch {
		return {};
	}
}

async function gitBranch(context, cwd) {
	try {
		const result = await runGit(context, cwd, ["branch", "--show-current"], new AbortController().signal);
		if (result.exitCode !== 0) return undefined;
		const branch = result.stdout.trim();
		return branch.length > 0 ? branch : undefined;
	}
	catch {
		return undefined;
	}
}

/**
 * The config store's two sources for a directory: the directory's own entry
 * (per branch in git repositories) and the global defaults section. Either
 * may be null when the store has no such setting.
 */
async function configSources(context, cwd) {
	const store = await readConfigStore();
	const dir = store?.dirs?.[cwd];
	let dirConfig = null;
	let branch = null;
	if (isPlainObject(dir)) {
		branch = (await gitBranch(context, cwd)) ?? DEFAULT_BRANCH_KEY;
		const candidate = dir[branch] ?? dir[DEFAULT_BRANCH_KEY];
		if (isPlainObject(candidate)) dirConfig = candidate;
	}
	const defaultsConfig = isPlainObject(store?.defaults) ? store.defaults : null;
	return { dir: dirConfig, defaults: defaultsConfig, branch };
}

async function configForDir(context, cwd) {
	const { dir, defaults, branch } = await configSources(context, cwd);
	if (dir !== null) return { config: dir, branch, source: "dir" };
	if (defaults !== null) return { config: defaults, branch: null, source: "defaults" };
	return { config: null, branch: null, source: null };
}

// --- config writes (mirroring ralph-loop's persistConfig / persistConfigDefaults) ---

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContextThreshold(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 1;
}

function isCycleOn(value) {
	return isPlainObject(value) && ["tasks", "goal", "auto"].every((mode) => value[mode] === "task" || value[mode] === "budget");
}

/** Validate a full Ralph config (mirrors ralph-loop's isRalphConfig). */
function validateConfig(value) {
	if (!isPlainObject(value)) throw new Error("invalid config object");
	if (!isPlainObject(value.contextThresholds) || !Object.values(value.contextThresholds).every(isContextThreshold)) {
		throw new Error("invalid contextThresholds (per-model numbers between 10% and 100%)");
	}
	if (typeof value.autoApproveDecisions !== "boolean") throw new Error("invalid autoApproveDecisions");
	if (typeof value.maxIterations !== "number" || !Number.isInteger(value.maxIterations) || value.maxIterations < 1) {
		throw new Error("invalid maxIterations (positive whole number)");
	}
	if (typeof value.compactionMode !== "boolean") throw new Error("invalid compactionMode");
	if (value.autoMode !== "off" && value.autoMode !== "on") throw new Error("invalid autoMode");
	if (!isCycleOn(value.cycleOn)) throw new Error("invalid cycleOn (tasks/goal/auto must be task or budget)");
	return value;
}

/**
 * Read the global config store, refusing to continue on a corrupt store so a
 * write can never clobber the other directories' settings.
 */
async function readConfigStoreRaw() {
	const path = join(agentDir(), RALPH_DIR_NAME, CONFIG_STORE_NAME);
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	}
	catch (error) {
		if (error instanceof Error && error.code === "ENOENT") return {};
		throw error;
	}
	if (!isPlainObject(parsed)) throw new Error("unrecognized configuration store format");
	if (parsed.defaults !== undefined && !isPlainObject(parsed.defaults)) throw new Error("unrecognized configuration store format");
	if (parsed.dirs !== undefined && !isPlainObject(parsed.dirs)) throw new Error("unrecognized configuration store format");
	return parsed;
}

async function writeConfigStore(store) {
	const path = join(agentDir(), RALPH_DIR_NAME, CONFIG_STORE_NAME);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(store, null, "\t")}\n`, "utf8");
}

/**
 * Save a full Ralph config to the global store: the directory's entry (per
 * branch in git repositories) or the global defaults section. Returns the
 * fresh resolved config for the directory.
 */
async function setConfig(context, cwd, input) {
	const scope = input?.scope;
	if (scope !== "directory" && scope !== "defaults") throw new Error("scope must be directory or defaults");
	const config = validateConfig(input.config);
	const store = await readConfigStoreRaw();
	if (scope === "defaults") {
		store.defaults = { ...config };
	}
	else {
		const branchKey = (await gitBranch(context, cwd)) ?? DEFAULT_BRANCH_KEY;
		const dir = store.dirs?.[cwd];
		store.dirs = { ...(store.dirs ?? {}), [cwd]: { ...(isPlainObject(dir) ? dir : {}), [branchKey]: { ...config } } };
	}
	await writeConfigStore(store);
	return configForDir(context, cwd);
}

/**
 * Scan the project's session directory for ralph state. Returns one record
 * per session that ever persisted ralph state, newest first, each carrying
 * the latest state and config entries from that session file.
 */
async function listRalphSessions(projectPath) {
	const dir = sessionDirForCwd(projectPath);
	if (!existsSync(dir)) return [];
	const stateMarker = `"customType":"${RALPH_STATE_TYPE}"`;
	const configMarker = `"customType":"${RALPH_CONFIG_TYPE}"`;
	const modelMarker = `"type":"model_change"`;
	const records = [];
	for (const entry of await readdir(dir)) {
		if (!entry.endsWith(".jsonl")) continue;
		const file = join(dir, entry);
		let text;
		try {
			text = await readFile(file, "utf8");
		}
		catch {
			continue;
		}
		if (!text.includes(stateMarker)) continue;
		let state;
		let config;
		// The session's current model (the last model_change entry), as the
		// "provider/modelId" key ralph-loop uses for per-model context
		// thresholds — the same key the TUI's modelConfigKey builds.
		let modelKey;
		for (const line of text.split("\n")) {
			if (!line.includes(stateMarker) && !line.includes(configMarker) && !line.includes(modelMarker)) continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			}
			catch {
				continue;
			}
			if (parsed?.type === "model_change" && typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
				modelKey = `${parsed.provider}/${parsed.modelId}`;
				continue;
			}
			if (parsed?.type !== "custom" || typeof parsed.data !== "object" || parsed.data === null) continue;
			if (parsed.customType === RALPH_STATE_TYPE) state = parsed.data;
			else if (parsed.customType === RALPH_CONFIG_TYPE) config = parsed.data;
		}
		if (state === undefined) continue;
		const match = /_([0-9a-f-]+)\.jsonl$/iu.exec(entry);
		const info = await stat(file).catch(() => undefined);
		records.push({
			sessionId: match?.[1] ?? entry,
			updatedAt: info?.mtimeMs ?? null,
			state,
			...(modelKey === undefined ? {} : { modelKey }),
			...(config === undefined ? {} : { config }),
		});
	}
	return records.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// --- git helpers (mirroring the bundled Git provider) -------------------------

function singleWorkspace(project) {
	return {
		key: project.path,
		path: project.path,
		label: project.name,
		isMain: true,
		publicMetadata: { isRalphProject: true },
	};
}

function removalPresentation(label, path) {
	return {
		actionLabel: "Delete workspace",
		confirmation: `Delete workspace ${label}?\n\nThis will run git worktree remove and delete:\n${path}\n\nThe Git branch will not be deleted.`,
	};
}

/** Parse `git worktree list --porcelain -z` without path quoting or space loss. */
function parseGitWorktreeList(stdout) {
	return stdout.split("\0\0").flatMap((record) => {
		if (record === "") return [];
		const info = { path: "" };
		for (const field of record.split("\0")) {
			const separator = field.indexOf(" ");
			const key = separator === -1 ? field : field.slice(0, separator);
			const value = separator === -1 ? "" : field.slice(separator + 1);
			if (key === "worktree") info.path = value;
			else if (key === "branch") info.branch = value.replace(/^refs\/heads\//u, "");
			else if (key === "bare") info.bare = true;
			else if (key === "detached") info.detached = true;
			else if (key === "prunable") info.prunable = true;
		}
		return info.path === "" ? [] : [info];
	});
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runGit(context, cwd, args, signal) {
	return context.execFile({
		file: "git",
		args: ["-C", cwd, ...args],
		unsetEnv: GIT_LOCAL_ENV_VARS,
		signal,
	});
}

async function requireGit(resultPromise, action) {
	const result = await resultPromise;
	if (result.signal === null && result.exitCode === 0) return result;
	const detail = result.stderr.trim();
	const outcome = result.signal === null ? `exit ${String(result.exitCode)}` : `signal ${result.signal}`;
	throw new Error(`Unable to ${action} (${outcome})${detail === "" ? "" : `: ${detail}`}`);
}
