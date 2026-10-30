import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatOffline, formatSnapshot } from "../scripts/waybar-agent-presence";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "waybar-agent-presence");

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(fixtureDirectory, `${name}.json`), "utf8"));
}

describe("Waybar agent presence formatter", () => {
  test("counts roots and subagents, prioritizes waits, and excludes hierarchy context", async () => {
    const output = formatSnapshot(await fixture("mixed"));

    expect(output.text).toBe("󰚩 2  󰅖 3");
    expect(output.class).toEqual(["waiting", "working"]);
    expect(output.tooltip).toStartWith("Waiting for attention (3)");
    expect(output.tooltip.indexOf("Waiting for attention")).toBeLessThan(output.tooltip.indexOf("Working (2)"));
    expect(output.tooltip).toContain("brain · Approve &amp; merge");
    expect(output.tooltip).toContain("brain · Inspect &lt;API&gt;");
    expect(output.tooltip).not.toContain("Old completed ancestor");
    expect(output.tooltip).not.toContain("Idle thread");
  });

  test("keeps last-known counts but exposes snapshot staleness as a class", async () => {
    const output = formatSnapshot(await fixture("stale"));

    expect(output.text).toBe("󰚩 1  󰅖 0");
    expect(output.class).toEqual(["working", "stale"]);
    expect(output.tooltip).toContain("STALE — last known snapshot");
    expect(output.tooltip).toContain("Source: Codex local source delayed");
  });

  test("ignores idle and unloaded tasks", async () => {
    const output = formatSnapshot(await fixture("idle"));

    expect(output.text).toBe("󰚩 0  󰅖 0");
    expect(output.class).toEqual(["idle"]);
    expect(output.tooltip).toBe("No active agents");
  });

  test("returns valid, safely escaped offline JSON data", async () => {
    const input = await fixture("offline");
    const output = formatOffline(new Error(String(input.error)));

    expect(output.class).toEqual(["offline"]);
    expect(output.text).toBe("󰚩 ?  󰅖 ?");
    expect(output.tooltip).toContain("curl failed &lt;offline&gt; &amp; retry");
    expect(() => JSON.parse(JSON.stringify(output))).not.toThrow();
  });
});
