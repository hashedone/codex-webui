import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexRequestBridge, abortOnHttpDisconnect } from "../codex-request.js";

describe("Codex request cancellation", () => {
  test("an already-aborted request sends nothing and creates no pending entry", async () => {
    const sent: any[] = [];
    const bridge = new CodexRequestBridge(message => sent.push(message));
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));

    await expect(bridge.request(1, "thread/turns/list", {}, { signal: controller.signal }))
      .rejects.toThrow("Already cancelled");
    expect(sent).toEqual([]);
    expect(bridge.pendingCount).toBe(0);
  });

  test("abort rejects and removes pending state before a late transport response", async () => {
    const sent: any[] = [];
    const bridge = new CodexRequestBridge(message => sent.push(message), { timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = bridge.request(7, "thread/turns/list", { threadId: "root" }, { signal: controller.signal });

    expect(bridge.pendingCount).toBe(1);
    controller.abort(new Error("Client disconnected"));
    await expect(pending).rejects.toThrow("Client disconnected");
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.handleResponse({ id: 7, result: { data: [] } })).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("HTTP response close aborts recap work and detaching removes the hooks", () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    const controller = new AbortController();
    const detach = abortOnHttpDisconnect(req, res, controller);

    res.emit("close");
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe("Agent recap client disconnected");

    const detached = new AbortController();
    const detachSecond = abortOnHttpDisconnect(req, res, detached);
    detachSecond();
    req.emit("aborted");
    expect(detached.signal.aborted).toBe(false);
    detach();
  });
});
