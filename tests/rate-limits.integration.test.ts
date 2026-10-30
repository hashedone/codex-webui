import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const AUTHORIZATION = `Basic ${Buffer.from("codex:rate-limit-token").toString("base64")}`;
const processes: Array<ReturnType<typeof Bun.spawn>> = [];
const tempDirs: string[] = [];

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a test port"));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startServer(fail = false) {
  const port = await freePort();
  const fakeBin = mkdtempSync(join(tmpdir(), "codex-rate-limit-bin-"));
  tempDirs.push(fakeBin);
  const executable = join(fakeBin, "codex");
  writeFileSync(executable, `#!/bin/sh\nexec bun ${JSON.stringify(join(ROOT, "tests", "fixtures", "fake-codex-app-server.ts"))} "$@"\n`);
  chmodSync(executable, 0o755);
  const child = Bun.spawn({
    cmd: ["bun", "run", "server.ts"],
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_WEBUI_ACCESS_TOKEN: "rate-limit-token",
      CODEX_WEBUI_TEST_RATE_LIMIT_FAILURE: fail ? "1" : "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  processes.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${base}/api/health`, { headers: { authorization: AUTHORIZATION } });
      if (health.ok && (await health.json()).codex) return base;
    } catch { /* Server is still starting. */ }
    await Bun.sleep(20);
  }
  throw new Error("Rate-limit test server did not start");
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    child.kill("SIGTERM");
    await child.exited;
  }
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("rate-limit HTTP endpoint", () => {
  test("applies auth and GET semantics, sanitizes the response, and serves its cache", async () => {
    const base = await startServer();
    const endpoint = `${base}/api/account/rate-limits`;
    const unauthorized = await fetch(endpoint, { headers: { host: "codex.example.test", "x-forwarded-for": "192.0.2.1" } });
    expect(unauthorized.status).toBe(401);

    const method = await fetch(endpoint, { method: "POST", headers: { authorization: AUTHORIZATION } });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");

    const first = await fetch(endpoint, { headers: { authorization: AUTHORIZATION } });
    const firstBody = await first.json();
    const second = await fetch(endpoint, { headers: { authorization: AUTHORIZATION } });
    const secondBody = await second.json();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(firstBody).toEqual(secondBody);
    expect(firstBody.limits).toHaveLength(2);
    expect(firstBody.limits[0].usedPercent).toBe(75);
    expect(firstBody.limits.some((limit: any) => limit.limitId === "legacy-must-not-win")).toBe(false);
    expect(JSON.stringify(firstBody)).not.toContain("must-not-leak");
  }, 10_000);

  test("returns a stable retryable error when app-server cannot provide usage", async () => {
    const base = await startServer(true);
    const response = await fetch(`${base}/api/account/rate-limits`, { headers: { authorization: AUTHORIZATION } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "rate_limits_unavailable", message: "Codex rate limits are unavailable" } });
  }, 10_000);
});
