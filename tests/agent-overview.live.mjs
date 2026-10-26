// Opt-in installed-binary smoke test. Creates empty disposable threads; runs no model turns.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readTaskForOpen } from '../public/agent-command-center.js';
import { AgentOverview } from '../agent-overview.js';
const home = mkdtempSync(join(tmpdir(), 'codex-overview-live-'));
const child = spawn('codex', ['app-server', '--stdio'], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
let seq = 0; const pending = new Map(); let errors = '';
child.stderr.on('data', chunk => errors += chunk);
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
  pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const overview = new AgentOverview(request);
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
  else if (message.method) overview.observe(message.method, message.params);
});
try {
  await request('initialize', { clientInfo: { name: 'codex-webui-overview-smoke', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const { thread } = await request('thread/start', { cwd: home, serviceTier: null });
  const snapshot = await overview.read(true);
  assert.equal(snapshot.stale, false, snapshot.error);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].id, thread.id);
  assert.equal(snapshot.tasks[0].status, 'idle');
  assert.equal(snapshot.tasks[0].canAcceptDirectInput, true);
  const opened = await readTaskForOpen(request, thread.id);
  assert.equal(opened.thread.id, thread.id);
  console.log('PASS installed app-server: loaded inventory, metadata, descendant query, idle status, direct input, task opening; zero model turns');
  if (opened.historyError) console.log(`History limitation surfaced explicitly: ${opened.historyError}`);
} catch (error) { console.error(errors.slice(-2500)); throw error; }
finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); for (const item of pending.values()) item.reject(new Error('Probe closed')); rmSync(home, { recursive: true, force: true }); }
