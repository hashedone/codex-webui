import { createInterface } from "node:readline";

const threads = new Map([
  ["thread-alpha", { id: "thread-alpha", name: "Alpha", cwd: process.cwd(), source: "local", turns: [] }],
  ["thread-beta", { id: "thread-beta", name: "Beta", cwd: process.cwd(), source: "local", turns: [] }],
]);

if (process.env.CODEX_WEBUI_TEST_AGENTS === "1") {
  threads.set("thread-alpha", { id: "thread-alpha", name: "Alpha root", cwd: process.cwd(), source: "appServer", turns: [], status: { type: "active", activeFlags: [] }, updatedAt: 1700000000, canAcceptDirectInput: true } as any);
  threads.set("thread-child", { id: "thread-child", name: "Review delegated task", cwd: process.cwd(), source: "appServer", turns: [], parentThreadId: "thread-alpha", status: { type: "active", activeFlags: ["waitingOnApproval"] }, updatedAt: 1700000001, canAcceptDirectInput: true } as any);
  threads.set("thread-internal", { id: "thread-internal", name: "<img src=x onerror=alert(1)> Internal checker", cwd: process.cwd(), source: { subAgent: { thread_spawn: { parent_thread_id: "thread-child" } } }, turns: [], parentThreadId: "thread-child", status: { type: "idle" }, updatedAt: 1700000002, canAcceptDirectInput: false } as any);
}

function send(message: any) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let loadedInventoryReads = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: "/tmp/codex-webui-fake-home" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/loaded/list") {
    loadedInventoryReads++;
    const emptyFirstInventory = process.env.CODEX_WEBUI_TEST_EMPTY_AGENT_INVENTORY_ONCE === "1" && loadedInventoryReads === 1;
    send({ id: message.id, result: { data: emptyFirstInventory ? [] : [...threads.keys()], nextCursor: null } }); return;
  }
  if (message.method === "thread/list") {
    const all = [...threads.values()] as any[];
    send({ id: message.id, result: { data: message.params.ancestorThreadId ? all.filter(t => t.parentThreadId && (message.params.ancestorThreadId === "thread-alpha" || t.parentThreadId === message.params.ancestorThreadId)) : all.filter(t => !t.parentThreadId), nextCursor: null } }); return;
  }
  if (message.method === "thread/read") {
    if (process.env.CODEX_WEBUI_TEST_AGENTS === "1" && message.params.threadId === "thread-internal" && message.params.includeTurns) {
      send({ id: message.id, error: { code: -32600, message: "list_turns is not supported yet" } }); return;
    }
    send({ id: message.id, result: { thread: threads.get(message.params.threadId) } });
    return;
  }
  if (message.method === "turn/start") {
    const { threadId } = message.params;
    if (process.env.CODEX_WEBUI_TEST_AGENTS === "1") {
      const target = threads.get(threadId) as any;
      if (target) target.status = { type: "active", activeFlags: ["waitingOnApproval"] };
      send({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
    }
    const prompt = message.params.input?.map((item: any) => item?.text || "").join(" ") || "";
    send({ id: message.id, result: { turn: { id: `turn-${threadId}`, status: "inProgress", items: [] } } });
    send({ method: "item/started", params: { threadId, turnId: `turn-${threadId}`, item: { id: `command-${threadId}`, type: "commandExecution", command: "printf safe", status: "inProgress" } } });
    const requestId = prompt.includes("string request id") ? "approval-string-alpha"
      : prompt.includes("resolved request") ? "approval-resolved-alpha"
        : prompt.includes("threadless request") ? "approval-global"
          : threadId === "thread-alpha" ? 9001 : 9002;
    const params = { threadId, turnId: `turn-${threadId}`, itemId: `command-${threadId}`, command: "printf safe", cwd: process.cwd(), reason: "Test thread routing" };
    send({ id: requestId, method: "item/commandExecution/requestApproval", params: prompt.includes("threadless request") ? { reason: "Test designated global request" } : params });
    if (prompt.includes("resolved request")) {
      setTimeout(() => send({ method: "serverRequest/resolved", params: { threadId, requestId } }), prompt.includes("recipient disconnect") ? 150 : 20);
    }
    return;
  }
  if (message.id === 9001 && message.result) {
    send({ method: "turn/completed", params: { threadId: "thread-alpha", turn: { id: "turn-thread-alpha", status: "completed", items: [], approvalDecision: message.result.decision } } });
    return;
  }
  if (["approval-string-alpha", "approval-global", "approval-resolved-alpha"].includes(message.id) && (message.result || message.error)) return;
  if (message.id !== undefined) send({ id: message.id, result: {} });
});
