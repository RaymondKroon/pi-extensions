// PI WEB browser entry for the Ralph panel.
//
// A web interface that mirrors the /ralph TUI: the loop status, the goal, and
// the interactive backlog (tasks per list, completion log, and every mutation
// the TUI offers — add/edit/delete/move tasks, done/reopen with a reason,
// rename/create lists, add/edit/delete the goal). All data and mutations go
// through the paired server entry, which reuses ralph-loop's own Backlog logic.
//
// Starting/stopping the loop is an agent action (it needs a live pi session),
// so the play/stop buttons stage the exact `/ralph start …` / `/ralph stop`
// command in the prompt editor (focused) — press Enter to run it in the
// session, exactly as typing it in the terminal would.

import { modelKeyOf, tuiStatusText } from "./status-text.js";

const panelTagName = "pi-web-ralph-panel";
const REFRESH_INTERVAL_MS = 10_000;
// ralph-loop's per-model context threshold key for the model without its own entry.
const DEFAULT_MODEL_CONFIG_KEY = "__default__";

const plugin = {
	apiVersion: 2,
	name: "Ralph",
	activate({ html, svg, runtimePluginId }) {
		if (!customElements.get(panelTagName)) {
			customElements.define(panelTagName, PiWebRalphPanel);
		}
		startChatStatusStrip();
		return {
			contributions: {
				actions: [
					{
						id: "workspace.open-ralph",
						title: "Open Ralph panel",
						description: "Show and edit the Ralph loop state, goal, and backlog.",
						group: "Workspace",
						enabled: (context) => context.state.selectedWorkspace !== undefined,
						run: (context) => {
							if (context.state.selectedWorkspace === undefined) return;
							context.selectWorkspaceTool(`${runtimePluginId}:workspace.ralph`);
						},
					},
				],
				workspacePanels: [
					{
						id: "workspace.ralph",
						title: "Ralph",
						icon: svg`
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
								<polyline points="21 3 21 9 15 9"></polyline>
							</svg>
						`,
						order: 60,
						render: (context) => html`<pi-web-ralph-panel .context=${context}></pi-web-ralph-panel>`,
					},
				],
			},
		};
	},
};

export default plugin;

// --- Chat status strip (around the prompt editor) ---------------------------
//
// pi-web has NO chat-area plugin hook (the registry has exactly five
// contribution types: actions, workspacePanels, workspaceLabels, themes,
// themePairs), so the compact loop status is injected as a small line
// directly below the prompt editor. The strip is ALWAYS attached — the
// prompt editor exists in every main view (chat and the workspace-panel
// views), and the user wants the status visible in all of them. It is
// (re)attached by a MutationObserver whenever the app re-renders, and
// polls the plugin backend proxy itself — the Ralph panel (the other data
// source) may be closed.

const STRIP_CLASS = "ralph-chat-status-strip";
const STRIP_POLL_MS = 10_000;

let stripElement = null;
let stripShadowObserver = null;
let stripTimer = null;
let stripRevision = undefined;
// The workspaces' paths per project (the session status endpoint resolves
// the session per cwd; the workspaces list rarely changes, so cache it).
const workspacePathCache = new Map();

/** The chat context from the app URL (?project=&workspace=&session=). */
function chatContextFromUrl() {
	const params = new URLSearchParams(location.search);
	const project = params.get("project");
	const workspace = params.get("workspace");
	const session = params.get("session");
	if (project === null || workspace === null || session === null) return null;
	return { project, workspace, session };
}

function createStripElement() {
	const strip = document.createElement("div");
	strip.className = STRIP_CLASS;
	// flex:none is essential: the chat message list is a shrinkable flex
	// item with a huge content height, so without it the strip absorbs the
	// flex shrink and collapses to ~0px. The font matches the app's
	// status-bar token meter (12px). white-space:normal lets the line wrap
	// to multiple lines (each ' · ' segment stays intact, see renderStrip).
	strip.style.cssText =
		"display:none;flex:none;padding:2px 12px 0;font-size:12px;opacity:0.75;white-space:normal;";
	return strip;
}

/** The prompt editor (inside pi-web-app's shadow root). The app reuses one
 * <main> across the chat and workspace-panel views (swapping its class),
 * and the prompt editor exists in all of them — the strip stays attached. */
function findPromptEditor() {
	const app = document.querySelector("pi-web-app");
	const main = app?.shadowRoot?.querySelector("main");
	return main?.querySelector("prompt-editor") ?? null;
}

/** Attach the strip below the prompt editor in every view. */
function syncStripAttachment() {
	const prompt = findPromptEditor();
	if (prompt === null) {
		if (stripElement !== null) {
			stripElement.remove();
			stripElement = null;
		}
		return;
	}
	if (stripElement === null || stripElement.parentElement !== prompt.parentElement) {
		if (stripElement === null) stripElement = createStripElement();
		prompt.parentElement.insertBefore(stripElement, prompt.nextSibling);
	}
}

/**
 * Render the status line (or hide the strip). The text is split on ' · ' and
 * each segment is a white-space:nowrap span, so the strip wraps to multiple
 * lines at segment boundaries when it does not fit the width — the TUI's
 * wrapStatusSegments behavior (segments stay intact, the bar grows instead of
 * truncating).
 */
function renderStrip(text) {
	if (stripElement === null) return;
	if (text === undefined) {
		stripElement.style.display = "none";
		stripElement.replaceChildren();
		stripElement.title = "";
		return;
	}
	stripElement.style.display = "block";
	stripElement.title = text;
	stripElement.replaceChildren();
	for (const [index, segment] of text.split(" · ").entries()) {
		if (index > 0) stripElement.append(document.createTextNode(" · "));
		const span = document.createElement("span");
		span.style.whiteSpace = "nowrap";
		span.textContent = segment;
		stripElement.append(span);
	}
}

async function fetchActiveRevision() {
	const response = await fetch("/api/plugins");
	if (!response.ok) throw new Error("failed to load the plugin list");
	const data = await response.json();
	const ralph = (data.plugins ?? []).find((entry) => entry.id === "ralph");
	const revision = ralph?.server?.activeRevision;
	if (typeof revision !== "string" || revision === "") throw new Error("ralph backend revision unavailable");
	return revision;
}

