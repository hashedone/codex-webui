import { createInterface } from "node:readline";

const threads = new Map([
  ["thread-alpha", { id: "thread-alpha", name: "Alpha", cwd: process.cwd(), source: "local", turns: [] }],
  ["thread-beta", { id: "thread-beta", name: "Beta", cwd: process.cwd(), source: "local", turns: [] }],
]);

function send(message: any) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: "/tmp/codex-webui-fake-home" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: threads.get(message.params.threadId) } });
    return;
  }
  if (message.method === "turn/start") {
    const { threadId } = message.params;
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
