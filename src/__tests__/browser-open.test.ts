import { describe, it, expect, vi } from 'vitest';
import child_process from 'node:child_process';
import { canvasOpenUrl, ensureBrowserClient, BROWSER_OPEN_DISABLED } from '../browser-open.js';

describe('canvasOpenUrl', () => {
  it('maps wildcard bind addresses to 127.0.0.1', () => {
    expect(canvasOpenUrl('0.0.0.0', 3000, 'default')).toBe('http://127.0.0.1:3000/?canvasId=default');
    expect(canvasOpenUrl('::', 3000, 'default')).toBe('http://127.0.0.1:3000/?canvasId=default');
  });

  it('brackets IPv6 hosts', () => {
    expect(canvasOpenUrl('::1', 3000, 'default')).toBe('http://[::1]:3000/?canvasId=default');
  });

  it('encodes the canvas id and always includes it, even for default', () => {
    expect(canvasOpenUrl('127.0.0.1', 3000, 'c 1')).toBe('http://127.0.0.1:3000/?canvasId=c%201');
    expect(canvasOpenUrl('localhost', 3999, 'default')).toContain('?canvasId=default');
  });
});

describe('ensureBrowserClient', () => {
  it('returns false immediately under EXCALIDRAW_NO_BROWSER_OPEN=1 without spawning a browser', async () => {
    expect(BROWSER_OPEN_DISABLED).toBe(true);
    const execSpy = vi.spyOn(child_process, 'exec');
    const ok = await ensureBrowserClient({
      canvasId: 'nope',
      wss: {} as any,
      clients: new Set(),
      url: 'http://127.0.0.1:3000/?canvasId=nope'
    });
    expect(ok).toBe(false);
    expect(execSpy).not.toHaveBeenCalled();
    execSpy.mockRestore();
  });
});
