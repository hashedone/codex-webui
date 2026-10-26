import { describe, expect, test } from 'bun:test';
import { AgentOverview, summarizeThread } from '../agent-overview.js';
import { orderedTasks, statusLabel, readTaskForOpen } from '../public/agent-command-center.js';
const thread = (id, overrides = {}) => ({ id, name: id, cwd: '/tmp/project', updatedAt: 10, status: { type: 'idle' }, canAcceptDirectInput: true, ...overrides });
function fixture() {
  let now = 20000;
  const records = new Map([['root', thread('root')], ['child', thread('child', { parentThreadId: 'root', canAcceptDirectInput: false })]]);
  const calls = [];
  let failure = false;
  const request = async (method, params) => {
    calls.push({ method, params });
    if (failure) throw new Error('server unavailable');
    if (method === 'thread/loaded/list') return { data: params.cursor ? ['child'] : ['root'], nextCursor: params.cursor ? null : 'second' };
    if (method === 'thread/read') return { thread: records.get(params.threadId) };
    if (method === 'thread/list') return { data: [records.get('child')], nextCursor: null };
    throw new Error(`Unexpected method ${method}`);
  };
  const overview = new AgentOverview(request, () => now);
  return { overview, calls, records, advance: () => now += 2000, fail: () => failure = true };
}
describe('agent inventory contract', () => {
  test('classifies direct-input descendants, internal agents, and unknown capabilities without confusing forks', () => {
    expect(summarizeThread(thread('root', { forkedFromId: 'other' })).kind).toBe('root');
    expect(summarizeThread(thread('child', { parentThreadId: 'root' })).kind).toBe('delegated');
    expect(summarizeThread(thread('child', { parentThreadId: 'root', canAcceptDirectInput: false })).kind).toBe('internal');
    expect(summarizeThread(thread('child', { parentThreadId: 'root', canAcceptDirectInput: null })).kind).toBe('descendant');
    expect(summarizeThread(thread('child', { source: { subAgent: { thread_spawn: { parent_thread_id: 'root', agent_role: 'reviewer' } } } })).parentId).toBe('root');
    expect(summarizeThread(thread('root', { source: 'vscode', originator: 'Codex Desktop' })).kind).toBe('root');
  });
  test('pages loaded inventory and explicitly requests every descendant source without reading history', async () => {
    const f = fixture(); const result = await f.overview.read(true);
    expect(result.tasks.map(t => t.id)).toEqual(['root', 'child']);
    expect(result.stale).toBe(false);
    expect(f.calls.filter(c => c.method === 'thread/loaded/list')).toHaveLength(2);
    expect(f.calls.find(c => c.method === 'thread/list').params.sourceKinds).toContain('subAgentThreadSpawn');
    expect(f.calls.filter(c => c.method === 'thread/read').every(c => c.params.includeTurns === false)).toBe(true);
    expect(f.calls.every(c => !/resume|start|subscribe/.test(c.method))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('turns');
  });
  test('polling, token usage, and unrelated notifications do not fabricate meaningful activity', async () => {
    const f = fixture(); const first = await f.overview.read(true);
    f.advance(); f.overview.observe('thread/tokenUsage/updated', { threadId: 'root' });
    const second = await f.overview.read(true);
    expect(second.refreshedAt).toBeGreaterThan(first.refreshedAt);
    expect(second.tasks[0].lastActivity).toEqual(first.tasks[0].lastActivity);
    f.overview.observe('item/agentMessage/delta', { threadId: 'root', delta: 'SECRET RAW OUTPUT' });
    const live = f.overview.snapshot();
    expect(live.tasks[0].lastActivity.label).toBe('Agent responding');
    expect(JSON.stringify(live)).not.toContain('SECRET RAW OUTPUT');
  });
  test('deduplicates concurrent reads and caches briefly', async () => {
    const f = fixture(); await Promise.all([f.overview.read(true), f.overview.read(true)]);
    const count = f.calls.length; await f.overview.read(true); expect(f.calls.length).toBe(count);
  });
  test('preserves last known inventory but marks errors and disconnects stale', async () => {
    const f = fixture(); await f.overview.read(true); f.advance(); f.fail();
    const result = await f.overview.read(true);
    expect(result.stale).toBe(true); expect(result.tasks).toHaveLength(2); expect(result.error).toBe('server unavailable');
    expect((await f.overview.read(false)).connected).toBe(false);
  });
  test('new process clears ownership and ignores an old in-flight response', async () => {
    let resolve;
    const overview = new AgentOverview(async () => new Promise(r => resolve = r));
    const pending = overview.read(true); overview.reset(); resolve({ data: [], nextCursor: null }); await pending;
    expect(overview.snapshot().refreshedAt).toBe(null); expect(overview.snapshot().tasks).toEqual([]);
  });
  test('notification wins over an in-flight older read', async () => {
    let release; const gate = new Promise(r => release = r);
    const overview = new AgentOverview(async method => {
      if (method === 'thread/loaded/list') return { data: ['root'] };
      if (method === 'thread/read') { await gate; return { thread: thread('root') }; }
      return { data: [] };
    });
    overview.observe('thread/started', { thread: thread('root') });
    const pending = overview.read(true); await Bun.sleep(0);
    overview.observe('thread/status/changed', { threadId: 'root', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    release(); const result = await pending;
    expect(result.tasks[0].status).toBe('active'); expect(statusLabel(result.tasks[0])).toBe('Awaiting approval');
  });
  test('removes archived tasks and reflects unload without treating idle as completed', async () => {
    const f = fixture(); await f.overview.read(true);
    f.overview.observe('thread/closed', { threadId: 'child' });
    expect(f.overview.snapshot().tasks.find(t => t.id === 'child').status).toBe('notLoaded');
    f.overview.observe('thread/archived', { threadId: 'child' });
    expect(f.overview.snapshot().tasks).toHaveLength(1);
    expect(statusLabel(f.overview.snapshot().tasks[0])).toBe('Idle');
  });
  test('fails visibly for unsupported and non-advancing inventory pages', async () => {
    const unsupported = new AgentOverview(async () => ({}));
    expect((await unsupported.read(true)).error).toContain('invalid inventory');
    const looping = new AgentOverview(async () => ({ data: ['root'], nextCursor: 'same' }));
    expect((await looping.read(true)).error).toContain('did not advance');
  });
  test('orders a tree and keeps missing parents and cycles visible exactly once', () => {
    const rows = [thread('grandchild', { parentId: 'child' }), thread('root'), thread('child', { parentId: 'root' }), thread('orphan', { parentId: 'missing' }), thread('a', { parentId: 'b' }), thread('b', { parentId: 'a' })];
    const ordered = orderedTasks(rows);
    expect(new Set(ordered.map(r => r.task.id)).size).toBe(6);
    expect(ordered.find(r => r.task.id === 'grandchild').depth).toBe(2);
    expect(ordered.find(r => r.task.id === 'orphan').depth).toBe(0);
  });
});


test('unsupported history opens metadata with an explicit limitation and never resumes', async () => {
  const calls = [];
  const result = await readTaskForOpen(async (method, params) => {
    calls.push(method);
    if (params.includeTurns) throw new Error('list_turns is not supported yet');
    return { thread: thread('root') };
  }, 'root');
  expect(result.thread.id).toBe('root'); expect(result.historyError).toContain('not supported');
  expect(calls).toEqual(['thread/read', 'thread/read']);
});


test('status notification before initial metadata does not hide a newly discovered task', async () => {
  let release; const gate = new Promise(r => release = r);
  const overview = new AgentOverview(async method => {
    if (method === 'thread/loaded/list') return { data: ['new'] };
    if (method === 'thread/read') { await gate; return { thread: thread('new') }; }
    return { data: [] };
  });
  const pending = overview.read(true); await Bun.sleep(0);
  overview.observe('thread/status/changed', { threadId: 'new', status: { type: 'active', activeFlags: [] } });
  release(); const result = await pending;
  expect(result.tasks).toHaveLength(1); expect(result.tasks[0].status).toBe('active');
});

test('retains paginated unloaded descendants but excludes unrelated stored tasks', async () => {
  const overview = new AgentOverview(async (method, params) => {
    if (method === 'thread/loaded/list') return { data: ['root'] };
    if (method === 'thread/read') return { thread: thread('root') };
    expect(params.ancestorThreadId).toBe('root');
    return params.cursor ? { data: [thread('grandchild', { parentThreadId: 'child', status: { type: 'notLoaded' }, canAcceptDirectInput: null })] } : { data: [thread('child', { parentThreadId: 'root' })], nextCursor: 'descendant-page-2' };
  });
  const result = await overview.read(true);
  expect(result.tasks.map(t => t.id)).toEqual(['root', 'child', 'grandchild']);
  expect(result.tasks[2].status).toBe('notLoaded');
});