async function fetchWorkspacePath(projectId, workspaceId) {
	const byProject = workspacePathCache.get(projectId);
	if (byProject?.has(workspaceId)) return byProject.get(workspaceId);
	const response = await fetch(`/api/projects/${projectId}/workspaces`);
	if (!response.ok) throw new Error("failed to load the project workspaces");
	const data = await response.json();
	const paths = byProject ?? new Map();
	for (const workspace of data.workspaces ?? []) {
		if (typeof workspace?.path === "string") paths.set(workspace.id, workspace.path);
	}
	workspacePathCache.set(projectId, paths);
	return paths.get(workspaceId);
}

/**
 * The session's context usage and active model from the pi-web session
 * status — the same data the TUI reads via ctx.getContextUsage() / ctx.model.
 * Returns null when the session is unknown to pi-web.
 */
async function fetchSessionContext(sessionId, cwd) {
	const params = new URLSearchParams();
	if (cwd !== undefined) params.set("cwd", cwd);
	const response = await fetch(`/api/machines/local/sessions/${sessionId}/status?${params.toString()}`);
	if (!response.ok) return null;
	const data = await response.json();
	return {
		contextPercent: typeof data?.contextUsage?.percent === "number" ? data.contextUsage.percent : null,
		modelKey: modelKeyOf(data?.model),
	};
}

async function refreshStrip() {
	const context = chatContextFromUrl();
	if (context === null) {
		renderStrip(undefined);
		return;
	}
	try {
		if (stripRevision === undefined) stripRevision = await fetchActiveRevision();
		const response = await fetch(
			`/api/plugin-backends/ralph/projects/${context.project}/workspaces/${context.workspace}/summary`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ revision: stripRevision, input: { sessionId: context.session } }),
			},
		);
		if (!response.ok) {
			// Stale revision: refetch it on the next tick. Not owned / no ralph
			// state for this session: nothing to show.
			stripRevision = undefined;
			if (response.status !== 502 && response.status !== 504) renderStrip(undefined);
			return;
		}
		const summary = await response.json();
		// The context percentage and the active model come from the pi-web
		// session status, resolved per the workspace's path (the session
		// status endpoint keys sessions by cwd). Unknown context renders the
		// TUI's "calculating…" form, like the TUI before its first usage.
		let contextPercent = null;
		let modelKey = modelKeyOf(undefined);
		try {
			const cwd = await fetchWorkspacePath(context.project, context.workspace);
			if (cwd !== undefined) {
				const session = await fetchSessionContext(context.session, cwd);
				if (session !== null) {
					contextPercent = session.contextPercent;
					modelKey = session.modelKey;
				}
			}
		} catch {
			// Transient: keep the calculating form.
		}
		renderStrip(
			tuiStatusText({
				state: summary.state,
				config: summary.config,
				goalState: summary.goalState,
				contextPercent,
				modelKey,
			}),
		);
	} catch {
		// Transient error: keep the last known status on screen.
	}
}

function startChatStatusStrip() {
	if (stripTimer !== null) return;
	const tick = () => {
		// Shadow-root mutations do not cross into the light DOM, so observe
		// the app's shadow root separately once it exists.
		const app = document.querySelector("pi-web-app");
		if (app?.shadowRoot !== null && stripShadowObserver === null) {
			stripShadowObserver = new MutationObserver(() => syncStripAttachment());
			stripShadowObserver.observe(app.shadowRoot, { childList: true, subtree: true });
		}
		syncStripAttachment();
		void refreshStrip();
	};
	tick();
	stripTimer = setInterval(tick, STRIP_POLL_MS);
}

class PiWebRalphPanel extends HTMLElement {
	contextValue;
	scanToken = 0;
	refreshTimer = null;
	noticeTimer = null;
	// null = the "(all)" view; otherwise a category name (the TUI's list scope).
	viewCategory = null;
	expandedTaskIds = new Set();
	data;
	error;
	loading = false;
	root;
	body;
	toolbar;
	notice;
	modalRoot;

