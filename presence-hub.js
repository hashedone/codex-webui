const WEBUI_SOURCE = Object.freeze({ id: "webui", label: "Codex WebUI", kind: "app-server", monitorOnly: false });

function health(id, label, snapshot) {
  return { id, label, connected: snapshot.connected !== false, stale: !!snapshot.stale,
    refreshedAt: snapshot.refreshedAt ?? null, error: snapshot.error || null };
}

function qualifyWebui(task) {
  return { ...task, id: `${WEBUI_SOURCE.id}:${task.id}`, localId: task.id, sourceId: WEBUI_SOURCE.id, source: WEBUI_SOURCE,
    parentId: task.parentId ? `${WEBUI_SOURCE.id}:${task.parentId}` : null };
}

export class PresenceHub {
  constructor({ webui, local }) { this.webui = webui; this.local = local; }
  async read(webuiConnected) {
    const [webui, local] = await Promise.all([this.webui.read(webuiConnected), this.local.read()]);
    const sources = [health(WEBUI_SOURCE.id, WEBUI_SOURCE.label, webui), health(local.source?.id || "codex-local", local.source?.label || "Codex Desktop / local", local)];
    const refreshed = sources.map(source => source.refreshedAt).filter(Number.isFinite);
    return {
      scope: "presence-hub", connected: sources.some(source => source.connected), stale: sources.every(source => source.stale),
      refreshedAt: refreshed.length ? Math.max(...refreshed) : null,
      error: sources.filter(source => source.error).map(source => `${source.label}: ${source.error}`).join("; ") || null,
      sources, tasks: [...webui.tasks.map(qualifyWebui), ...local.tasks],
    };
  }
}

export { WEBUI_SOURCE };
