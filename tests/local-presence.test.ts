import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalCodexPresence } from "../local-presence.js";
import { PresenceHub } from "../presence-hub.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codex-presence-")); dirs.push(dir);
  const statePath = join(dir, "state_5.sqlite");
  const historyPath = join(dir, "thread_history_1.sqlite");
  const state = new Database(statePath);
  state.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT, agent_nickname TEXT,
    agent_role TEXT, agent_path TEXT, cwd TEXT NOT NULL, updated_at_ms INTEGER,
    archived INTEGER NOT NULL, source TEXT NOT NULL, first_user_message TEXT,
    preview TEXT, rollout_path TEXT
  )`);
  state.run("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  const history = new Database(historyPath);
  history.run(`CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL, started_at INTEGER, completed_at INTEGER,
    error_json TEXT, PRIMARY KEY (thread_id, turn_id)
  )`);
  return { dir, statePath, historyPath, state, history };
}
function addThread(state: Database, id: string, options: Record<string, unknown> = {}) {
  state.query(`INSERT INTO threads
    (id,title,name,agent_nickname,agent_role,agent_path,cwd,updated_at_ms,archived,source,first_user_message,preview,rollout_path)
    VALUES ($id,$title,$name,$nickname,$role,$path,$cwd,$updated,0,$source,$prompt,$preview,$rollout)`)
    .run({
      $id: id, $title: options.title ?? `${id} title`, $name: options.name ?? null,
      $nickname: options.nickname ?? null, $role: options.role ?? null, $path: options.path ?? null,
      $cwd: options.cwd ?? "/work/project", $updated: options.updated ?? 1_700_000_000_000,
      $source: options.source ?? "cli", $prompt: options.prompt ?? "SECRET PROMPT",
      $preview: options.preview ?? "SECRET TRANSCRIPT", $rollout: options.rollout ?? "/secret/session.jsonl",
    });
}
function addTurn(history: Database, threadId: string, ordinal: number, status: string, completedAt: number | null = null) {
  history.query("INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?)")
    .run(threadId, `${threadId}-${ordinal}`, ordinal, status, 1_700_000_000, completedAt, '{"message":"SECRET ERROR"}');
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("local Codex presence source", () => {
  test("projects exact latest-turn state and a qualified parent hierarchy without leaking content", async () => {
    const f = fixture();
    addThread(f.state, "root", { name: "Desktop task" });
    addThread(f.state, "child", { nickname: "Scout", source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "root", agent_path: "/root/scout", agent_role: "researcher" } } }) });
    f.state.run("INSERT INTO thread_spawn_edges VALUES ('root','child','open')");
    addTurn(f.history, "root", 1, "completed", 1_700_000_005);
    addTurn(f.history, "root", 2, "inProgress");
    addTurn(f.history, "child", 1, "completed", 1_700_000_010);
    f.state.close(); f.history.close();

    const source = new LocalCodexPresence({ statePath: f.statePath, historyPath: f.historyPath, now: () => 1_700_000_020_000 });
    const result = await source.read();
    expect(result.stale).toBe(false);
    expect(result.tasks.map(task => [task.id, task.parentId, task.status, task.turnStatus])).toEqual([
      ["codex-local:root", null, "active", "inProgress"],
      ["codex-local:child", "codex-local:root", "completed", "completed"],
    ]);
    expect(result.tasks[1].role).toBe("researcher");
    expect(result.tasks.every(task => task.source.monitorOnly && task.canAcceptDirectInput === false)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET PROMPT");
    expect(serialized).not.toContain("SECRET TRANSCRIPT");
    expect(serialized).not.toContain("SECRET ERROR");
    expect(serialized).not.toContain("session.jsonl");
  });

  test("retains an old parent only as hierarchy context and excludes unrelated old completions", async () => {
    const f = fixture();
    for (const id of ["root", "child", "old"]) addThread(f.state, id);
    f.state.run("INSERT INTO thread_spawn_edges VALUES ('root','child','open')");
    addTurn(f.history, "root", 1, "completed", 100);
    addTurn(f.history, "child", 1, "completed", 1_995);
    addTurn(f.history, "old", 1, "completed", 100);
    f.state.close(); f.history.close();
    const result = await new LocalCodexPresence({ statePath: f.statePath, historyPath: f.historyPath, now: () => 2_000_000, recentCompletedMs: 10_000 }).read();
    expect(result.tasks.map(task => task.localId)).toEqual(["root", "child"]);
    expect(result.tasks[0].hierarchyContext).toBe(true);
  });

  test("preserves terminal status and excludes abandoned in-progress projections outside the liveness window", async () => {
    const f = fixture();
    for (const id of ["failed", "interrupted", "abandoned"]) addThread(f.state, id);
    addTurn(f.history, "failed", 1, "failed", 1_995);
    addTurn(f.history, "interrupted", 1, "interrupted", 1_996);
    addTurn(f.history, "abandoned", 1, "inProgress");
    f.history.run("UPDATE thread_turns SET started_at = 100 WHERE thread_id = 'abandoned'");
    f.state.close(); f.history.close();
    const result = await new LocalCodexPresence({ statePath: f.statePath, historyPath: f.historyPath, now: () => 2_000_000, recentCompletedMs: 10_000, activeLivenessMs: 10_000 }).read();
    expect(result.tasks.map(task => [task.localId, task.status, task.turnStatus])).toEqual([
      ["failed", "failed", "failed"], ["interrupted", "interrupted", "interrupted"],
    ]);
  });

  test("falls closed on missing or incompatible databases and preserves last-known rows as stale", async () => {
    const f = fixture(); addThread(f.state, "root"); addTurn(f.history, "root", 1, "inProgress"); f.state.close(); f.history.close();
    let now = 2_000_000;
    const source = new LocalCodexPresence({ statePath: f.statePath, historyPath: f.historyPath, now: () => now, refreshMs: 1 });
    expect((await source.read()).tasks).toHaveLength(1);
    rmSync(f.historyPath); now += 2;
    const stale = await source.read();
    expect(stale.stale).toBe(true); expect(stale.tasks).toHaveLength(1); expect(stale.error).toContain("thread history database");

    const incompatible = fixture(); incompatible.state.close(); incompatible.history.run("DROP TABLE thread_turns"); incompatible.history.close();
    const closed = await new LocalCodexPresence({ statePath: incompatible.statePath, historyPath: incompatible.historyPath }).read();
    expect(closed.stale).toBe(true); expect(closed.tasks).toEqual([]); expect(closed.error).toContain("incompatible");
  });
});

test("presence hub coexists with WebUI-owned tasks and reports health per source", async () => {
  const webui = { read: async () => ({ connected: true, stale: false, refreshedAt: 10, error: null, tasks: [{ id: "same", parentId: null, title: "Web", status: "active" }] }) };
  const local = { read: async () => ({ connected: true, stale: false, refreshedAt: 20, error: null, tasks: [{ id: "codex-local:same", localId: "same", parentId: null, title: "Local", status: "active", source: { id: "codex-local", label: "Codex Desktop / local", kind: "local", monitorOnly: true } }] }) };
  const result = await new PresenceHub({ webui, local }).read(true);
  expect(result.scope).toBe("presence-hub");
  expect(result.tasks.map(task => task.id)).toEqual(["webui:same", "codex-local:same"]);
  expect(result.sources.map(source => [source.id, source.stale])).toEqual([["webui", false], ["codex-local", false]]);
  expect(result.tasks[0].source.monitorOnly).toBe(false);
});