	constructor() {
		super();
		this.root = this.attachShadow({ mode: "open" });
		this.root.innerHTML = `
			<style>${styles()}</style>
			<div class="toolbar" hidden>
				<span class="title">Ralph</span>
				<span class="spacer"></span>
				<span class="updated"></span>
				<button class="refresh" title="Refresh">refresh</button>
			</div>
			<div class="notice" hidden></div>
			<div class="body"><div class="empty">Select a workspace.</div></div>
			<div class="modal-root" hidden></div>
		`;
		this.body = this.root.querySelector(".body");
		this.toolbar = this.root.querySelector(".toolbar");
		this.notice = this.root.querySelector(".notice");
		this.modalRoot = this.root.querySelector(".modal-root");
		this.root.querySelector(".refresh").addEventListener("click", () => this.reload());
		this.root.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !this.modalRoot.hidden) this.closeModal();
		});
	}

	get context() {
		return this.contextValue;
	}

	set context(value) {
		// pi-web re-renders the panel (with a fresh context object) on every
		// state update; only react when the actual workspace changed.
		const previousKey = this.contextValue === undefined ? undefined : contextKey(this.contextValue);
		this.contextValue = value;
		if (previousKey === contextKey(value)) return;
		this.viewCategory = null;
		this.expandedTaskIds = new Set();
		void this.reload();
	}

	connectedCallback() {
		this.refreshTimer = setInterval(() => {
			if (this.context?.workspace !== undefined) void this.reload();
		}, REFRESH_INTERVAL_MS);
	}

	disconnectedCallback() {
		if (this.refreshTimer !== null) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.noticeTimer !== null) {
			clearTimeout(this.noticeTimer);
			this.noticeTimer = null;
		}
	}

	// --- data ------------------------------------------------------------------

	async reload() {
		const token = ++this.scanToken;
		const context = this.contextValue;
		if (context?.workspace === undefined) {
			this.renderEmpty("Select a workspace.");
			return;
		}
		if (context.backend === undefined) {
			this.renderEmpty("No Ralph state found in this project (start a loop with /ralph start).");
			return;
		}
		this.loading = true;
		// Quiet refresh: keep the current view while re-fetching.
		if (this.data === undefined) this.renderSkeleton("Loading…");
		try {
			// The panel is linked to the session the user is in the pi-web UI
			// (pi-web's session id is pi's sessionId, the same id in the ralph
			// session file name): only that session's ralph state is shown.
			const currentId = context.state?.selectedSession?.id;
			if (typeof currentId !== "string" || currentId === "") {
				this.renderEmpty("No session selected in this workspace.");
				return;
			}
			let status;
			try {
				status = await context.backend.request("status", { sessionId: currentId });
			}
			catch (error) {
				// No ralph state for this session yet: create the empty backlog
				// at the session ralph file — the same auto-creation the /ralph
				// TUI's home view performs — and retry.
				if (!isNoRalphStateError(error)) throw error;
				await context.backend.request("init", { sessionId: currentId });
				if (token !== this.scanToken) return;
				status = await context.backend.request("status", { sessionId: currentId });
			}
			if (token !== this.scanToken) return;
			let backlog = null;
			let backlogError;
			const todoPath = status?.session?.state?.todoPath ?? status?.session?.todoPath;
			if (typeof todoPath === "string" && todoPath !== "") {
				try {
					backlog = await context.backend.request("backlog", { path: todoPath });
				}
				catch (error) {
					backlogError = error instanceof Error ? error.message : String(error);
				}
			}
			if (token !== this.scanToken) return;
			// The status line's context percentage + active model come from the
			// pi-web session status — the same data the chat strip fetches (and
			// the TUI reads via ctx.getContextUsage()/ctx.model). The workspace's
			// path is the cwd the session status endpoint keys sessions by. Unknown
			// context renders the TUI's "calculating…" form.
			let sessionContext = null;
			const cwd = context.workspace.path;
			if (typeof cwd === "string" && cwd !== "") {
				try {
					sessionContext = await fetchSessionContext(currentId, cwd);
				} catch {
					// Transient: keep the calculating form.
				}
			}
			if (token !== this.scanToken) return;
			this.data = { status, backlog, backlogError, sessionContext };
			this.error = undefined;
			this.loading = false;
			this.render();
		}
		catch (error) {
			if (token !== this.scanToken) return;
			// The workspace provider only claims this project once ralph state
			// exists on disk; until then the backend proxy rejects every
			// request with owner-mismatch. That is the "no ralph state yet"
			// state (e.g. a loop that just started in a web session whose
			// session file has not been written yet), not a failure.
			if (isOwnerMismatchError(error)) {
				this.renderEmpty("No Ralph state found in this project (start a loop with /ralph start).");
				return;
			}
			this.error = error instanceof Error ? error.message : String(error);
			this.loading = false;
			this.renderError(this.error);
		}
	}

	todoPath() {
		const session = this.data?.status?.session;
		return session?.state?.todoPath ?? session?.todoPath;
	}

	/**
	 * Run a backlog mutation through the backend. On success the response is the
	 * fresh snapshot, so we swap it in and re-render (no full reload needed).
	 */
	async mutate(operation, input) {
		const path = this.todoPath();
		if (typeof path !== "string" || path === "") {
			this.showNotice("No backlog file for this session.", true);
			return;
		}
		const backend = this.contextValue?.backend;
		if (backend === undefined) return;
		// backend.request validates the input is pure JSON; drop undefined keys
		// (null is a valid JSON value and is kept).
		const payload = { path, ...input };
		for (const key of Object.keys(payload)) {
			if (payload[key] === undefined) delete payload[key];
		}
		try {
			const response = await backend.request(operation, payload);
			this.data.backlog = response;
			this.render();
		}
		catch (error) {
			this.showNotice(error instanceof Error ? error.message : String(error), true);
		}
	}

	// Stage a /ralph command in the prompt editor (focused). The user presses
	// Enter to run it in the live session — the loop start/stop is an agent
	// action the web backend cannot perform directly.
	stageCommand(command) {
		const prompt = this.contextValue?.prompt;
		if (typeof prompt?.insertText !== "function") {
			this.showNotice(`Run in the terminal: ${command}`, true);
			return;
		}
		prompt.insertText(command);
		this.showNotice(`Staged in the prompt — press Enter to run: ${command}`);
	}

	startCommand(category) {
		if (category === null || category === undefined) return "/ralph start";
		const quoted = /[\s"']/.test(category) ? `"${category}"` : category;
		return `/ralph start --category ${quoted}`;
	}

	// --- rendering -------------------------------------------------------------

	renderEmpty(message) {
		this.data = undefined;
		this.error = undefined;
		this.loading = false;
		this.renderEmptyView(message);
	}

	renderSkeleton(message) {
		this.renderEmptyView(message);
	}

	renderError(message) {
		const wrap = el("div", "empty error");
		wrap.append(text(`Could not load Ralph state: ${message}`));
		this.body.replaceChildren(wrap);
	}

	renderEmptyView(message) {
		const wrap = el("div", "empty");
		wrap.append(text(message));
		this.body.replaceChildren(wrap);
		this.toolbar.hidden = true;
	}

	render() {
		const { status, backlog, backlogError } = this.data ?? {};
		const body = this.body;
		body.replaceChildren();

		if (status === null || status === undefined) {
			body.append(emptyView("No Ralph loop state in this session. Start one with /ralph start."));
			this.syncToolbar();
			return;
		}

		// A renamed/removed list may leave a stale scope; fall back to "all".
		if (this.viewCategory !== null && backlog !== null && !backlog.categories.includes(this.viewCategory)) {
			this.viewCategory = null;
		}

		// The status line's context + model: the live session status wins, with
		// the session file's last model_change as a fallback (and the default
		// key when neither is known).
		const sessionContext = this.data?.sessionContext ?? null;
		const modelKey = sessionContext?.modelKey ?? status.session.modelKey ?? DEFAULT_MODEL_CONFIG_KEY;
		const contextPercent = sessionContext?.contextPercent ?? null;
		body.append(this.renderLoopCard(status.session.state ?? null, status.config, backlog?.goal, { modelKey, contextPercent }));
		if (backlog !== null) {
			body.append(this.renderGoalCard(backlog.goal));
			body.append(this.renderBacklogCard(backlog));
		}
		else if (backlogError !== undefined) {
			body.append(noteCard(`Backlog could not be read: ${backlogError}`));
		}
		body.append(this.renderConfigCard(status.config, status.session));
		this.syncToolbar();
	}

	renderLoopCard(state, configResult, goal, sessionContext) {
		const card = el("section", "card");
		card.append(el("h2", undefined, "Loop"));

		const badges = el("div", "badges");
		if (state === null || state === undefined) badges.append(badge("not started", "muted"));
		else {
			badges.append(badge(state.enabled ? "active" : "stopped", state.enabled ? "ok" : "muted"));
			if (state.paused) badges.append(badge("paused", "warn"));
			if (state.blocked) badges.append(badge("awaiting decision", "warn"));
			if (state.stopRequested) badges.append(badge("stop requested", "warn"));
		}
		card.append(badges);

		// The same status line as the chat strip (the TUI's status, minus the
		// task counter): mode, state word, modifiers, cycle policy, iteration,
		// category, goal state, and context usage. Shown once a loop has been
		// started in this session.
		if (state !== null && state !== undefined) {
			const statusLine = el("div", "status-line");
			statusLine.textContent = tuiStatusText({
				state,
				config: configResult?.config ?? null,
				goalState: goal?.status,
				contextPercent: sessionContext?.contextPercent ?? null,
				modelKey: sessionContext?.modelKey,
			});
			statusLine.title = statusLine.textContent;
			card.append(statusLine);
		}

		// Loop control: start/stop stage the /ralph command in the prompt.
		const controls = el("div", "controls");
		if (state !== null && state !== undefined && state.enabled) {
			controls.append(controlButton("■ Stop", "stop", "Stop the loop (/ralph stop)", () => this.stageCommand("/ralph stop")));
		}
		else {
			controls.append(controlButton("▶ Start", "go", "Start the loop (/ralph start)", () => this.stageCommand(this.startCommand(this.viewCategory))));
			if (goal !== null && goal !== undefined) {
				controls.append(controlButton("▶ Start goal", "go", "Start the goal loop (/ralph start --goal)", () => this.stageCommand("/ralph start --goal")));
			}
		}
		card.append(controls);

		if (state === null || state === undefined) {
			card.append(note("No loop started in this session yet. Start one with /ralph start."));
			return card;
		}

		// The status line above carries mode/iteration/category/context, so the
		// rows keep only what it does not: the pending decision and the backlog
		// file. (The TUI's task counter is deliberately not shown — the
		// next-open-task position is not a reliable indicator of the current
		// task.)
		const rows = el("dl", "rows");
		if (state.blocked && state.blockedItem) rows.append(row("Decision", state.blockedItem, true));
		if (state.todoPath) rows.append(row("Backlog file", state.todoPath, true));
		if (rows.childNodes.length > 0) card.append(rows);
		return card;
	}

	renderGoalCard(goal) {
		const card = el("section", "card");
		card.append(el("h2", undefined, "Goal"));

		if (goal === null || goal === undefined) {
			const controls = el("div", "controls");
			controls.append(note("No goal in this backlog."));
			controls.append(controlButton("＋ Add goal", "go", "Add a goal", () => this.editGoal(null)));
			card.append(controls);
			return card;
		}

		const badges = el("div", "badges");
		badges.append(badge(goal.status, goal.status === "done" ? "ok" : goal.status === "claimed" ? "warn" : "muted"));
		card.append(badges);

		const rows = el("dl", "rows");
		if (goal.body) rows.append(row("Goal", goal.body, true));
		if (goal.evidence) rows.append(row("Evidence", goal.evidence, true));
		if (goal.checkpoint) rows.append(row("Checkpoint", goal.checkpoint, true));
		card.append(rows);

		const controls = el("div", "controls");
		controls.append(controlButton("✎ Edit goal", undefined, "Edit the goal", () => this.editGoal(goal)));
		controls.append(controlButton("🗑 Delete goal", "danger", "Delete the goal", () => this.deleteGoal()));
		card.append(controls);
		return card;
	}

	renderBacklogCard(backlog) {
		const card = el("section", "card");
		card.append(el("h2", undefined, "Backlog"));

		const counts = el("div", "counts");
		counts.append(text(`Backlog: ${backlog.counts.open} open / ${backlog.counts.total} total (${backlog.counts.completed} done)`));
		card.append(counts);

		// List (category) selector: "(all)" + each list, with open/total counts.
		const chips = el("div", "chips");
		const allCounts = backlog.counts;
		chips.append(scopeChip("(all)", `${allCounts.open}/${allCounts.total}`, this.viewCategory === null, () => this.setScope(null)));
		for (const name of backlog.categories) {
			const categoryTasks = backlog.tasks.filter((task) => task.category === name);
			const open = categoryTasks.filter((task) => !task.done).length;
			chips.append(scopeChip(name, `${open}/${categoryTasks.length}`, this.viewCategory === name, () => this.setScope(name)));
		}
		card.append(chips);

		const listControls = el("div", "controls");
		if (this.viewCategory !== null) {
			listControls.append(controlButton("✎ Rename list", undefined, "Rename this list", () => this.renameList(this.viewCategory)));
		}
		listControls.append(controlButton("＋ New list", undefined, "Create a new list", () => this.createList()));
		card.append(listControls);

		// The task list, scoped to the selected list (or all), in file order.
		const displayed = this.viewCategory === null ? backlog.tasks : backlog.tasks.filter((task) => task.category === this.viewCategory);
		const list = el("ul", "tasks");
		if (displayed.length === 0) list.append(el("li", "empty-row", "No tasks in this list."));
		displayed.forEach((task, index) => list.append(this.renderTaskRow(backlog, task, String(index + 1))));
		card.append(list);

		const addControls = el("div", "controls");
		addControls.append(controlButton("＋ Add task", "go", "Add a task", () => this.addTask()));
		card.append(addControls);
		return card;
	}

	renderTaskRow(backlog, task, number) {
		const item = el("li", task.done ? "task done" : "task");
		const expanded = this.expandedTaskIds.has(task.id);

		const box = document.createElement("input");
		box.type = "checkbox";
		box.checked = task.done;
		box.title = task.done && task.completedAt ? `completed ${task.completedAt}` : task.done ? "done" : "open";
		box.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleDone(backlog, task, number);
		});
		item.append(box);

		const main = el("div", "task-main");
		const line = el("div", "task-line");
		line.append(el("span", "task-num", `#${number}`));
		const title = el("span", "task-title", task.title);
		line.append(title);

		const actions = el("span", "task-actions");
		actions.append(iconButton("↑", "Move up", () => this.moveTask(task.id, "up")));
		actions.append(iconButton("↓", "Move down", () => this.moveTask(task.id, "down")));
		actions.append(iconButton("✎", "Edit task", () => this.editTask(task)));
		actions.append(iconButton("🗑", "Delete task", () => this.deleteTask(task, number)));
		line.append(actions);
		line.addEventListener("click", () => this.toggleExpand(task.id));
		main.append(line);

		if (expanded) {
			const detail = el("div", "task-detail");
			if (task.body) detail.append(el("div", "task-body", task.body));
			if (task.checkpoint) detail.append(el("div", "task-checkpoint", `checkpoint (iter ${task.checkpointIteration ?? "?"}): ${task.checkpoint}`));
			const entries = (backlog.log ?? []).filter((entry) => entry.taskId === task.id);
			if (entries.length > 0) {
				const log = el("div", "task-log");
				log.append(el("div", "log-label", "Completion log"));
				for (const entry of entries) {
					const marker = entry.kind === "reopen" ? "✗" : "✓";
					const date = entry.date ? ` ${entry.date}` : "";
					log.append(el("div", `log-entry ${entry.kind}`, `${marker}${date} ${entry.note}`));
				}
				detail.append(log);
			}
			main.append(detail);
		}
		item.append(main);
		return item;
	}

	renderConfigCard(configResult, session) {
		const card = el("section", "card");
		card.append(el("h2", undefined, "Config"));
		const config = configResult?.config ?? session?.config;
		if (config === null || config === undefined) {
			card.append(note("No saved Ralph configuration (defaults apply)."));
		}
		else {
			const source = configResult?.source === "dir" ? `directory${configResult.branch ? ` · branch ${configResult.branch}` : ""}` : configResult?.source === "defaults" ? "global defaults" : "session";
			const rows = el("dl", "rows");
			rows.append(row("Source", source));
			if (typeof config.autoMode === "string") rows.append(row("Auto mode", config.autoMode));
			if (typeof config.autoApproveDecisions === "boolean") rows.append(row("Auto-approve decisions", config.autoApproveDecisions ? "on" : "off"));
			if (typeof config.maxIterations === "number") rows.append(row("Max iterations", String(config.maxIterations)));
			if (typeof config.compactionMode === "boolean") rows.append(row("Compaction", config.compactionMode ? "on" : "off"));
			if (config.cycleOn && typeof config.cycleOn === "object") {
				for (const [mode, value] of Object.entries(config.cycleOn)) rows.append(row(`Cycle (${mode})`, String(value)));
			}
			if (config.contextThresholds && typeof config.contextThresholds === "object") {
				for (const [model, threshold] of Object.entries(config.contextThresholds)) {
					rows.append(row(`Context (${model})`, `${Math.round(Number(threshold) * 100)}%`));
				}
			}
			card.append(rows);
		}
		const controls = el("div", "controls");
		controls.append(controlButton("✎ Edit", undefined, "Edit the Ralph configuration", () => this.editConfig()));
		card.append(controls);
		return card;
	}

	syncToolbar() {
		this.toolbar.hidden = false;
		const updated = this.root.querySelector(".updated");
		updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
	}

	// --- interactions ----------------------------------------------------------

	setScope(category) {
		if (this.viewCategory === category) return;
		this.viewCategory = category;
		this.expandedTaskIds = new Set();
		this.render();
	}

	toggleExpand(taskId) {
		if (this.expandedTaskIds.has(taskId)) this.expandedTaskIds.delete(taskId);
		else this.expandedTaskIds.add(taskId);
		this.render();
	}

	toggleDone(backlog, task, number) {
		const done = !task.done;
		const verb = done ? "Complete" : "Reopen";
		this.openForm({
			title: `${done ? "✓" : "✗"} ${verb} task #${number}`,
			fields: [
				{
					name: "reason",
					label: "Reason (recorded in the completion log)",
					type: "textarea",
					required: true,
					placeholder: done ? "Why is this done?" : "Why is this reopened?",
				},
			],
			submitLabel: verb,
			onSubmit: (values) => {
				const reason = String(values.reason ?? "").trim();
				if (!reason) {
					this.showNotice("A reason is required.", true);
					return;
				}
				void this.mutate("task.set-done", { id: task.id, done, reason, category: this.viewCategory ?? undefined });
			},
		});
	}

	addTask() {
		this.openForm({
			title: "Add task",
			fields: [
				{ name: "title", label: "Title", type: "text", required: true },
				{ name: "body", label: "Body", type: "textarea" },
				{ name: "category", label: "List", type: "select", options: this.categoryOptions(), value: this.viewCategory ?? "" },
			],
			submitLabel: "Add",
			onSubmit: (values) => {
				void this.mutate("task.add", {
					title: String(values.title ?? ""),
					body: values.body === undefined ? undefined : String(values.body),
					category: values.category === undefined || values.category === "" ? undefined : String(values.category),
				});
			},
		});
	}

	editTask(task) {
		this.openForm({
			title: `Edit task #${this.numberFor(task)}`,
			fields: [
				{ name: "title", label: "Title", type: "text", required: true, value: task.title },
				{ name: "body", label: "Body", type: "textarea", value: task.body ?? "" },
				{ name: "category", label: "List", type: "select", options: this.categoryOptions(), value: task.category ?? "" },
			],
			submitLabel: "Save",
			onSubmit: (values) => {
				void this.mutate("task.update", {
					id: task.id,
					title: String(values.title ?? ""),
					body: values.body === undefined ? null : String(values.body),
					category: values.category === undefined ? null : String(values.category),
				});
			},
		});
	}

	deleteTask(task, number) {
		this.openConfirm({
			title: `Delete task #${number}?`,
			message: `“${task.title}” and its completion log entries will be deleted.`,
			confirmLabel: "Delete",
			danger: true,
			onConfirm: () => void this.mutate("task.delete", { id: task.id }),
		});
	}

	moveTask(taskId, direction) {
		void this.mutate("task.move", { id: taskId, direction, category: this.viewCategory ?? undefined });
	}

	renameList(oldName) {
		this.openForm({
			title: `Rename list “${oldName}”`,
			fields: [{ name: "newName", label: "New name", type: "text", required: true, value: oldName }],
			submitLabel: "Rename",
			onSubmit: (values) => {
				const newName = String(values.newName ?? "").trim();
				if (newName === oldName) return;
				void this.mutate("list.rename", { oldName, newName });
			},
		});
	}

	createList() {
		this.openForm({
			title: "New list",
			fields: [{ name: "name", label: "List name", type: "text", required: true }],
			submitLabel: "Create",
			onSubmit: (values) => {
				void this.mutate("list.create", { name: String(values.name ?? "").trim() });
			},
		});
	}

	editGoal(goal) {
		this.openForm({
			title: goal ? "Edit goal" : "Add goal",
			fields: [{ name: "body", label: "Goal", type: "textarea", required: true, value: goal?.body ?? "" }],
			submitLabel: goal ? "Save" : "Add",
			onSubmit: (values) => {
				void this.mutate("goal.set", { body: String(values.body ?? "") });
			},
		});
	}

	deleteGoal() {
		this.openConfirm({
			title: "Delete goal?",
			message: "The goal (with its evidence and checkpoint) will be deleted.",
			confirmLabel: "Delete",
			danger: true,
			onConfirm: () => void this.mutate("goal.delete", {}),
		});
	}

	/**
	 * Edit the Ralph configuration. Mirrors the /ralph config TUI: the same
	 * rows in the same order, the context threshold keyed by the session's
	 * active model (falling back to the default-model entry, then the
	 * built-in default), and switching "Save to" re-displays the rows from
	 * the selected source (the directory's entry or the global defaults).
	 * Saving goes through the config.set op with the full config.
	 */
	editConfig() {
		const status = this.data?.status;
		const configResult = status?.config;
		const sources = status?.sources ?? { dir: null, defaults: null };
		const config = configResult?.config ?? status?.session?.config ?? {};
		// The session's active model key (provider/modelId), like the TUI's
		// modelConfigKey; the default-model key when the session has none.
		const modelKey = status?.session?.modelKey ?? DEFAULT_MODEL_CONFIG_KEY;
		const builtIn = { autoMode: "off", autoApproveDecisions: false, maxIterations: 10, compactionMode: true, cycleOn: { tasks: "task", goal: "task", auto: "budget" } };
		// The row values for a source config (the directory's entry or the
		// global defaults), with built-in defaults for fields a saved config
		// predates — the same fallbacks the TUI's normalizeConfig applies.
		const displayValues = (raw) => {
		const cfg = raw ?? {};
		// cycleOn ?? rotateOn mirrors the TUI's normalizeConfig legacy mapping.
		const cycleOn = migrateCycleOn(cfg.cycleOn ?? cfg.rotateOn, builtIn.cycleOn);
		const threshold = cfg.contextThresholds?.[modelKey] ?? cfg.contextThresholds?.[DEFAULT_MODEL_CONFIG_KEY] ?? 0.5;
			return {
				contextThreshold: String(Number((threshold * 100).toFixed(10))),
				maxIterations: String(cfg.maxIterations ?? builtIn.maxIterations),
				compactionMode: (cfg.compactionMode ?? builtIn.compactionMode) === true,
				autoApproveDecisions: (cfg.autoApproveDecisions ?? builtIn.autoApproveDecisions) === true,
				autoMode: (cfg.autoMode ?? builtIn.autoMode) === "on",
				cycleOnTasks: cycleOn.tasks,
				cycleOnGoal: cycleOn.goal,
				cycleOnAuto: cycleOn.auto,
			};
		};
		this.openForm({
			title: "Edit Ralph configuration",
			fields: [
				{
					name: "scope",
					label: "Save to",
					type: "select",
					options: ["this directory (branch)", "global defaults"],
					value: "this directory (branch)",
					onChange: (value, setValues) =>
						setValues(displayValues(value === "global defaults" ? sources.defaults : sources.dir)),
				},
				{
					name: "contextThreshold",
					label: `Start fresh context at (10–100, ${modelKey})`,
					type: "text",
					value: displayValues(config).contextThreshold,
					validate: (value) => {
						const percentage = Number(value.trim().replace(/%$/, ""));
						return Number.isFinite(percentage) && percentage >= 10 && percentage <= 100
							? undefined
							: "Context percentage must be a number from 10 to 100.";
					},
				},
				{
					name: "maxIterations",
					label: "Maximum iterations",
					type: "text",
					value: displayValues(config).maxIterations,
					validate: (value) =>
						Number.isInteger(Number(value.trim())) && Number(value.trim()) >= 1 ? undefined : "Maximum iterations must be a positive whole number.",
				},
				{ name: "compactionMode", label: "Compaction mode", type: "checkbox", value: displayValues(config).compactionMode },
				{ name: "autoApproveDecisions", label: "Auto-approve decisions", type: "checkbox", value: displayValues(config).autoApproveDecisions },
				{ name: "autoMode", label: "Auto mode", type: "checkbox", value: displayValues(config).autoMode },
				{ name: "cycleOnTasks", label: "Cycle: task loop", type: "select", options: ["task", "budget"], value: displayValues(config).cycleOnTasks },
				{ name: "cycleOnGoal", label: "Cycle: goal loop", type: "select", options: ["task", "budget"], value: displayValues(config).cycleOnGoal },
				{ name: "cycleOnAuto", label: "Cycle: auto loop", type: "select", options: ["task", "budget"], value: displayValues(config).cycleOnAuto },
			],
			submitLabel: "Save",
			onSubmit: (values) => {
				const isDefaults = values.scope === "global defaults";
				// Keep the other models' threshold entries of the edited source.
				const source = isDefaults ? sources.defaults : sources.dir;
				const contextThresholds = { ...(source?.contextThresholds ?? {}) };
				contextThresholds[modelKey] = Number(values.contextThreshold.trim().replace(/%$/, "")) / 100;
				void this.requestConfig({
					scope: isDefaults ? "defaults" : "directory",
					config: {
						contextThresholds,
						autoApproveDecisions: values.autoApproveDecisions === true,
						maxIterations: Number(values.maxIterations.trim()),
						compactionMode: values.compactionMode === true,
						autoMode: values.autoMode === true ? "on" : "off",
						cycleOn: { tasks: values.cycleOnTasks, goal: values.cycleOnGoal, auto: values.cycleOnAuto },
					},
				});
			},
		});
	}

	/** Save the config through the backend and re-render from the fresh store state. */
	async requestConfig(payload) {
		const backend = this.contextValue?.backend;
		if (backend === undefined) return;
		try {
			const fresh = await backend.request("config.set", payload);
			// Backend results are frozen: replace the status object instead of
			// mutating the (frozen) one held in this.data.
			this.data = { ...this.data, status: { ...this.data.status, config: fresh } };
			this.showNotice("Ralph configuration saved.");
			this.render();
		}
		catch (error) {
			this.showNotice(error instanceof Error ? error.message : String(error), true);
		}
	}

	// The list options for a select: "(none)" + each list.
	categoryOptions() {
		const categories = this.data?.backlog?.categories ?? [];
		return ["(none)", ...categories];
	}

	// Display number of a task in the current view scope (1-based index).
	numberFor(task) {
		const backlog = this.data?.backlog;
		if (!backlog) return String(task.id);
		const displayed = this.viewCategory === null ? backlog.tasks : backlog.tasks.filter((t) => t.category === this.viewCategory);
		const index = displayed.findIndex((t) => t.id === task.id);
		return index === -1 ? String(task.id) : String(index + 1);
	}

	// --- modals ----------------------------------------------------------------

	openForm({ title, fields, submitLabel, onSubmit }) {
		const modal = el("div", "modal-backdrop");
		const box = el("div", "modal");
		box.append(el("h3", undefined, title));

		const form = document.createElement("form");
		const inputs = new Map();
		for (const field of fields) {
			const wrap = el("label", field.type === "checkbox" ? "field checkbox" : "field");
			wrap.append(el("span", "field-label", field.label));
			let control;
			if (field.type === "textarea") {
				control = document.createElement("textarea");
				control.rows = 4;
			}
			else if (field.type === "select") {
				control = document.createElement("select");
				for (const option of field.options ?? []) {
					const opt = document.createElement("option");
					opt.value = option === "(none)" ? "" : option;
					opt.textContent = option;
					control.append(opt);
				}
			}
			else if (field.type === "checkbox") {
				control = document.createElement("input");
				control.type = "checkbox";
			}
			else {
				control = document.createElement("input");
				control.type = "text";
			}
			if (field.type === "checkbox") control.checked = field.value === true;
			else if (field.value !== undefined) control.value = field.value;
			if (field.placeholder) control.placeholder = field.placeholder;
			// Optional live handler (e.g. the config form's "Save to" row
			// re-displaying the other rows from the selected source, like the
			// TUI). setValues updates the open form's other controls.
			if (field.onChange) {
				control.addEventListener("change", () => {
					const setValues = (updates) => {
						for (const [name, value] of Object.entries(updates)) {
							const other = inputs.get(name);
							if (other === undefined) continue;
							if (other.type === "checkbox") other.checked = value === true;
							else other.value = value;
						}
					};
					field.onChange(control.value, setValues);
				});
			}
			inputs.set(field.name, control);
			wrap.append(control);
			form.append(wrap);
		}

		const actions = el("div", "modal-actions");
		const cancel = el("button", "btn", "Cancel");
		cancel.type = "button";
		cancel.addEventListener("click", () => this.closeModal());
		const submit = el("button", "btn primary", submitLabel);
		submit.type = "submit";
		actions.append(cancel, submit);
		form.append(actions);

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const values = {};
			for (const [name, control] of inputs) values[name] = control.type === "checkbox" ? control.checked : control.value;
			// Validate required fields.
			for (const field of fields) {
				if (field.required && String(values[field.name] ?? "").trim() === "") {
					this.showNotice(`${field.label} is required.`, true);
					return;
				}
			}
			// Per-field validation (the form stays open on a problem).
			for (const field of fields) {
				if (field.validate) {
					const problem = field.validate(String(values[field.name] ?? ""));
					if (problem !== undefined) {
						this.showNotice(problem, true);
						return;
					}
				}
			}
			this.closeModal();
			onSubmit(values);
		});

		box.append(form);
		modal.append(box);
		modal.addEventListener("click", (event) => {
			if (event.target === modal) this.closeModal();
		});
		this.modalRoot.replaceChildren(modal);
		this.modalRoot.hidden = false;
		const first = form.querySelector("input, textarea, select");
		first?.focus();
	}

	openConfirm({ title, message, confirmLabel, danger, onConfirm }) {
		const modal = el("div", "modal-backdrop");
		const box = el("div", "modal");
		box.append(el("h3", undefined, title));
		box.append(el("p", "modal-message", message));
		const actions = el("div", "modal-actions");
		const cancel = el("button", "btn", "Cancel");
		cancel.type = "button";
		cancel.addEventListener("click", () => this.closeModal());
		const confirm = el("button", danger ? "btn danger" : "btn primary", confirmLabel);
		confirm.type = "button";
		confirm.addEventListener("click", () => {
			this.closeModal();
			onConfirm();
		});
		actions.append(cancel, confirm);
		box.append(actions);
		modal.append(box);
		modal.addEventListener("click", (event) => {
			if (event.target === modal) this.closeModal();
		});
		this.modalRoot.replaceChildren(modal);
		this.modalRoot.hidden = false;
		confirm.focus();
	}

	closeModal() {
		this.modalRoot.replaceChildren();
		this.modalRoot.hidden = true;
	}

	showNotice(message, isError = false) {
		this.notice.textContent = message;
		this.notice.className = `notice ${isError ? "error" : ""}`;
		this.notice.hidden = false;
		if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
		this.noticeTimer = setTimeout(() => {
			this.notice.hidden = true;
			this.noticeTimer = null;
		}, 6000);
	}
}

