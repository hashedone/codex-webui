import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { chromium } from 'playwright';
import { launchOptions, artifact } from './browser-runtime.mjs';
const root = new URL('..', import.meta.url).pathname;
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-command-center-e2e-'));
const bin = join(fixtureRoot, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec bun ${JSON.stringify(join(root, 'tests/fixtures/fake-codex-app-server.ts'))} "$@"\n`);
chmodSync(join(bin, 'codex'), 0o755);
const statePath = join(fixtureRoot, 'state_5.sqlite');
const historyPath = join(fixtureRoot, 'thread_history_1.sqlite');
const nowSeconds = Math.floor(Date.now() / 1000);
const stateDb = new Database(statePath);
stateDb.run(`CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT NOT NULL,name TEXT,agent_nickname TEXT,agent_role TEXT,agent_path TEXT,cwd TEXT NOT NULL,updated_at_ms INTEGER,archived INTEGER NOT NULL,source TEXT NOT NULL,first_user_message TEXT,preview TEXT,rollout_path TEXT)`);
stateDb.run('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL,child_thread_id TEXT PRIMARY KEY,status TEXT NOT NULL)');
const historyDb = new Database(historyPath);
historyDb.run(`CREATE TABLE thread_turns (thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,status TEXT NOT NULL,started_at INTEGER,completed_at INTEGER,error_json TEXT,PRIMARY KEY(thread_id,turn_id))`);
const addDesktopThread = (id, name, parentId = null, role = null) => {
  const source = parentId ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parentId, agent_role: role } } }) : 'desktop';
  stateDb.query('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, `${name} title`, name, null, role, parentId ? `/agents/${id}` : null, '/work/desktop-project', Date.now(), 0, source, 'SECRET PROMPT', 'SECRET TRANSCRIPT', '/secret/rollout.jsonl');
  if (parentId) stateDb.query('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run(parentId, id, 'open');
};
const addDesktopTurn = (id, status, ordinal = 1) => historyDb.query('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)').run(id, `${id}-${ordinal}`, ordinal, status, nowSeconds - 2, status === 'inProgress' ? null : nowSeconds - 1, null);
addDesktopThread('thread-alpha', 'Desktop Alpha'); addDesktopTurn('thread-alpha', 'inProgress');
addDesktopThread('desktop-child', 'Desktop child', 'thread-alpha', 'researcher'); addDesktopTurn('desktop-child', 'inProgress');
addDesktopThread('desktop-grandchild', 'Desktop grandchild', 'desktop-child', 'reviewer'); addDesktopTurn('desktop-grandchild', 'inProgress');
addDesktopThread('desktop-completed', 'Desktop completed', 'thread-alpha', 'tester'); addDesktopTurn('desktop-completed', 'completed');
stateDb.close(); historyDb.close();
const server = Bun.spawn(['bun', 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_TEST_AGENTS: '1', CODEX_WEBUI_TEST_EMPTY_AGENT_INVENTORY_ONCE: '1', CODEX_WEBUI_STATE_DB: statePath, CODEX_WEBUI_THREAD_HISTORY_DB: historyPath, CODEX_WEBUI_ACCESS_TOKEN: '', CODEX_WEBUI_PASSWORD: '' }, stdout: 'ignore', stderr: 'pipe' });
let browser;
try {
  for (let i = 0; i < 200; i++) { if (await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)) break; await Bun.sleep(50); }
  browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const rpcMethods = [];
  page.on('request', request => { if (request.url().endsWith('/api/rpc') && request.method() === 'POST') { try { rpcMethods.push(request.postDataJSON()?.method); } catch {} } });
  page.on('requestfailed', request => console.error('REQUEST FAILED', request.url(), request.failure()?.errorText));
  page.on('console', msg => { if(msg.type() === 'error') console.error('CONSOLE',msg.text()); }); const pageErrors = []; page.on('pageerror', error => { pageErrors.push(error.message); console.error('PAGE ERROR', error.message); });
  await page.goto(`${base}/?view=agents`);
  await page.waitForFunction(() => document.querySelectorAll('.cc-task').length === 4 && [...document.querySelectorAll('.cc-task')].every(row => row.dataset.sourceId === 'codex-local'), null, {timeout: 8000}).catch(async error => { console.error(await page.locator('#agentCommandCenter').innerText()); console.error('status', await page.locator('#statusText').innerText()); throw error; });
  assert.match(await page.locator('.cc-scope').innerText(), /Unified local presence/);
  assert.equal(await page.locator('[data-task-id="codex-local:desktop-grandchild"]').evaluate(el => el.style.getPropertyValue('--depth')), '2');
  assert.equal(await page.locator('[data-task-id="codex-local:thread-alpha"] .cc-badge').innerText(), 'Working');
  assert.equal(await page.locator('[data-task-id="codex-local:desktop-completed"] .cc-badge').innerText(), 'Completed');
  assert.match(await page.locator('.cc-sources').innerText(), /Codex WebUI[\s\S]*Codex Desktop \/ local/);
  const readsBeforeMonitorClick = rpcMethods.filter(method => method === 'thread/read').length;
  await page.locator('[data-task-id="codex-local:desktop-child"]').click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-task-id="codex-local:desktop-child"] button').count(), 0, 'monitor-only Desktop rows have no open action');
  assert.equal(rpcMethods.filter(method => method === 'thread/read').length, readsBeforeMonitorClick, 'clicking monitor-only row never reads a WebUI thread');
  await page.waitForFunction(() => document.querySelectorAll('.cc-task').length === 8, null, { timeout: 8000 });
  assert.equal(await page.locator('.cc-task[data-task-id="webui:thread-alpha"]').count(), 1);
  assert.equal(await page.locator('[data-task-id="codex-local:thread-alpha"]').count(), 1, 'duplicate local ids remain distinct after source qualification');
  assert.match(await page.locator('.cc-tasks').innerText(), /Delegated task/);
  assert.match(await page.locator('.cc-tasks').innerText(), /Internal agent/);
  assert.match(await page.locator('.cc-tasks').innerText(), /Awaiting approval/);
  assert.equal(await page.locator('.cc-tasks img').count(), 0, 'untrusted task name is text, not HTML');
  assert.equal(await page.locator('[data-task-id="webui:thread-internal"].cc-task').evaluate(el => el.style.getPropertyValue('--depth')), '2');
  await page.screenshot({ path: artifact('agent-command-center-desktop.png'), fullPage: true });
  await page.getByRole('searchbox', { name: 'Find an agent task' }).fill('Internal checker');
  assert.equal(await page.locator('.cc-task').count(), 3, 'filter retains ancestor context');
  await page.getByRole('searchbox', { name: 'Find an agent task' }).fill('nothing-matches');
  assert.match(await page.locator('.cc-empty').innerText(), /No tasks match/);
  await page.getByRole('searchbox', { name: 'Find an agent task' }).fill('');
  // Open an internal descendant through the real bridge; no resume or turn is needed.
  await page.locator('.cc-task[data-task-id="webui:thread-internal"] button').click();
  await page.waitForFunction(() => document.querySelector('#agentCommandCenter').hidden);
  assert.match(await page.locator('#threadTitle').innerText(), /Internal checker/);
  assert.match(await page.locator('#conversation').innerText(), /History unavailable.*not supported/);
  await page.locator('#prompt').fill('must not start an internal turn');
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  assert.match(await page.locator('#toast').innerText(), /controlled by its parent/);
  // Re-enter through the documented route. The sidebar may be collapsed after opening a task,
  // and this flow must not make the test depend on viewport-specific sidebar visibility.
  await page.goto(`${base}/?view=agents`);
  await page.waitForFunction(() => document.querySelectorAll('.cc-task').length === 8);
  // Observe an event on a different root without changing the conversation subscription.
  await page.evaluate(async () => fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 80, method: 'turn/start', params: { threadId: 'thread-alpha', input: [{ type: 'text', text: 'fixture update' }] } }) }));
  await page.waitForFunction(() => document.querySelector('.cc-task[data-task-id="webui:thread-alpha"] .cc-badge')?.textContent === 'Awaiting approval');
  assert.equal(await page.locator('.approval-card').count(), 0);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(base);
  await mobile.waitForFunction(() => document.querySelector('#statusText')?.textContent === 'Codex connected');
  await mobile.locator('#toggleSidebar').click();
  await mobile.locator('#showCommandCenter').waitFor({ state: 'visible' });
  await mobile.locator('#showCommandCenter').click();
  await mobile.waitForFunction(() => document.querySelectorAll('.cc-task').length === 8);
  await mobile.screenshot({ path: artifact('agent-command-center-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobile.locator('#sidebar').isVisible(), false);
  await mobile.close();
  // Force the existing SSE fallback and verify the overview survives a fresh page connection.
  const sse = await browser.newPage();
  await sse.addInitScript(() => { globalThis.WebSocket = class { constructor() { throw new Error('Force SSE test'); } }; });
  await sse.goto(`${base}/?view=agents`);
  await sse.waitForFunction(() => document.querySelectorAll('.cc-task').length === 8);
  await sse.close();
  // Loss of HTTP/SSE/WS must be visible rather than leaving a false Live indicator.
  await page.context().setOffline(true);
  await page.waitForFunction(() => document.querySelector('.cc-health').dataset.stale === 'true', null, { timeout: 15000 });
  await page.context().setOffline(false);
  await page.waitForFunction(() => document.querySelector('.cc-health').dataset.stale === 'false', null, { timeout: 15000 });
  // One failed source must be visible as stale while the healthy source and last-known Desktop hierarchy remain present.
  rmSync(historyPath);
  await page.waitForTimeout(1600);
  await page.locator('.cc-refresh').click();
  await page.waitForFunction(() => document.querySelector('.cc-source[data-health="stale"]')?.textContent.includes('Codex Desktop'), null, { timeout: 8000 });
  assert.equal(await page.locator('[data-task-id="codex-local:desktop-grandchild"]').count(), 1, 'partial source failure preserves last-known Desktop rows');
  assert.equal(await page.locator('.cc-source[data-health="live"]').filter({ hasText: 'Codex WebUI' }).count(), 1, 'healthy source remains live');
  assert.deepEqual(pageErrors, []);
  console.log('PASS command center browser: Desktop hierarchy/status, source qualification/health, monitor-only safety, WebUI open, filters, mobile, SSE, reconnect');
} finally {
  await browser?.close(); server.kill(); await server.exited; rmSync(fixtureRoot, { recursive: true, force: true });
}
