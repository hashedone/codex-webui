import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { Database } from "bun:sqlite";

const ROOT = new URL("..", import.meta.url).pathname;
const AUTHORIZATION = `Basic ${Buffer.from("codex:thread-isolation-token").toString("base64")}`;

type BridgeMessage = Record<string, any>;
type RequestId = string | number;

class BrowserClient {
  readonly messages: BridgeMessage[] = [];
  private seq = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "rpc/result" || message.type === "rpc/error") {
        const request = this.pending.get(message.id);
        if (!request) {
          this.messages.push(message);
          return;
        }
        this.pending.delete(message.id);
        message.type === "rpc/result" ? request.resolve(message.result) : request.reject(new Error(message.error));
        return;
      }
      this.messages.push(message);
    });
  }

  rpc(method: string, params: any = {}) {
    const id = this.seq++;
    this.socket.send(JSON.stringify({ type: "rpc", id, method, params }));
    return new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  respondToCodex(requestId: RequestId, result: any) {
    this.socket.send(JSON.stringify({ type: "codex/response", requestId, result }));
  }
}

class SseClient {
  readonly messages: BridgeMessage[] = [];
  private readonly abort = new AbortController();
  private seq = 1;

  constructor(readonly id: string) {}

  async connect() {
    const response = await fetch(`http://127.0.0.1:${port}/api/events?clientId=${encodeURIComponent(this.id)}`, {
      headers: { authorization: AUTHORIZATION },
      signal: this.abort.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = event.split("\n").find(line => line.startsWith("data: "))?.slice(6);
            if (data) this.messages.push(JSON.parse(data));
          }
        }
      } catch (error) {
        if (!this.abort.signal.aborted) throw error;
      }
    })();
  }

  async rpc(method: string, params: any = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: "POST",
      headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.id, id: this.seq++, method, params }),
    });
    const message = await response.json();
    if (message.type !== "rpc/result") throw new Error(message.error);
    return message.result;
  }

  close() { this.abort.abort(); }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a test port"));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeout = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      const result = await check();
      if (result !== undefined) return resolve(result);
      if (Date.now() - started > timeout) return reject(new Error("Timed out waiting for condition"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: AUTHORIZATION } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return new BrowserClient(socket);
}

let port = 0;
let serverProcess: ReturnType<typeof Bun.spawn>;
let serverStderr = "";
let fakeBinDir = "";
let alpha: BrowserClient;
let beta: BrowserClient;

