import { describe, expect, test } from "bun:test";
import { buildAgentRecap } from "../agent-recap.js";

const task = (id: string, overrides = {}) => ({
  id,
  localId: id.replace(/^[^:]+:/, ""),
  sourceId: id.split(":", 1)[0],
  parentId: null,
  title: "Desktop update",
  status: "completed",
  activeFlags: [],
  ...overrides,
});

describe("spoken agent recap", () => {
  test("speaks the newest completed final answer for a completed root", async () => {
    const calls: Array<{ threadId: string; limit: number; sortDirection: string; itemsView: string }> = [];
    const recap = await buildAgentRecap({
      rootId: "codex-local:root",
      tasks: [task("codex-local:root")],
      readTurns: async params => {
        calls.push(params);
        return {
          data: [
            { id: "new", status: "completed", items: [
              { id: "answer", type: "agentMessage", phase: "final_answer", text: "ChatGPT Desktop updated. Restart is required." },
            ] },
          ],
        };
      },
    });

    expect(recap.text).toBe("ChatGPT Desktop updated. Restart is required.");
    expect(calls).toEqual([{ threadId: "root", limit: 6, sortDirection: "desc", itemsView: "summary" }]);
  });

  test("labels a completed answer as previous while the root is active", async () => {
    const recap = await buildAgentRecap({
      rootId: "webui:root",
      tasks: [task("webui:root", { status: "active" })],
      readTurns: async () => ({ data: [
        { id: "current", status: "inProgress", items: [
          { id: "reasoning", type: "reasoning", summary: ["Secret chain of thought"] },
          { id: "user", type: "userMessage", content: [{ type: "text", text: "Secret user prompt" }] },
          { id: "tool", type: "commandExecution", command: "secret-tool" },
          { id: "commentary", type: "agentMessage", phase: "commentary", text: "Still investigating" },
        ] },
        { id: "previous", status: "completed", items: [
          { id: "answer", type: "agentMessage", phase: "final_answer", text: "The previous migration finished." },
        ] },
      ] }),
    });

    expect(recap.text).toBe("Agent nadal pracuje. Poprzedni wynik: The previous migration finished.");
    expect(recap.text).not.toContain("Secret");
    expect(recap.text).not.toContain("Still investigating");
  });

  test("includes an unpulled completed descendant result and ignores unrelated tasks", async () => {
    const calls: string[] = [];
    const recap = await buildAgentRecap({
      rootId: "codex-local:root",
      tasks: [
        task("codex-local:root"),
        task("codex-local:child", { parentId: "codex-local:root", title: "Package verifier" }),
        task("codex-local:other", { title: "Unrelated" }),
      ],
      readTurns: async params => {
        calls.push(params.threadId);
        return { data: [{ id: `turn-${params.threadId}`, status: "completed", items: [
          { id: `answer-${params.threadId}`, type: "agentMessage", phase: "final_answer", text: params.threadId === "root" ? "Desktop is updated." : "All package signatures are valid." },
        ] }] };
      },
    });

    expect(recap.text).toBe("Desktop is updated. Wynik subagenta Package verifier: All package signatures are valid.");
    expect(calls).toEqual(["root", "child"]);
  });

  test("reads an idle WebUI descendant because final-turn history determines completion", async () => {
    const recap = await buildAgentRecap({
      rootId: "webui:root",
      tasks: [
        task("webui:root"),
        task("webui:idle-child", { parentId: "webui:root", title: "Idle verifier", status: "idle" }),
      ],
      readTurns: async ({ threadId }) => ({ data: [{ id: `turn-${threadId}`, status: "completed", items: [
        { id: `answer-${threadId}`, type: "agentMessage", phase: "final_answer", text: `${threadId} final result.` },
      ] }] }),
    });

    expect(recap.text).toContain("Wynik subagenta Idle verifier: idle-child final result.");
  });

  test("starts root and descendant history reads concurrently", async () => {
    const calls: string[] = [];
    const releases = new Map<string, (value: any) => void>();
    const pending = buildAgentRecap({
      rootId: "codex-local:root",
      tasks: [
        task("codex-local:root"),
        task("codex-local:child", { parentId: "codex-local:root", title: "Verifier" }),
      ],
      readTurns: ({ threadId }) => new Promise(resolve => {
        calls.push(threadId);
        releases.set(threadId, resolve);
      }),
    });

    await Bun.sleep(0);
    expect(calls).toEqual(["root", "child"]);
    for (const [threadId, release] of releases) release({ data: [{ id: `turn-${threadId}`, status: "completed", items: [
      { id: `answer-${threadId}`, type: "agentMessage", phase: "final_answer", text: `${threadId} result.` },
    ] }] });
    expect((await pending).text).toContain("child result.");
  });

  test("bounds descendant reads and runs at most four history requests concurrently", async () => {
    const calls: string[] = [];
    let releases: Array<(value: any) => void> = [];
    const pending = buildAgentRecap({
      rootId: "webui:root",
      tasks: [task("webui:root"), ...Array.from({ length: 12 }, (_, index) => task(`webui:child-${index}`, { parentId: "webui:root", title: `Child ${index}` }))],
      readTurns: ({ threadId }) => new Promise(resolve => {
        calls.push(threadId);
        releases.push(resolve);
      }),
    });

    await Bun.sleep(0);
    expect(calls).toHaveLength(4);
    const firstWave = releases; releases = [];
    firstWave.forEach(release => release({ data: [] }));
    await Bun.sleep(0);
    expect(calls).toHaveLength(7);
    releases.forEach(release => release({ data: [] }));
    await pending;
  });

  test("stops waiting at the caller deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Agent recap deadline exceeded")), 10);
    const pending = buildAgentRecap({
      rootId: "webui:root",
      tasks: [task("webui:root")],
      signal: controller.signal,
      readTurns: () => new Promise(() => {}),
    }).then(() => "resolved", error => error.message);

    expect(await Promise.race([pending, Bun.sleep(100).then(() => "hung")])).toBe("Agent recap deadline exceeded");
  });

  test("issues zero history RPCs when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));
    let calls = 0;
    const pending = buildAgentRecap({
      rootId: "webui:root",
      tasks: [task("webui:root")],
      signal: controller.signal,
      readTurns: async () => { calls++; return { data: [] }; },
    });

    expect(pending).rejects.toThrow("Already cancelled");
    await pending.catch(() => {});
    expect(calls).toBe(0);
  });

  test("uses an explicit no-recap fallback instead of lifecycle or non-final text", async () => {
    const recap = await buildAgentRecap({
      rootId: "webui:root",
      tasks: [task("webui:root", { status: "active" })],
      readTurns: async () => ({ data: [{ id: "turn", status: "inProgress", items: [
        { id: "commentary", type: "agentMessage", phase: "commentary", text: "Turn completed" },
      ] }] }),
    });

    expect(recap.text).toBe("Agent nadal pracuje. Nie ma jeszcze ukończonego podsumowania.");
    expect(recap.text).not.toContain("Turn completed");
  });

  test("keeps the active-root status explicit when only a descendant has a result", async () => {
    const recap = await buildAgentRecap({
      rootId: "webui:root",
      tasks: [
        task("webui:root", { status: "active" }),
        task("webui:child", { parentId: "webui:root", title: "Verifier" }),
      ],
      readTurns: async ({ threadId }) => ({ data: threadId === "root" ? [] : [{ id: "turn", status: "completed", items: [
        { id: "answer", type: "agentMessage", phase: "final_answer", text: "Checks passed." },
      ] }] }),
    });

    expect(recap.text).toBe("Agent nadal pracuje. Nie ma jeszcze ukończonego podsumowania. Wynik subagenta Verifier: Checks passed.");
  });

  test("sanitizes presentation markup and bounds the spoken output", async () => {
    const noisy = `# Done\n\n- Updated **desktop** at [OpenAI](https://openai.com).\n\n\`\`\`bash\nprintf secret-tool-output\n\`\`\`\n\n:codex-file-citation{path="/secret/file" purpose="output"}\n<oai-mem-citation>private citation</oai-mem-citation>\n${"Verified package integrity. ".repeat(80)}`;
    const recap = await buildAgentRecap({
      rootId: "codex-local:root",
      tasks: [task("codex-local:root")],
      readTurns: async () => ({ data: [{ id: "turn", status: "completed", items: [
        { id: "answer", type: "agentMessage", phase: "final_answer", text: noisy },
      ] }] }),
    });

    expect(recap.text).toStartWith("Done Updated desktop at OpenAI.");
    expect(recap.text).not.toMatch(/https?:|secret-tool|codex-file|oai-mem|[*#`<>]/);
    expect([...recap.text].length).toBeLessThanOrEqual(700);
    expect(recap.text.endsWith("…")).toBe(true);
  });

  test("reserves audible space for a completed descendant when the root result is long", async () => {
    const recap = await buildAgentRecap({
      rootId: "codex-local:root",
      tasks: [
        task("codex-local:root"),
        task("codex-local:child", { parentId: "codex-local:root", title: "Critical verifier" }),
      ],
      readTurns: async ({ threadId }) => ({ data: [{ id: `turn-${threadId}`, status: "completed", items: [
        { id: `answer-${threadId}`, type: "agentMessage", phase: "final_answer", text: threadId === "root" ? "Long root detail. ".repeat(100) : "DESCENDANT CHECK PASSED." },
      ] }] }),
    });

    expect(recap.text).toContain("Wynik subagenta Critical verifier: DESCENDANT CHECK PASSED.");
    expect([...recap.text].length).toBeLessThanOrEqual(700);
  });
});
