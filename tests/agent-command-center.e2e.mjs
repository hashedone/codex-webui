import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions, artifact } from './browser-runtime.mjs';
const root = new URL('..', import.meta.url).pathname;
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const bin = mkdtempSync(join(tmpdir(), 'codex-command-center-e2e-'));
writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec bun ${JSON.stringify(join(root, 'tests/fixtures/fake-codex-app-server.ts'))} "$@"\n`);
chmodSync(join(bin, 'codex'), 0o755);
const server = Bun.spawn(['bun', 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_WEBUI_TEST_AGENTS: '1', CODEX_WEBUI_ACCESS_TOKEN: '', CODEX_WEBUI_PASSWORD: '' }, stdout: 'ignore', stderr: 'pipe' });
let browser;
try {
  for (let i = 0; i < 200; i++) { if (await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)) break; await Bun.sleep(50); }
  browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', msg => { if(msg.type() === 'error') console.error('CONSOLE',msg.text()); }); const pageErrors = []; page.on('pageerror', error => { pageErrors.push(error.message); console.error('PAGE ERROR', error.message); });
  await page.goto(`${base}/?view=agents`);
  await page.waitForFunction(() => document.querySelectorAll('.cc-task').length === 4, null, {timeout: 8000}).catch(async error => { console.error(await page.locator('#agentCommandCenter').innerText()); console.error('status', await page.locator('#statusText').innerText()); throw error; });
  assert.match(await page.locator('.cc-scope').innerText(), /Desktop sessions and other Codex processes are not monitored/);
  assert.match(await page.locator('.cc-tasks').innerText(), /Delegated task/);
  assert.match(await page.locator('.cc-tasks').innerText(), /Internal agent/);
  assert.match(await page.locator('.cc-tasks').innerText(), /Awaiting approval/);
  assert.equal(await page.locator('.cc-tasks img').count(), 0, 'untrusted task name is text, not HTML');
  assert.equal(await page.locator('[data-task-id="thread-internal"].cc-task').evaluate(el => el.style.getPropertyValue('--depth')), '2');
  await page.screenshot({ path: artifact('agent-command-center-desktop.png'), fullPage: true });
  await page.getByRole('searchbox', { name: 'Find an agent task' }).fill('Internal checker');
  assert.equal(await page.locator('.cc-task').count(), 3, 'filter retains ancestor context');
  await page.getByRole('searchbox', { name: 'Find an agent task' }).fill('nothing-matches');
  assert.match(await page.locator('.cc-empty').innerText(), /No tasks match/);
  await page.getByRole('searchbox', { name: 'Find an agent task' }).fill('');
  // Open an internal descendant through the real bridge; no resume or turn is needed.
  await page.locator('.cc-task[data-task-id="thread-internal"] button').click();
  await page.waitForFunction(() => document.querySelector('#agentCommandCenter').hidden);
  assert.match(await page.locator('#threadTitle').innerText(), /Internal checker/);
  assert.match(await page.locator('#conversation').innerText(), /History unavailable.*not supported/);
  await page.locator('#prompt').fill('must not start an internal turn');
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  assert.match(await page.locator('#toast').innerText(), /controlled by its parent/);
  // Re-enter through the documented route. The sidebar may be collapsed after opening a task,
  // and this flow must not make the test depend on viewport-specific sidebar visibility.
  await page.goto(`${base}/?view=agents`);
  await page.waitForFunction(() => document.querySelectorAll('.cc-task').length === 4);
  // Observe an event on a different root without changing the conversation subscription.
  await page.evaluate(async () => fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 80, method: 'turn/start', params: { threadId: 'thread-alpha', input: [{ type: 'text', text: 'fixture update' }] } }) }));
  await page.waitForFunction(() => document.querySelector('.cc-task[data-task-id="thread-alpha"] .cc-badge')?.textContent === 'Awaiting approval');
  assert.equal(await page.locator('.approval-card').count(), 0);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(base);
  await mobile.waitForFunction(() => document.querySelector('#statusText')?.textContent === 'Codex connected');
  await mobile.locator('#toggleSidebar').click();
  await mobile.locator('#showCommandCenter').waitFor({ state: 'visible' });
  await mobile.locator('#showCommandCenter').click();
  await mobile.waitForFunction(() => document.querySelectorAll('.cc-task').length === 4);
  await mobile.screenshot({ path: artifact('agent-command-center-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobile.locator('#sidebar').isVisible(), false);
  await mobile.close();
  // Force the existing SSE fallback and verify the overview survives a fresh page connection.
  const sse = await browser.newPage();
  await sse.addInitScript(() => { globalThis.WebSocket = class { constructor() { throw new Error('Force SSE test'); } }; });
  await sse.goto(`${base}/?view=agents`);
  await sse.waitForFunction(() => document.querySelectorAll('.cc-task').length === 4);
  await sse.close();
  // Loss of HTTP/SSE/WS must be visible rather than leaving a false Live indicator.
  await page.context().setOffline(true);
  await page.waitForFunction(() => document.querySelector('.cc-health').dataset.stale === 'true', null, { timeout: 15000 });
  await page.context().setOffline(false);
  await page.waitForFunction(() => document.querySelector('.cc-health').dataset.stale === 'false', null, { timeout: 15000 });
  assert.deepEqual(pageErrors, []);
  console.log('PASS command center browser: hierarchy, filters, safe text, open/read-only task, live status, mobile, SSE fallback, disconnect/reconnect');
} finally {
  await browser?.close(); server.kill(); await server.exited; rmSync(bin, { recursive: true, force: true });
}