beforeAll(async () => {
  port = await freePort();
  fakeBinDir = mkdtempSync(join(tmpdir(), "codex-webui-fake-bin-"));
  const executable = join(fakeBinDir, "codex");
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(globalThis.process.env.BUN_INSTALL ? join(globalThis.process.env.BUN_INSTALL, "bin", "bun") : "bun")} ${JSON.stringify(join(ROOT, "tests", "fixtures", "fake-codex-app-server.ts"))} "$@"\n`);
  chmodSync(executable, 0o755);
  const stateDb = join(fakeBinDir, "state_5.sqlite");
  const historyDb = join(fakeBinDir, "thread_history_1.sqlite");
  const state = new Database(stateDb);
  state.run("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT NOT NULL,name TEXT,agent_nickname TEXT,agent_role TEXT,agent_path TEXT,cwd TEXT NOT NULL,updated_at_ms INTEGER,archived INTEGER NOT NULL,source TEXT NOT NULL)");
  state.run("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL,child_thread_id TEXT PRIMARY KEY,status TEXT NOT NULL)");
  state.query("INSERT INTO threads VALUES ('desktop-root','Desktop root',NULL,NULL,NULL,NULL,'/tmp/project',?,0,'vscode')").run(Date.now());
  state.close();
  const history = new Database(historyDb);
  history.run("CREATE TABLE thread_turns (thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,status TEXT NOT NULL,started_at INTEGER,completed_at INTEGER,PRIMARY KEY(thread_id,turn_id))");
  history.query("INSERT INTO thread_turns VALUES ('desktop-root','turn-local',1,'inProgress',?,NULL)").run(Math.floor(Date.now() / 1000));
  history.close();
  serverProcess = Bun.spawn({
    cmd: ["bun", "run", "server.ts"],
    cwd: ROOT,
    env: {
      ...globalThis.process.env,
      PATH: `${fakeBinDir}:${globalThis.process.env.PATH}`,
      PORT: String(port),
      HOST: "127.0.0.1",
      CODEX_WEBUI_PASSWORD: "",
      CODEX_WEBUI_ACCESS_TOKEN: "thread-isolation-token",
      CODEX_WEBUI_STATE_DB: stateDb,
      CODEX_WEBUI_THREAD_HISTORY_DB: historyDb,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrReader = serverProcess.stderr.getReader();
  const stderrDecoder = new TextDecoder();
  void (async () => {
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) return;
      serverStderr += stderrDecoder.decode(value, { stream: true });
    }
  })();
  await waitFor(() => fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: AUTHORIZATION } })
    .then(response => response.json())
    .then(body => body.codex ? true : undefined)
    .catch(() => undefined) as any);
  [alpha, beta] = await Promise.all([connect(port), connect(port)]);
  await Promise.all([
    alpha.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 1 }),
    beta.rpc("host/thread/subscribe", { threadId: "thread-beta", generation: 1 }),
  ]);
  await Promise.all([
    alpha.rpc("thread/read", { threadId: "thread-alpha", includeTurns: true }),
    beta.rpc("thread/read", { threadId: "thread-beta", includeTurns: true }),
  ]);
}, 15_000);

afterAll(async () => {
  alpha?.socket.terminate();
  beta?.socket.terminate();
  serverProcess?.kill("SIGTERM");
  if (serverProcess) await serverProcess.exited;
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
});

describe("thread-scoped browser bridge", () => {
  test("delivers a thread event and approval only to the browser viewing that thread", async () => {
    await alpha.rpc("turn/start", {
      threadId: "thread-alpha",
      input: [{ type: "text", text: "trigger scoped event" }],
      approvalPolicy: "on-request",
    });

    const approval = await waitFor(() => alpha.messages.find(message => message.type === "codex/request"));
    expect(approval.payload.params.threadId).toBe("thread-alpha");
    expect(alpha.messages.some(message => message.type === "codex/notification" && message.payload.params.threadId === "thread-alpha")).toBe(true);

    await Bun.sleep(100);
    expect(beta.messages.some(message => message.type === "codex/request")).toBe(false);
    expect(beta.messages.some(message => message.type === "codex/notification" && message.payload.params.threadId === "thread-alpha")).toBe(false);
  });

  test("accepts the matching approval once and rejects a second browser response", async () => {
    alpha.respondToCodex(9001, { decision: "accept" });
    await waitFor(() => alpha.messages.find(message => message.type === "codex/notification" && message.payload.method === "turn/completed"));
    expect(alpha.messages.some(message => message.type === "ack")).toBe(true);

    beta.respondToCodex(9001, { decision: "decline" });
    await Bun.sleep(100);
    const rejected = beta.messages.find(message => message.type === "rpc/error");
    expect(rejected).toBeDefined();
    expect(rejected.error).toMatch(/approval.*pending|not.*recipient|already.*answered/i);
  });

  test("keeps SSE fallback events scoped to the matching browser client", async () => {
    const sseAlpha = new SseClient("sse-alpha");
    const sseBeta = new SseClient("sse-beta");
    try {
      await Promise.all([sseAlpha.connect(), sseBeta.connect()]);
      await Promise.all([
        sseAlpha.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 1 }),
        sseBeta.rpc("host/thread/subscribe", { threadId: "thread-beta", generation: 1 }),
      ]);
      await sseAlpha.rpc("turn/start", {
        threadId: "thread-alpha",
        input: [{ type: "text", text: "trigger SSE scoped event" }],
        approvalPolicy: "on-request",
      });
      await Bun.sleep(150);
      expect(sseAlpha.messages.some(message => message.type === "codex/request" && message.payload.params.threadId === "thread-alpha")).toBe(true);
      expect(sseBeta.messages.some(message => message.type === "codex/request")).toBe(false);
    } finally {
      sseAlpha.close();
      sseBeta.close();
    }
  });

  test("does not change the active subscription from an unrelated RPC carrying a forged thread id", async () => {
    alpha.messages.length = 0;
    await alpha.rpc("model/list", { threadId: "thread-beta" });
    await beta.rpc("turn/start", {
      threadId: "thread-beta",
      input: [{ type: "text", text: "verify forged subscription isolation" }],
      approvalPolicy: "on-request",
    });
    await waitFor(() => beta.messages.find(message => message.type === "codex/request" && message.payload.params.threadId === "thread-beta"));
    await Bun.sleep(100);
    expect(alpha.messages.some(message => message.type === "codex/request" && message.payload.params.threadId === "thread-beta")).toBe(false);
    expect(alpha.messages.some(message => message.type === "codex/notification" && message.payload.params.threadId === "thread-beta")).toBe(false);
  });

  test("ignores a stale subscription generation", async () => {
    await alpha.rpc("host/thread/subscribe", { threadId: "thread-beta", generation: 3 });
    const stale = await alpha.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 2 });
    expect(stale).toEqual({ threadId: "thread-beta", generation: 3 });
    await alpha.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 4 });
  });

  test("authorizes an immutable approval recipient after it changes active thread and accepts only one response", async () => {
    alpha.messages.length = 0;
    beta.messages.length = 0;
    await beta.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 2 });
    await alpha.rpc("turn/start", {
      threadId: "thread-alpha",
      input: [{ type: "text", text: "verify immutable recipient ownership" }],
      approvalPolicy: "on-request",
    });
    await waitFor(() => alpha.messages.find(message => message.type === "codex/request" && message.payload.id === 9001));
    await waitFor(() => beta.messages.find(message => message.type === "codex/request" && message.payload.id === 9001));
    await beta.rpc("host/thread/subscribe", { threadId: "thread-beta", generation: 3 });
    beta.respondToCodex(9001, { decision: "accept" });
    await waitFor(() => beta.messages.find(message => message.type === "ack"));
    alpha.respondToCodex(9001, { decision: "decline" });
    const rejected = await waitFor(() => alpha.messages.find(message => message.type === "rpc/error"));
    expect(rejected.error).toMatch(/no longer pending|already answered/i);
  });

  test("preserves string app-server request ids end to end", async () => {
    alpha.messages.length = 0;
    await alpha.rpc("turn/start", {
      threadId: "thread-alpha",
      input: [{ type: "text", text: "verify string request id" }],
      approvalPolicy: "on-request",
    });
    const request = await waitFor(() => alpha.messages.find(message => message.type === "codex/request" && message.payload.id === "approval-string-alpha"));
    expect(request.payload.id).toBe("approval-string-alpha");
    alpha.respondToCodex("approval-string-alpha", { decision: "accept" });
    await waitFor(() => alpha.messages.find(message => message.type === "ack"));
  });

  test("designates one browser for a threadless server request", async () => {
    alpha.messages.length = 0;
    beta.messages.length = 0;
    await alpha.rpc("turn/start", {
      threadId: "thread-alpha",
      input: [{ type: "text", text: "verify threadless request" }],
      approvalPolicy: "on-request",
    });
    await waitFor(() => alpha.messages.find(message => message.type === "codex/request" && message.payload.id === "approval-global"));
    await Bun.sleep(100);
    expect(beta.messages.some(message => message.type === "codex/request" && message.payload.id === "approval-global")).toBe(false);
    alpha.respondToCodex("approval-global", { decision: "accept" });
    await waitFor(() => alpha.messages.find(message => message.type === "ack"));
  });

  test("cleans a stale request when app-server reports serverRequest/resolved", async () => {
    alpha.messages.length = 0;
    await alpha.rpc("turn/start", {
      threadId: "thread-alpha",
      input: [{ type: "text", text: "verify resolved request cleanup" }],
      approvalPolicy: "on-request",
    });
    await waitFor(() => alpha.messages.find(message => message.type === "codex/request" && message.payload.id === "approval-resolved-alpha"));
    await alpha.rpc("host/thread/subscribe", { threadId: "thread-beta", generation: 5 });
    await waitFor(() => alpha.messages.find(message => message.type === "codex/notification" && message.payload.method === "serverRequest/resolved"));
    alpha.respondToCodex("approval-resolved-alpha", { decision: "accept" });
    const rejected = await waitFor(() => alpha.messages.find(message => message.type === "rpc/error"));
    expect(rejected.error).toMatch(/no longer pending/i);
    await alpha.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 6 });
  });

  test("keeps the bridge alive when a request recipient disconnects before resolution", async () => {
    const transient = await connect(port);
    await transient.rpc("host/thread/subscribe", { threadId: "thread-disconnected", generation: 1 });
    await transient.rpc("turn/start", {
      threadId: "thread-disconnected",
      input: [{ type: "text", text: "verify resolved request after recipient disconnect" }],
      approvalPolicy: "on-request",
    });
    await waitFor(() => transient.messages.find(message => message.type === "codex/request" && message.payload.id === "approval-resolved-alpha"));
    transient.socket.terminate();
    await Bun.sleep(250);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: AUTHORIZATION } });
    expect(response.ok).toBe(true);
    expect((await response.json()).codex).toBe(true);
    expect(serverStderr).not.toContain("client.write is not a function");
  });
});


test("command center summaries do not subscribe to thread events or approvals (WS and HTTP)", async () => {
  const observer = await connect(port);
  const sseObserver = new SseClient("overview-observer");
  try {
    await sseObserver.connect();
    const overview = await observer.rpc("host/agents/list");
    expect(overview.scope).toBe("presence-hub");
    expect(overview.tasks.map(task => task.id).sort()).toEqual(["codex-local:desktop-root", "webui:thread-alpha", "webui:thread-beta"]);
    expect(overview.sources.map(source => source.id)).toEqual(["webui", "codex-local"]);
    expect(overview.stale).toBe(false);
    const httpOverview = await sseObserver.rpc("host/agents/list");
    expect(httpOverview.tasks).toEqual(overview.tasks);
    await alpha.rpc("host/thread/subscribe", { threadId: "thread-alpha", generation: 999 });
    await alpha.rpc("turn/start", { threadId: "thread-alpha", input: [{ type: "text", text: "overview routing test" }] });
    await Bun.sleep(100);
    for (const messages of [observer.messages, sseObserver.messages]) {
      expect(messages.some(message => message.type === "codex/request")).toBe(false);
      expect(messages.some(message => message.type === "codex/notification" && message.payload.params.threadId === "thread-alpha")).toBe(false);
    }
    observer.respondToCodex(9001, { decision: "accept" });
    const denial = await waitFor(() => observer.messages.find(message => message.type === "rpc/error"));
    expect(denial.error).toContain("not the recipient");
    alpha.respondToCodex(9001, { decision: "decline" });
  } finally { observer.socket.terminate(); sseObserver.close(); }
});

test("native overlay snapshot exposes the presence DTO through an authenticated read-only endpoint", async () => {
  const endpoint = `http://127.0.0.1:${port}/api/agents/snapshot`;
  const denied = await fetch(endpoint, { headers: { host: "codex.example.com" } });
  expect(denied.status).toBe(401);

  const crossOrigin = await fetch(endpoint, {
    headers: { host: "codex.example.com", origin: "https://evil.example", authorization: AUTHORIZATION },
  });
  expect(crossOrigin.status).toBe(401);

  const response = await fetch(endpoint, {
    headers: { host: "codex.example.com", origin: "http://codex.example.com", authorization: AUTHORIZATION },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  const snapshot = await response.json();
  expect(snapshot.scope).toBe("presence-hub");
  expect(snapshot.tasks.map((task: any) => task.id).sort()).toEqual([
    "codex-local:desktop-root",
    "webui:thread-alpha",
    "webui:thread-beta",
  ]);
  expect(snapshot.sources.map((source: any) => source.id)).toEqual(["webui", "codex-local"]);
  expect(snapshot.tasks.find((task: any) => task.id === "codex-local:desktop-root")).toMatchObject({
    localId: "desktop-root",
    parentId: null,
    sourceId: "codex-local",
    status: "active",
    turnStatus: "inProgress",
    source: { id: "codex-local", monitorOnly: true },
  });
  expect(JSON.stringify(snapshot)).not.toMatch(/prompt|transcript|toolOutput|rolloutPath/i);

  const mutation = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: AUTHORIZATION },
  });
  expect(mutation.status).toBe(405);
  expect(mutation.headers.get("allow")).toBe("GET");
});
