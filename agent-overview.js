// Protocol fields verified against codex-cli 0.154.0; see docs/agent-command-center.md.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const text = value => typeof value === 'string' ? value : '';
export function summarizeThread(thread) {
  if (!thread || !text(thread.id)) throw new Error('Invalid thread metadata');
  const spawn = thread.source?.subAgent?.thread_spawn;
  const parentId = text(thread.parentThreadId) || text(spawn?.parent_thread_id) || null;
  const internal = thread.source && typeof thread.source === 'object' && 'subAgent' in thread.source;
  return {
    id: thread.id, parentId, title: (text(thread.name) || text(thread.agentNickname) || text(thread.preview) || thread.id).slice(0, 200),
    cwd: text(thread.cwd), role: text(thread.agentRole) || text(spawn?.agent_role),
    agentPath: text(spawn?.agent_path),
    kind: parentId ? (thread.canAcceptDirectInput === true ? 'delegated' : thread.canAcceptDirectInput === false ? 'internal' : 'descendant') : internal ? 'internal' : 'root',
    canAcceptDirectInput: typeof thread.canAcceptDirectInput === 'boolean' ? thread.canAcceptDirectInput : null,
    status: ['idle', 'active', 'notLoaded', 'systemError'].includes(thread.status?.type) ? thread.status.type : 'unknown',
    activeFlags: (Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : []).filter(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)),
    updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt * 1000 : null,
  };
}

async function pages(request, method, params) {
  const data = [], cursors = new Set();
  let cursor;
  do {
    const result = await request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw new Error(`${method} unavailable: invalid inventory response`);
    data.push(...result.data);
    cursor = result.nextCursor;
    if (cursor != null && typeof cursor !== 'string') throw new Error('Invalid inventory cursor');
    if (cursor && cursors.has(cursor)) throw new Error('Inventory pagination did not advance');
    if (data.length > 2000 || cursors.size >= 100) throw new Error('Inventory limit reached; overview is incomplete');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return data;
}
async function mapLimited(values, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (next < values.length) await fn(values[next++]);
  }));
}

export class AgentOverview {
  constructor(request, now = Date.now) {
    this.request = request; this.now = now; this.reset();
  }
  reset() {
    this.epoch = (this.epoch || 0) + 1;
    this.rows = new Map(); this.activity = new Map(); this.revisions = new Map(); this.patches = new Map(); this.removed = new Set();
    this.refreshedAt = null; this.attemptedAt = null; this.error = null; this.inFlight = null;
  }
  observe(method, params = {}) {
    const id = text(params.threadId) || text(params.thread?.id);
    if (!id) return;
    if (method === 'thread/archived' || method === 'thread/deleted') {
      this.rows.delete(id); this.activity.delete(id); this.patches.delete(id); this.removed.add(id); this.revisions.set(id, (this.revisions.get(id) || 0) + 1); return;
    }
    if (method === 'thread/started' && params.thread) { this.removed.delete(id); const started = summarizeThread(params.thread); this.rows.set(id, started); this.patches.set(id, started); }
    const row = this.rows.get(id);
    if (method === 'thread/status/changed') {
      const status = summarizeThread({ id, status: params.status });
      const patch = { status: status.status, activeFlags: status.activeFlags };
      this.patches.set(id, { ...this.patches.get(id), ...patch });
      if (row) this.rows.set(id, { ...row, ...patch });
    }
    if (method === 'thread/closed') {
      const patch = { status: 'notLoaded', activeFlags: [], canAcceptDirectInput: null };
      this.patches.set(id, { ...this.patches.get(id), ...patch });
      if (row) this.rows.set(id, { ...row, ...patch });
    }
    if (method === 'thread/name/updated' && text(params.threadName)) {
      const patch = { title: params.threadName.slice(0, 200) };
      this.patches.set(id, { ...this.patches.get(id), ...patch });
      if (row) this.rows.set(id, { ...row, ...patch });
    }
    const labels = {
      'thread/started': 'Task created', 'turn/started': 'Turn started',
      'turn/completed': `Turn ${['completed', 'failed', 'interrupted'].includes(params.turn?.status) ? params.turn.status : 'finished'}`,
      'item/started': 'Activity started', 'item/completed': 'Activity finished',
      'item/agentMessage/delta': 'Agent responding', 'thread/status/changed': 'Status changed',
      'thread/closed': 'Task unloaded', 'thread/name/updated': 'Task renamed',
    };
    if (labels[method]) {
      this.activity.set(id, { at: this.now(), label: labels[method] });
      this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    }
  }
  snapshot(connected = true) {
    return { scope: 'dashboard-app-server', connected, stale: !connected || !!this.error || !this.refreshedAt,
      refreshedAt: this.refreshedAt, error: this.error,
      tasks: [...this.rows.values()].map(row => ({ ...row,
        lastActivity: this.activity.get(row.id) || { at: row.updatedAt, label: 'Thread updated (server timestamp)' },
      })),
    };
  }
  async read(connected) {
    if (!connected) return this.snapshot(false);
    if (!this.inFlight && (this.attemptedAt === null || this.now() - this.attemptedAt >= 1500)) {
      const epoch = this.epoch;
      this.attemptedAt = this.now();
      this.inFlight = this.refresh(epoch).catch(error => {
        if (epoch === this.epoch) this.error = error.message;
      }).finally(() => { if (epoch === this.epoch) this.inFlight = null; });
    }
    await this.inFlight;
    return this.snapshot(connected);
  }
  async refresh(epoch) {
    const revisions = new Map(this.revisions);
    const loaded = await pages(this.request, 'thread/loaded/list', {});
    if (loaded.some(id => !text(id))) throw new Error('Invalid loaded thread id');
    const candidates = new Map([...this.rows].map(([id, row]) => [id, { ...row, status: 'notLoaded', activeFlags: [], canAcceptDirectInput: null }]));
    await mapLimited([...new Set(loaded)], async id => {
      const result = await this.request('thread/read', { threadId: id, includeTurns: false });
      const row = summarizeThread(result.thread);
      if (row.id !== id) throw new Error('Thread inventory identity mismatch');
      candidates.set(id, row);
    });
    // Query explicit ancestry only; never pull unrelated stored/Desktop threads into this scope.
    const anchors = [...candidates.values()].filter(row => !row.parentId || !candidates.has(row.parentId));
    await mapLimited(anchors, async row => {
      const descendants = await pages(this.request, 'thread/list', { ancestorThreadId: row.id, sourceKinds: SOURCE_KINDS });
      for (const thread of descendants) {
        const child = summarizeThread(thread);
        if (!child.parentId) throw new Error('Descendant inventory omitted parent relationship');
        if (!loaded.includes(child.id)) candidates.set(child.id, child);
      }
    });
    if (candidates.size > 2000) throw new Error('Inventory limit reached; overview is incomplete');
    if (epoch !== this.epoch) return;
    // Notifications arriving during discovery win over an older metadata response.
    for (const [id, revision] of this.revisions) {
      if (revision === revisions.get(id)) continue;
      if (this.removed.has(id)) candidates.delete(id);
      else if (candidates.has(id) || this.rows.has(id)) candidates.set(id, { ...(candidates.get(id) || this.rows.get(id)), ...this.patches.get(id) });
    }
    this.rows = candidates;
    for (const id of this.activity.keys()) if (!this.rows.has(id)) this.activity.delete(id);
    this.patches.clear(); this.removed.clear();
    this.refreshedAt = this.now(); this.error = null;
  }
}
