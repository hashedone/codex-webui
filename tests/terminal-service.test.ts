import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from '../terminal-service.js';

describe('terminal service', () => {
  test('accepts bounded PTY sizes and rejects malformed resize messages', () => {
    expect(normalizeTerminalResize({ type: 'resize', cols: 120, rows: 32 })).toEqual({ cols: 120, rows: 32 });
    expect(normalizeTerminalResize({ type: 'resize', cols: 0, rows: 32 })).toBeNull();
    expect(normalizeTerminalResize({ type: 'resize', cols: 120, rows: 5000 })).toBeNull();
    expect(normalizeTerminalResize({ type: 'data', cols: 120, rows: 32 })).toBeNull();
  });

  test('keeps terminal cwd inside the same allowed browse roots', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codex-webui-terminal-'));
    const allowedRoot = join(fixture, 'home');
    const project = join(allowedRoot, 'projects', 'codex-webui');
    const fallback = join(allowedRoot, 'projects');
    const outside = join(fixture, 'outside');
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    try {
      expect(resolveTerminalCwd(project, [allowedRoot], fallback)).toBe(realpathSync(project));
      expect(resolveTerminalCwd(outside, [allowedRoot], fallback)).toBe(realpathSync(fallback));
      expect(resolveTerminalCwd(null, [allowedRoot], fallback)).toBe(realpathSync(fallback));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('reports a missing PTY worker runtime without crashing the server', async () => {
    const previous = process.env.CODEX_WEBUI_NODE;
    const cwd = mkdtempSync(join(tmpdir(), 'codex-webui-terminal-worker-'));
    process.env.CODEX_WEBUI_NODE = '/definitely/missing/codex-webui-node';
    try {
      const result = await new Promise(resolve => {
        const session = createTerminalSession({
          cwd,
          onData: () => {},
          onExit: event => { session.kill(); resolve(event); },
        });
      });
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      if (previous === undefined) delete process.env.CODEX_WEBUI_NODE;
      else process.env.CODEX_WEBUI_NODE = previous;
    }
  });
});
