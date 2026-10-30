import { describe, expect, test } from "bun:test";
import { DEFAULT_ENDPOINT, formatRateLimits, offlineWaybarOutput } from "../scripts/waybar-codex-usage";

describe("Waybar Codex usage formatter", () => {
  test("targets the installed local service by default", () => {
    expect(DEFAULT_ENDPOINT).toBe("http://127.0.0.1:19889/api/account/rate-limits");
  });

  test("selects the most-used active window and formats all windows", () => {
    const output = formatRateLimits({ limits: [
      { limitName: "Codex", windowKind: "primary", usedPercent: 71.6, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      { limitName: "Codex", windowKind: "secondary", usedPercent: 94, windowDurationMins: 10_080, resetsAt: 1_000 },
      { limitName: "Review", windowKind: "primary", usedPercent: 86, windowDurationMins: 1_440, resetsAt: 2_000_100_000 },
    ] }, 1_900_000_000);
    expect(output.text).toBe(" 86%");
    expect(output.class).toBe("warning");
    expect(output.percentage).toBe(86);
    expect(output.tooltip).toContain("Codex · primary 5h: 72% used");
    expect(output.tooltip).toContain("Codex · secondary 1w: 94% used");
    expect(output.tooltip).toContain("Review · primary 1d: 86% used");
  });

  test("uses normal and critical thresholds and has a stable offline shape", () => {
    expect(formatRateLimits({ limits: [{ usedPercent: 69, windowKind: "primary" }] }).class).toBe("normal");
    expect(formatRateLimits({ limits: [{ usedPercent: 90, windowKind: "primary" }] }).class).toBe("critical");
    expect(offlineWaybarOutput()).toEqual({ text: " --", tooltip: "Codex usage unavailable", class: "offline", percentage: 0 });
  });
});
