import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = new URL("..", import.meta.url).pathname;
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const directories: string[] = [];

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const directory = mkdtempSync(join(tmpdir(), "codex-recap-"));
  directories.push(directory);
  const executable = join(directory, "codex");
  writeFileSync(executable, `#!/bin/sh\nexec bun ${JSON.stringify(join(ROOT, "tests/fixtures/fake-codex-app-server.ts"))} "$@"\n`);
  chmodSync(executable, 0o755);
  const statePath = join(directory, "state.sqlite");
  const historyPath = join(directory, "history.sqlite");
  const state = new Database(statePath);
  state.run("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT NOT NULL,name TEXT,agent_nickname TEXT,agent_role TEXT,agent_path TEXT,cwd TEXT NOT NULL,updated_at_ms INTEGER,archived INTEGER NOT NULL,source TEXT NOT NULL)");
  state.run("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL,child_thread_id TEXT PRIMARY KEY)");
  state.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)").run("desktop-root", "Desktop root", "Desktop root", null, null, null, "/work/desktop", Date.now(), 0, "desktop");
  state.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)").run("desktop-child", "Desktop verifier", "Desktop verifier", null, "verifier", "/agents/verifier", "/work/desktop", Date.now() + 1, 0, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "desktop-root" } } }));
  state.query("INSERT INTO thread_spawn_edges VALUES (?,?)").run("desktop-root", "desktop-child");
  state.close();
  const history = new Database(historyPath);
  history.run("CREATE TABLE thread_turns (thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,status TEXT NOT NULL,started_at INTEGER,completed_at INTEGER)");
  const now = Math.floor(Date.now() / 1000);
  history.query("INSERT INTO thread_turns VALUES (?,?,?,?,?,?)").run("desktop-root", "desktop-turn", 1, "completed", now - 2, now - 1);
  history.query("INSERT INTO thread_turns VALUES (?,?,?,?,?,?)").run("desktop-child", "desktop-child-turn", 1, "completed", now - 2, now - 1);
  history.close();
  const child = Bun.spawn({
    cmd: ["bun", "run", "server.ts"], cwd: ROOT,
    env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, HOST: "127.0.0.1", PORT: String(port), CODEX_WEBUI_TEST_AGENTS: "1", CODEX_WEBUI_ACCESS_TOKEN: "", CODEX_WEBUI_PASSWORD: "", CODEX_WEBUI_STATE_DB: statePath, CODEX_WEBUI_THREAD_HISTORY_DB: historyPath },
    stdout: "ignore", stderr: "pipe",
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 250; attempt++) {
    const snapshot = await fetch(`${base}/api/agents/snapshot`).then(response => response.ok ? response.json() : null).catch(() => null);
    if (snapshot?.tasks?.some((task: any) => task.id === "webui:thread-alpha")) return base;
    await Bun.sleep(20);
  }
  throw new Error("Recap fixture did not start");
}

afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGTERM"); await child.exited; }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("serves the spoken recap for a source-qualified overlay root", async () => {
  const base = await startServer();
  const response = await fetch(`${base}/api/agents/recap?rootId=${encodeURIComponent("webui:thread-alpha")}`);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ text: "Agent nadal pracuje. Poprzedni wynik: Alpha fixture result. Wynik subagenta Internal checker: Idle descendant fixture result." });
}, 10_000);

test("serves a Desktop-local root through the same recap boundary", async () => {
  const base = await startServer();
  const response = await fetch(`${base}/api/agents/recap?rootId=${encodeURIComponent("codex-local:desktop-root")}`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "Fixture result. Wynik subagenta Desktop verifier: Desktop descendant fixture result." });
}, 10_000);