// --- section builders / DOM helpers -------------------------------------------

function el(tag, className, textContent) {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (textContent !== undefined) node.textContent = textContent;
	return node;
}

function text(value) {
	return document.createTextNode(String(value));
}

function row(label, value, multiline) {
	const wrap = el("div", "row");
	const dt = el("dt", undefined, label);
	const dd = el("dd", multiline ? "value multiline" : "value", value);
	wrap.append(dt, dd);
	return wrap;
}

function badge(label, tone) {
	return el("span", `badge ${tone}`, label);
}

function note(message) {
	return el("p", "note", message);
}

function noteCard(message) {
	const card = el("section", "card");
	card.append(note(message));
	return card;
}

function emptyView(message) {
	const wrap = el("div", "empty");
	wrap.append(text(message));
	return wrap;
}

function controlButton(label, kind, title, onClick) {
	const button = el("button", `btn ${kind ?? ""}`.trim(), label);
	button.title = title;
	button.type = "button";
	button.addEventListener("click", onClick);
	return button;
}

function iconButton(label, title, onClick) {
	const button = el("button", "icon-btn", label);
	button.title = title;
	button.type = "button";
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		onClick();
	});
	return button;
}

function scopeChip(label, counts, active, onClick) {
	const chip = el("button", `chip ${active ? "active" : ""}`);
	chip.type = "button";
	chip.append(text(`${label} `));
	chip.append(el("span", "chip-counts", counts));
	chip.addEventListener("click", onClick);
	return chip;
}

