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
    if (task.activeFlags.includes('waitingOnApproval')) return 'Awaiting approval';
    if (task.activeFlags.includes('waitingOnUserInput')) return 'Awaiting input';
    return 'Working';
  }
  return { idle: 'Idle', notLoaded: 'Not loaded', systemError: 'System error', unknown: 'Unknown' }[task.status] || 'Unknown';
}
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
  const search = panel.querySelector('input');
  const filter = panel.querySelector('select');
  let visible = false, timer = null, inFlight = false, snapshot = null, error = '', generation = 0;
  function render() {
    const stale = !navigator.onLine || !isConnected() || snapshot?.stale || !!error;
    health.dataset.stale = String(stale);
    health.textContent = error || (!navigator.onLine || !isConnected() ? 'Disconnected · last known data' : snapshot?.error ? `Overview unavailable · ${snapshot.error}` : !snapshot ? 'Discovering tasks…' : stale ? 'Waiting for a fresh inventory' : `Live · checked ${new Date(snapshot.refreshedAt).toLocaleTimeString()}`);
    const tasks = snapshot?.tasks || [];
    panel.querySelector('.cc-counts').textContent = `${tasks.filter(t => t.status === 'active').length} active  /  ${tasks.filter(t => t.kind === 'root').length} roots  /  ${tasks.filter(t => t.kind !== 'root').length} descendants`;
    const query = search.value.trim().toLowerCase();
    const matches = task => (!query || [task.title, task.id, task.cwd, task.role, task.agentPath].join(' ').toLowerCase().includes(query)) && (filter.value === 'all' || (filter.value === 'active' ? task.status === 'active' : task.kind !== 'root'));
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
      row.style.setProperty('--depth', Math.min(depth, 6));
      const identity = node('div', 'cc-identity');
      const eyebrow = node('div', 'cc-kind', `${depth ? '↳ ' : ''}${kindLabels[task.kind] || 'Task'}${task.role ? ` · ${task.role}` : ''}`);
      const title = node('h2', '', task.title); title.title = task.id;
      const path = node('div', 'cc-path', task.cwd || 'Workspace not reported'); path.title = task.cwd;
      identity.append(eyebrow, title, path);
      if (task.parentId) identity.append(node('div', 'cc-parent', `Parent: ${byId.get(task.parentId)?.title || task.parentId}${byId.has(task.parentId) ? '' : ' (outside inventory)'}`));
      const state = node('div', 'cc-state'); const badge = node('span', 'cc-badge', statusLabel(task)); badge.dataset.status = stale ? 'unknown' : task.status;
      state.append(badge, node('small', '', task.canAcceptDirectInput === true ? 'Direct input available' : task.canAcceptDirectInput === false ? 'Read only · agent controlled' : 'Input capability unknown'));
      const activity = node('div', 'cc-activity', task.lastActivity?.label || 'Activity not reported');
      const at = task.lastActivity?.at;
      const time = node('time', '', Number.isFinite(at) ? new Date(at).toLocaleString() : 'Time not reported');
      if (Number.isFinite(at)) time.dateTime = new Date(at).toISOString(); activity.append(time);
      const button = node('button', 'cc-open', 'Open task'); button.type = 'button'; button.dataset.taskId = task.id;
      button.setAttribute('aria-label', `Open task: ${task.title}`);
      button.onclick = async () => {
        button.disabled = true;
        try {
          const opened = await openThread(task.id, { id: task.id, name: task.title, cwd: task.cwd });
          if (opened) show(false);
          else { error = 'Could not open task. The overview remains available; try again.'; render(); }
        } catch (reason) { error = reason.message; render(); }
        finally { button.disabled = false; }
      };
      row.append(identity, state, activity, button); list.append(row);
    }
    if (!list.children.length) list.append(node('p', 'cc-empty', !snapshot || stale ? 'Task inventory is not available yet. Retry after the connection recovers.' : tasks.length ? 'No tasks match these filters.' : 'No tasks loaded on this dashboard’s app-server. Start a new chat here to begin; Desktop and other Codex processes are outside this view.'));
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
