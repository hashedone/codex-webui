import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const SOURCE = Object.freeze({ id: "codex-local", label: "Codex Desktop / local", kind: "local", monitorOnly: true });
const REQUIRED_STATE_COLUMNS = ["id", "title", "name", "agent_nickname", "agent_role", "agent_path", "cwd", "updated_at_ms", "archived", "source"];
const REQUIRED_TURN_COLUMNS = ["thread_id", "turn_id", "rollout_ordinal", "status", "started_at", "completed_at"];
const text = value => typeof value === "string" ? value : "";

function assertTable(db, table, required, databaseName) {
  const columns = new Set(db.query(`PRAGMA table_info(${table})`).all().map(row => row.name));
  if (!columns.size || required.some(column => !columns.has(column))) {
    throw new Error(`${databaseName} is incompatible: ${table} projection is unavailable`);
  }
}

function openProjection(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  try {
    const db = new Database(path, { readonly: true, strict: true });
    db.run("PRAGMA query_only = ON");
    db.run("PRAGMA busy_timeout = 250");
    return db;
  } catch (error) {
    throw new Error(`Unable to open ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceMetadata(raw) {
  if (!text(raw).startsWith("{")) return {};
  try {
    const parsed = JSON.parse(raw);
    const spawn = parsed?.subagent?.thread_spawn || parsed?.subAgent?.thread_spawn;
    return spawn && typeof spawn === "object" ? spawn : {};
  } catch {
    return {};
  }
}

function displayTitle(thread, spawn) {
  const nickname = text(thread.agent_nickname) || text(spawn.agent_nickname);
  const path = text(thread.agent_path) || text(spawn.agent_path);
  const pathName = path.split("/").filter(Boolean).at(-1)?.replaceAll("_", " ") || "";
  const explicit = text(thread.name);
  const title = explicit || (nickname && pathName ? `${nickname} · ${pathName}` : nickname || pathName) || text(thread.title) || thread.id;
  return title.slice(0, 200);
}

function publicStatus(turnStatus) {
  if (turnStatus === "inProgress") return "active";
  if (turnStatus === "completed") return "completed";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "interrupted") return "interrupted";
  return "unknown";
}

function qualify(id) { return id ? `${SOURCE.id}:${id}` : null; }

function orderHierarchy(rows, selected) {
  const children = new Map();
  for (const id of selected) {
    const parent = rows.get(id).parentLocalId;
    if (!parent || !selected.has(parent)) continue;
    const group = children.get(parent) || [];
    group.push(id); children.set(parent, group);
  }
  const compare = (a, b) => (rows.get(b).updatedAt || 0) - (rows.get(a).updatedAt || 0) || a.localeCompare(b);
  for (const group of children.values()) group.sort(compare);
  const roots = [...selected].filter(id => !selected.has(rows.get(id).parentLocalId)).sort(compare);
  const result = [], seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id); result.push(rows.get(id));
    for (const child of children.get(id) || []) visit(child);
  };
  for (const id of roots) visit(id);
  for (const id of [...selected].sort(compare)) visit(id); // Keep malformed cycles visible once.
  return result;
}

export class LocalCodexPresence {
  constructor({ statePath, historyPath, now = Date.now, recentCompletedMs = 15 * 60_000, activeLivenessMs = 6 * 60 * 60_000, refreshMs = 1500 } = {}) {
    if (!statePath || !historyPath) throw new Error("Local Codex projection paths are required");
    this.statePath = statePath; this.historyPath = historyPath; this.now = now;
    this.recentCompletedMs = recentCompletedMs; this.activeLivenessMs = activeLivenessMs; this.refreshMs = refreshMs;
    this.tasks = []; this.refreshedAt = null; this.attemptedAt = null; this.error = null; this.inFlight = null;
  }

  snapshot() {
    return { source: SOURCE, connected: !this.error && this.refreshedAt !== null, stale: !!this.error || this.refreshedAt === null,
      refreshedAt: this.refreshedAt, error: this.error, tasks: this.tasks.map(task => ({ ...task })) };
  }

  setPaths(statePath, historyPath) {
    if (!statePath || !historyPath || (statePath === this.statePath && historyPath === this.historyPath)) return;
    this.statePath = statePath; this.historyPath = historyPath;
    this.tasks = []; this.refreshedAt = null; this.attemptedAt = null; this.error = null; this.inFlight = null;
  }

  async read() {
    if (!this.inFlight && (this.attemptedAt === null || this.now() - this.attemptedAt >= this.refreshMs)) {
      this.attemptedAt = this.now();
      this.inFlight = Promise.resolve().then(() => this.refresh()).catch(error => {
        this.error = error instanceof Error ? error.message : String(error);
      }).finally(() => { this.inFlight = null; });
    }
    await this.inFlight;
    return this.snapshot();
  }

  refresh() {
    let state, history;
    try {
      state = openProjection(this.statePath, "Codex state database");
      history = openProjection(this.historyPath, "Codex thread history database");
      assertTable(state, "threads", REQUIRED_STATE_COLUMNS, "Codex state database");
      assertTable(state, "thread_spawn_edges", ["parent_thread_id", "child_thread_id"], "Codex state database");
      assertTable(history, "thread_turns", REQUIRED_TURN_COLUMNS, "Codex thread history database");

      const threads = state.query(`SELECT id,title,name,agent_nickname,agent_role,agent_path,cwd,updated_at_ms,archived,source
        FROM threads WHERE archived = 0`).all();
      const edges = state.query("SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges").all();
      const latestTurns = history.query(`SELECT thread_id,turn_id,rollout_ordinal,status,started_at,completed_at FROM (
          SELECT thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,
            ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rollout_ordinal DESC) AS rank
          FROM thread_turns
        ) WHERE rank = 1`).all();
      const turns = new Map(latestTurns.map(turn => [turn.thread_id, turn]));
      const edgeParents = new Map(edges.map(edge => [edge.child_thread_id, edge.parent_thread_id]));
      const rows = new Map();
      for (const thread of threads) {
        const turn = turns.get(thread.id);
        if (!turn) continue;
        const spawn = sourceMetadata(thread.source);
        const parentLocalId = edgeParents.get(thread.id) || text(spawn.parent_thread_id) || null;
        const updatedAt = Number(thread.updated_at_ms) || null;
        rows.set(thread.id, {
          id: qualify(thread.id), localId: thread.id, sourceId: SOURCE.id, source: SOURCE,
          parentId: qualify(parentLocalId), parentLocalId,
          title: displayTitle(thread, spawn), cwd: text(thread.cwd),
          role: text(thread.agent_role) || text(spawn.agent_role),
          agentPath: text(thread.agent_path) || text(spawn.agent_path),
          kind: parentLocalId ? "internal" : "root", canAcceptDirectInput: false,
          status: publicStatus(turn.status), turnStatus: text(turn.status), activeFlags: [], updatedAt,
          lastActivity: { at: (Number(turn.completed_at || turn.started_at) || 0) * 1000 || updatedAt, label: turn.status === "inProgress" ? "Turn in progress" : `Turn ${text(turn.status) || "unknown"}` },
          hierarchyContext: false,
        });
      }

      const cutoffSeconds = (this.now() - this.recentCompletedMs) / 1000;
      const activeCutoffSeconds = (this.now() - this.activeLivenessMs) / 1000;
      const selected = new Set();
      for (const [id, row] of rows) {
        const turn = turns.get(id);
        const activeAndLive = turn.status === "inProgress" && (Number(turn.started_at) || 0) >= activeCutoffSeconds;
        if (activeAndLive || (Number(turn.completed_at) || 0) >= cutoffSeconds) selected.add(id);
      }
      for (const id of [...selected]) {
        const seen = new Set([id]); let parent = rows.get(id)?.parentLocalId;
        while (parent && rows.has(parent) && !seen.has(parent)) {
          seen.add(parent); selected.add(parent); parent = rows.get(parent).parentLocalId;
        }
      }
      for (const id of selected) {
        const turn = turns.get(id);
        if (turn.status !== "inProgress" && (Number(turn.completed_at) || 0) < cutoffSeconds) rows.get(id).hierarchyContext = true;
      }
      this.tasks = orderHierarchy(rows, selected).map(({ parentLocalId: _privateParent, ...row }) => row);
      this.refreshedAt = this.now(); this.error = null;
    } finally {
      history?.close(); state?.close();
    }
  }
}

export { SOURCE as LOCAL_CODEX_SOURCE };
