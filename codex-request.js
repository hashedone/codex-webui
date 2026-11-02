function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Codex request cancelled");
}

export class CodexRequestBridge {
  #send;
  #timeoutMs;
  #pending = new Map();

  constructor(send, { timeoutMs = 30_000 } = {}) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  request(id, method, params = {}, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        this.#pending.delete(id);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onAbort = () => finish(reject, abortReason(signal));
      timer = setTimeout(
        () => finish(reject, new Error(`Codex request timed out: ${method}`)),
        this.#timeoutMs,
      );
      this.#pending.set(id, {
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleResponse(message) {
    if (message?.id === undefined || (!("result" in message) && !("error" in message))) return false;
    const item = this.#pending.get(Number(message.id));
    if (!item) return false;
    if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else item.resolve(message.result);
    return true;
  }

  rejectAll(error) {
    for (const item of [...this.#pending.values()]) item.reject(error);
  }
}

export function abortOnHttpDisconnect(req, res, controller) {
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Agent recap client disconnected"));
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return () => {
    req.off("aborted", abort);
    res.off("close", abort);
  };
}
