#!/usr/bin/env bun

import { basename } from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:19889/api/agents/snapshot";
const DEFAULT_TIMEOUT_SECONDS = "1.5";
const WORKING_ICON = "󰚩";
const WAITING_ICON = "󰅖";

type Task = {
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  status?: unknown;
  turnStatus?: unknown;
  activeFlags?: unknown;
  hierarchyContext?: unknown;
};

type Snapshot = {
  connected?: unknown;
  stale?: unknown;
  error?: unknown;
  tasks?: unknown;
};

export type WaybarOutput = {
  text: string;
  tooltip: string;
  class: string[];
};

type ClassifiedTask = {
  state: "working" | "waiting";
  project: string;
  title: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function projectName(cwd: unknown): string {
  const path = text(cwd).replace(/\/+$/, "");
  return path ? basename(path) || "local" : "local";
}

function classify(task: Task): ClassifiedTask | null {
  if (task.hierarchyContext === true) return null;

  const status = text(task.status);
  const turnStatus = text(task.turnStatus);
  const active = status === "active" || status === "inProgress" || turnStatus === "inProgress";
  const flags = Array.isArray(task.activeFlags) ? task.activeFlags : [];
  const waiting = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput");
  const attention = [status, turnStatus].some(value =>
    value === "completed" || value === "failed" || value === "interrupted"
  );

  let state: ClassifiedTask["state"] | null = null;
  if ((active && waiting) || attention) state = "waiting";
  else if (active) state = "working";
  if (!state) return null;

  return {
    state,
    project: projectName(task.cwd),
    title: text(task.title) || text(task.id) || "Untitled task",
  };
}

function taskLines(label: string, tasks: ClassifiedTask[]): string[] {
  if (!tasks.length) return [];
  return [
    `${label} (${tasks.length})`,
    ...tasks.map(task => `• ${escapeMarkup(task.project)} · ${escapeMarkup(task.title)}`),
  ];
}

export function formatSnapshot(snapshot: Snapshot): WaybarOutput {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const classified = tasks
    .filter((task): task is Task => task !== null && typeof task === "object")
    .map(classify)
    .filter((task): task is ClassifiedTask => task !== null);
  const waiting = classified.filter(task => task.state === "waiting");
  const working = classified.filter(task => task.state === "working");
  const stale = snapshot.stale === true || snapshot.connected === false;
  const classes = [
    ...(waiting.length ? ["waiting"] : []),
    ...(working.length ? ["working"] : []),
    ...(!waiting.length && !working.length ? ["idle"] : []),
    ...(stale ? ["stale"] : []),
  ];
  const lines = [
    ...taskLines("Waiting for attention", waiting),
    ...(waiting.length && working.length ? [""] : []),
    ...taskLines("Working", working),
  ];
  if (!lines.length) lines.push("No active agents");
  if (stale) lines.unshift("STALE — last known snapshot", "");
  const sourceError = text(snapshot.error);
  if (sourceError) lines.push("", `Source: ${escapeMarkup(sourceError)}`);

  return {
    text: `${WORKING_ICON} ${working.length}  ${WAITING_ICON} ${waiting.length}`,
    tooltip: lines.join("\n"),
    class: classes,
  };
}

export function formatOffline(error: unknown): WaybarOutput {
  const detail = error instanceof Error ? error.message : text(error) || "snapshot endpoint unavailable";
  return {
    text: `${WORKING_ICON} ?  ${WAITING_ICON} ?`,
    tooltip: `Agent status unavailable\n${escapeMarkup(detail.slice(0, 300))}`,
    class: ["offline"],
  };
}

async function readSnapshot(endpoint: string, timeoutSeconds: string): Promise<Snapshot> {
  const process = Bun.spawn([
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    timeoutSeconds,
    endpoint,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `curl exited with status ${exitCode}`);
  const value: unknown = JSON.parse(stdout);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("snapshot endpoint returned a non-object JSON value");
  }
  return value as Snapshot;
}

async function main(): Promise<void> {
  try {
    const endpoint = process.env.CODEX_WAYBAR_AGENT_ENDPOINT || DEFAULT_ENDPOINT;
    const timeoutSeconds = process.env.CODEX_WAYBAR_AGENT_TIMEOUT || DEFAULT_TIMEOUT_SECONDS;
    console.log(JSON.stringify(formatSnapshot(await readSnapshot(endpoint, timeoutSeconds))));
  } catch (error) {
    console.log(JSON.stringify(formatOffline(error)));
  }
}

if (import.meta.main) await main();