// The pi-web backend proxy rejects requests for a project the ralph provider
// does not claim (no ralph state on disk yet) with this message.
// Mirrors ralph-loop's migrateCycleOn: the current object form, the legacy
// single string, or the fallback (built-in) policy.
function migrateCycleOn(value, fallback) {
	const isPolicy = (v) => v === "task" || v === "budget";
	if (value !== null && typeof value === "object" && !Array.isArray(value) && ["tasks", "goal", "auto"].every((mode) => isPolicy(value[mode]))) {
		return value;
	}
	if (isPolicy(value)) return { tasks: value, goal: value, auto: value };
	return { ...fallback };
}

function isOwnerMismatchError(error) {
	return error instanceof Error && error.message.includes("does not own project");
}

// The status op's "this session has no ralph state yet" rejection — the
// signal to auto-create the session backlog (like the TUI) and retry. The
// backend proxy wraps provider errors ("... operation status failed: "),
// so match on the message body, not the start.
function isNoRalphStateError(error) {
	return error instanceof Error && error.message.includes("no ralph state for session");
}

function contextKey(context) {
	return JSON.stringify([
		context?.machine?.id,
		context?.workspace?.projectId,
		context?.workspace?.id,
		// Switching the session in the pi-web UI re-links the panel to it.
		context?.state?.selectedSession?.id,
	]);
}

