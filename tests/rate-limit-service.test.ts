import { describe, expect, test } from "bun:test";
import { createRateLimitLoader, normalizeRateLimits } from "../rate-limit-service";

describe("rate-limit service", () => {
  test("prefers per-limit snapshots and exposes only bounded window fields", () => {
    const result = normalizeRateLimits({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 72.5, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_900_100_000 },
          planType: "pro",
          credits: { balance: 500 },
        },
      },
      rateLimits: { limitId: "legacy", primary: { usedPercent: 99 } },
      rateLimitResetCredits: { credits: [{ id: "secret-credit" }] },
      accountId: "secret-account",
    }, 1_700_000_000_000);

    expect(result).toEqual({
      refreshedAt: "2023-11-14T22:13:20.000Z",
      limits: [
        { limitId: "codex", limitName: "Codex", windowKind: "primary", usedPercent: 72.5, windowDurationMins: 300, resetsAt: 1_900_000_000, planType: "pro" },
        { limitId: "codex", limitName: "Codex", windowKind: "secondary", usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_900_100_000, planType: "pro" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("credits");
  });

  test("falls back to the legacy snapshot, clamps values, and deduplicates", () => {
    const result = normalizeRateLimits({ rateLimits: {
      limitId: "legacy",
      primary: { usedPercent: 120, windowDurationMins: 60, resetsAt: 2_000_000_000 },
      secondary: { usedPercent: -5, windowDurationMins: null, resetsAt: null },
    } });
    expect(result.limits.map(limit => limit.usedPercent)).toEqual([100, 0]);
    expect(result.limits.every(limit => limit.limitId === "legacy")).toBe(true);
  });

  test("coalesces concurrent reads and caches successful results only", async () => {
    let now = 1_000;
    let calls = 0;
    const loader = createRateLimitLoader(async () => {
      calls++;
      return { rateLimits: { primary: { usedPercent: calls, windowDurationMins: 60, resetsAt: 2_000_000_000 } } };
    }, { ttlMs: 45_000, now: () => now });
    const [first, second] = await Promise.all([loader.get(), loader.get()]);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    expect((await loader.get()).limits[0].usedPercent).toBe(1);
    expect(calls).toBe(1);
    now += 45_001;
    expect((await loader.get()).limits[0].usedPercent).toBe(2);
    expect(calls).toBe(2);
  });
});
