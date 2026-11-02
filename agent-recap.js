const FINAL_PHASE = "final_answer";
const RECENT_TURN_LIMIT = 6;
const SPOKEN_CHARACTER_LIMIT = 700;
const MAX_DESCENDANT_READS = 6;
const HISTORY_READ_CONCURRENCY = 4;
const ROOT_WITH_DESCENDANTS_LIMIT = 280;
const DESCENDANT_TOTAL_LIMIT = 360;

// Shape verified against Codex CLI 0.166.0 generated v2 schemas:
// ThreadTurnsListParams and ThreadTurnsListResponse (itemsView: "summary").

function cleanSpokenText(value) {
  return String(value)
    .replace(/<oai-[\s\S]*?<\/oai-[^>]+>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/:codex-[a-z-]+\{[^}]*\}/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[`*_~|]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim();
}

function boundSpokenText(value, limit = SPOKEN_CHARACTER_LIMIT) {
  const cleaned = cleanSpokenText(value);
  const characters = [...cleaned];
  if (characters.length <= limit) return cleaned;
  const prefix = characters.slice(0, limit - 1).join("");
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > limit * 0.8 ? boundary : undefined).trimEnd()}…`;
}

function recap(text) {
  return { text: boundSpokenText(text) };
}

function localThreadId(task) {
  return typeof task?.localId === "string" && task.localId ? task.localId : null;
}

function newestFinalAnswer(result) {
  if (!Array.isArray(result?.data)) return null;
  for (const turn of result.data) {
    if (turn?.status !== "completed" || !Array.isArray(turn.items)) continue;
    for (let index = turn.items.length - 1; index >= 0; index--) {
      const item = turn.items[index];
      if (item?.type === "agentMessage" && item.phase === FINAL_PHASE && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
    }
  }
  return null;
}

function isDescendant(task, rootId, byId) {
  let parentId = task?.parentId;
  const seen = new Set();
  while (typeof parentId === "string" && parentId && !seen.has(parentId)) {
    if (parentId === rootId) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Agent recap cancelled");
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

async function mapLimited(values, limit, fn) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index], index);
    }
  }));
  return results;
}

async function readNewestFinal(readTurns, task, signal) {
  if (signal?.aborted) throw abortReason(signal);
  const response = readTurns({
    threadId: localThreadId(task),
    limit: RECENT_TURN_LIMIT,
    sortDirection: "desc",
    itemsView: "summary",
  });
  return newestFinalAnswer(await withAbort(response, signal));
}

function descendantSections(results) {
  if (!results.length) return [];
  const sectionLimit = Math.floor(DESCENDANT_TOTAL_LIMIT / results.length);
  return results.map(({ task, result }) => {
    const title = boundSpokenText(task.title, 20);
    const label = `Wynik subagenta ${title}: `;
    const answerLimit = Math.max(20, sectionLimit - [...label].length);
    return `${label}${boundSpokenText(result, answerLimit)}`;
  });
}

export async function buildAgentRecap({ rootId, tasks, readTurns, signal }) {
  const root = tasks.find(task => task.id === rootId);
  if (!root) throw new Error("Agent recap root is unavailable");
  const byId = new Map(tasks.map(task => [task.id, task]));
  const descendants = tasks
    .filter(task => !task.hierarchyContext && !["active", "inProgress"].includes(task.status) && isDescendant(task, rootId, byId))
    .slice(0, MAX_DESCENDANT_READS);
  const requested = [root, ...descendants];
  const results = await mapLimited(requested, HISTORY_READ_CONCURRENCY, task => readNewestFinal(readTurns, task, signal));
  const answer = results[0];
  const completedDescendants = descendants
    .map((task, index) => ({ task, result: results[index + 1] }))
    .filter(item => item.result);
  const sections = descendantSections(completedDescendants);
  const suffix = sections.length ? ` ${sections.join(" ")}` : "";
  const rootAnswer = answer && sections.length ? boundSpokenText(answer, ROOT_WITH_DESCENDANTS_LIMIT) : answer;
  if (["active", "inProgress"].includes(root.status)) {
    return rootAnswer
      ? recap(`Agent nadal pracuje. Poprzedni wynik: ${rootAnswer}${suffix}`)
      : recap(`Agent nadal pracuje. Nie ma jeszcze ukończonego podsumowania.${suffix}`);
  }
  return recap(rootAnswer ? `${rootAnswer}${suffix}` : sections.join(" ") || "Brak ukończonego podsumowania dla tego agenta.");
}