function styles() {
	return `
		:host { display: block; height: 100%; overflow: auto; padding: 8px 12px; font-family: inherit; }
		.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
		.toolbar .title { font-weight: 600; }
		.toolbar .spacer { flex: 1; }
		.toolbar .updated { opacity: 0.65; font-size: 0.85em; }
		.toolbar button { cursor: pointer; }
		.notice { padding: 6px 10px; margin-bottom: 8px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); font-size: 0.9em; }
		.notice.error { color: #f87171; border-color: currentColor; }
		.card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
		.card h2 { margin: 0 0 8px; font-size: 1em; }
		.card h3 { margin: 0 0 8px; font-size: 1em; }
		.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
		.badge { border-radius: 999px; padding: 1px 10px; font-size: 0.85em; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
		.badge.ok { color: #4ade80; border-color: currentColor; }
		.badge.warn { color: #facc15; border-color: currentColor; }
		.badge.muted { opacity: 0.7; }
		.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
		.status-line { margin: 0 0 8px; padding: 6px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); opacity: 0.8; font-size: 0.9em; overflow-wrap: anywhere; }
		.rows { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
		.rows .row { display: contents; }
		.rows dt { opacity: 0.7; }
		.rows dd { margin: 0; overflow-wrap: anywhere; }
		.rows dd.multiline { white-space: pre-wrap; }
		.counts { margin-bottom: 6px; }
		.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
		.chip { border-radius: 999px; padding: 2px 10px; font-size: 0.85em; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; cursor: pointer; }
		.chip .chip-counts { opacity: 0.6; }
		.chip.active { background: color-mix(in srgb, currentColor 18%, transparent); border-color: currentColor; }
		.tasks { list-style: none; margin: 4px 0; padding: 0; }
		.empty-row { opacity: 0.6; padding: 4px 0; }
		.task { display: flex; gap: 8px; padding: 4px 0; align-items: flex-start; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
		.task:first-child { border-top: none; }
		.task input { margin-top: 4px; cursor: pointer; }
		.task-main { flex: 1; min-width: 0; }
		.task-line { display: flex; align-items: center; gap: 8px; cursor: pointer; }
		.task-num { opacity: 0.55; font-variant-numeric: tabular-nums; white-space: nowrap; }
		.task-title { overflow-wrap: anywhere; }
		.task.done .task-title { opacity: 0.55; text-decoration: line-through; }
		.task-actions { margin-left: auto; display: none; gap: 2px; }
		.task:hover .task-actions, .task:focus-within .task-actions { display: inline-flex; }
		.icon-btn { cursor: pointer; background: transparent; color: inherit; border: 1px solid transparent; border-radius: 4px; padding: 0 4px; line-height: 1.4; }
		.icon-btn:hover { border-color: color-mix(in srgb, currentColor 30%, transparent); }
		.task-detail { margin-top: 4px; padding-left: 4px; border-left: 2px solid color-mix(in srgb, currentColor 20%, transparent); }
		.task-body { opacity: 0.8; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.92em; }
		.task-checkpoint { opacity: 0.6; font-size: 0.85em; overflow-wrap: anywhere; margin-top: 4px; }
		.task-log { margin-top: 6px; }
		.log-label { opacity: 0.6; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; }
		.log-entry { font-size: 0.88em; overflow-wrap: anywhere; padding: 1px 0; }
		.log-entry.done { opacity: 0.8; }
		.log-entry.reopen { opacity: 0.6; }
		.btn { cursor: pointer; border-radius: 6px; padding: 3px 10px; font-size: 0.9em; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
		.btn:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
		.btn.primary { border-color: currentColor; }
		.btn.go { color: #4ade80; border-color: currentColor; }
		.btn.danger, .btn.danger:hover { color: #f87171; border-color: currentColor; }
		.btn.stop { color: #f87171; border-color: currentColor; }
		.note { opacity: 0.8; }
		.empty { opacity: 0.7; padding: 12px 0; }
		.empty.error { color: #f87171; }
		.modal-root { position: absolute; inset: 0; }
		.modal-backdrop { position: fixed; inset: 0; background: color-mix(in srgb, black 55%, transparent); display: flex; align-items: flex-start; justify-content: center; padding-top: 10vh; z-index: 10; }
		.modal { background: var(--pi-surface, #161b22); color: var(--pi-terminal-text, #e6edf3); border: 1px solid var(--pi-border, #30363d); border-radius: 10px; padding: 16px; width: min(520px, 90vw); box-shadow: 0 12px 40px color-mix(in srgb, black 60%, transparent); }
		.modal form { display: flex; flex-direction: column; gap: 10px; }
		.field { display: flex; flex-direction: column; gap: 4px; }
		.field-label { opacity: 0.7; font-size: 0.85em; }
		.field input, .field textarea, .field select { font: inherit; color: inherit; background: var(--pi-bg, #0d1117); border: 1px solid var(--pi-border, #30363d); border-radius: 6px; padding: 6px 8px; }
		.field.checkbox { flex-direction: row; align-items: center; gap: 8px; }
		.field.checkbox .field-label { opacity: 1; font-size: 1em; }
		.field.checkbox input { width: auto; padding: 0; border: none; background: transparent; }
		.field textarea { resize: vertical; }
		.modal-message { opacity: 0.85; overflow-wrap: anywhere; }
		.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
	`;
}
