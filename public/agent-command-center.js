// Reading a task must not acquire a writer or pretend unsupported history is empty.
export async function readTaskForOpen(rpc, threadId) {
  try { return await rpc('thread/read', { threadId, includeTurns: true }); }
  catch (historyError) {
    const result = await rpc('thread/read', { threadId, includeTurns: false });
    if (!result?.thread?.id) throw historyError;
    return { ...result, historyError: historyError.message || 'History unavailable' };
  }
}
const kindLabels = { root: 'Root task', delegated: 'Delegated task', internal: 'Internal agent', descendant: 'Descendant · input unknown' };
export function statusLabel(task) {
  if (task.status === 'active') {
    const activeFlags = task.activeFlags || [];
    if (activeFlags.includes('waitingOnApproval')) return 'Awaiting approval';
    if (activeFlags.includes('waitingOnUserInput')) return 'Awaiting input';
    return 'Working';
  }
  return { completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', idle: 'Idle', notLoaded: 'Not loaded', systemError: 'System error', unknown: 'Unknown' }[task.status] || 'Unknown';
}
const defaultSource = { id: 'webui', label: 'WebUI', kind: 'app-server', monitorOnly: false };
const taskSource = task => task.source && typeof task.source === 'object' ? { ...defaultSource, ...task.source } : defaultSource;
const sourceHealthLabel = source => source.stale ? 'Stale' : !source.connected ? 'Unavailable' : 'Live';
export function orderedTasks(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map();
  for (const task of byId.values()) {
    const key = task.parentId && byId.has(task.parentId) ? task.parentId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(task);
  }
  const rank = task => task.status === 'active' ? 0 : task.status === 'systemError' ? 1 : 2;
  for (const group of children.values()) group.sort((a, b) => rank(a) - rank(b) || (b.lastActivity?.at || 0) - (a.lastActivity?.at || 0) || a.id.localeCompare(b.id));
  const result = [], visited = new Set();
  const visit = (task, depth) => {
    if (visited.has(task.id)) return;
    visited.add(task.id); result.push({ task, depth });
    for (const child of children.get(task.id) || []) visit(child, depth + 1);
  };
  for (const task of children.get(null) || []) visit(task, 0);
  // Keep malformed/cyclic metadata visible, without an infinite traversal.
  for (const task of byId.values()) visit(task, 0);
  return result;
}
const node = (tag, className, text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
export function createCommandCenter({ rpc, openThread, isConnected, onShow = () => {} }) {
  const panel = document.querySelector('#agentCommandCenter');
  const list = panel.querySelector('.cc-tasks');
  const health = panel.querySelector('.cc-health');
  const sources = panel.querySelector('.cc-sources');
  const search = panel.querySelector('input');
  const filter = panel.querySelector('select');
  let visible = false, timer = null, inFlight = false, snapshot = null, error = '', generation = 0;
  function render() {
    const disconnected = !navigator.onLine || !isConnected();
    const stale = disconnected || snapshot?.stale || !!error;
    health.dataset.stale = String(stale);
    health.textContent = error || (disconnected ? 'Disconnected · last known data' : snapshot?.error ? `Presence partially unavailable · ${snapshot.error}` : !snapshot ? 'Discovering tasks…' : stale ? `Last known presence · checked ${new Date(snapshot.refreshedAt).toLocaleTimeString()}` : `Live · checked ${new Date(snapshot.refreshedAt).toLocaleTimeString()}`);
    const tasks = snapshot?.tasks || [];
    const snapshotSources = snapshot?.sources || (snapshot ? [{ ...defaultSource, connected: snapshot.connected !== false, stale: !!snapshot.stale, refreshedAt: snapshot.refreshedAt, error: snapshot.error }] : []);
    const sourceById = new Map(snapshotSources.map(source => [source.id, source]));
    sources.replaceChildren();
    for (const source of snapshotSources) {
      const item = node('div', 'cc-source');
      item.dataset.health = source.stale ? 'stale' : !source.connected ? 'unavailable' : 'live';
      item.append(node('span', 'cc-source-dot'), node('strong', '', source.label || source.id), node('span', '', sourceHealthLabel(source)));
      if (source.error) { const detail = node('small', '', source.error); detail.title = source.error; item.append(detail); }
      sources.append(item);
    }
    panel.querySelector('.cc-counts').textContent = `${tasks.filter(t => t.status === 'active').length} working  /  ${tasks.filter(t => t.kind === 'root').length} roots  /  ${tasks.filter(t => t.kind !== 'root').length} descendants`;
    const query = search.value.trim().toLowerCase();
    const matches = task => (!query || [task.title, task.id, task.localId, task.cwd, task.role, task.agentPath, taskSource(task).label].join(' ').toLowerCase().includes(query)) && (filter.value === 'all' || (filter.value === 'active' ? task.status === 'active' : task.kind !== 'root'));
    const included = new Set(tasks.filter(matches).map(task => task.id));
    const byId = new Map(tasks.map(task => [task.id, task]));
    // Retain ancestors as context when filtering to a working descendant.
    for (const id of [...included]) {
      const seen = new Set([id]); let parent = byId.get(id)?.parentId;
      while (parent && byId.has(parent) && !seen.has(parent)) { included.add(parent); seen.add(parent); parent = byId.get(parent).parentId; }
    }
    const focusId = document.activeElement?.dataset?.taskId;
    list.replaceChildren();
    for (const { task, depth } of orderedTasks(tasks)) {
      if (!included.has(task.id)) continue;
      const row = node('article', 'cc-task'); row.dataset.taskId = task.id;
      const source = taskSource(task); const sourceHealth = sourceById.get(task.sourceId || source.id);
      row.dataset.sourceId = task.sourceId || source.id; row.dataset.monitorOnly = String(!!source.monitorOnly);
      row.style.setProperty('--depth', Math.min(depth, 6));
      const identity = node('div', 'cc-identity');
      const eyebrow = node('div', 'cc-kind', `${depth ? '↳ ' : ''}${source.label} · ${kindLabels[task.kind] || 'Task'}${task.role ? ` · ${task.role}` : ''}`);
      const title = node('h2', '', task.title); title.title = task.id;
      const path = node('div', 'cc-path', task.cwd || 'Workspace not reported'); path.title = task.cwd;
      identity.append(eyebrow, title, path);
      if (task.parentId) identity.append(node('div', 'cc-parent', `Parent: ${byId.get(task.parentId)?.title || task.parentId}${byId.has(task.parentId) ? '' : ' (outside inventory)'}`));
      const state = node('div', 'cc-state'); const badge = node('span', 'cc-badge', statusLabel(task)); badge.dataset.status = task.status || 'unknown';
      state.append(badge, node('small', '', source.monitorOnly ? `Monitor only${sourceHealth?.stale ? ' · stale source' : ''}` : task.canAcceptDirectInput === true ? 'Direct input available' : task.canAcceptDirectInput === false ? 'Read only · agent controlled' : 'Input capability unknown'));
      const activity = node('div', 'cc-activity', task.lastActivity?.label || 'Activity not reported');
      const at = task.lastActivity?.at;
      const time = node('time', '', Number.isFinite(at) ? new Date(at).toLocaleString() : 'Time not reported');
      if (Number.isFinite(at)) time.dateTime = new Date(at).toISOString(); activity.append(time);
      let action;
      if (source.monitorOnly) {
        action = node('span', 'cc-monitor-only', 'Monitor only');
        action.setAttribute('aria-label', `${task.title} is monitor only`);
      } else {
        action = node('button', 'cc-open', 'Open task'); action.type = 'button'; action.dataset.taskId = task.id;
        action.setAttribute('aria-label', `Open task: ${task.title}`);
        action.onclick = async () => {
          action.disabled = true;
          try {
            const opened = await openThread(task.localId || task.id, { id: task.localId || task.id, name: task.title, cwd: task.cwd });
            if (opened) show(false);
            else { error = 'Could not open task. The overview remains available; try again.'; render(); }
          } catch (reason) { error = reason.message; render(); }
          finally { action.disabled = false; }
        };
      }
      row.append(identity, state, activity, action); list.append(row);
    }
    if (!list.children.length) list.append(node('p', 'cc-empty', !snapshot || disconnected ? 'Task inventory is not available yet. Retry after the connection recovers.' : tasks.length ? 'No tasks match these filters.' : 'No agents reported by the connected presence sources.'));
    if (focusId) [...list.querySelectorAll('button')].find(button => button.dataset.taskId === focusId)?.focus({ preventScroll: true });
  }
  async function refresh() {
    clearTimeout(timer);
    if (!visible || inFlight) return;
    inFlight = true; const current = generation;
    try {
      if (navigator.onLine && isConnected()) {
        let deadline;
        const next = await Promise.race([
          rpc('host/agents/list'),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Inventory request timed out')), 10000); }),
        ]).finally(() => clearTimeout(deadline));
        if (current === generation) { snapshot = next; error = ''; }
      }
    } catch (reason) { if (current === generation) error = `Updates paused · ${reason.message}`; }
    finally { inFlight = false; if (visible) { render(); timer = setTimeout(refresh, document.hidden ? 8000 : 2000); } }
  }
  function show(value) {
    visible = value; generation++; panel.hidden = !value;
    document.body.classList.toggle('command-center-open', value);
    document.querySelector('#showCommandCenter').setAttribute('aria-pressed', String(value));
    const url = new URL(location.href); if (value) url.searchParams.set('view', 'agents'); else url.searchParams.delete('view');
    history.replaceState(null, '', url);
    clearTimeout(timer);
    if (value) { onShow(); render(); void refresh(); panel.querySelector('h1').focus(); }
  }
  search.addEventListener('input', render); filter.addEventListener('change', render);
  panel.querySelector('.cc-refresh').onclick = () => void refresh();
  document.querySelector('#showCommandCenter').onclick = () => show(!visible);
  window.addEventListener('offline', () => { if (visible) render(); });
  window.addEventListener('online', () => { if (visible) void refresh(); });
  document.addEventListener('visibilitychange', () => { if (visible && !document.hidden) void refresh(); });
  return { show, refresh, get visible() { return visible; } };
}
