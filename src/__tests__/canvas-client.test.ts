import { describe, it, expect, vi, afterEach } from 'vitest';

// CANVAS_ID is read at config.ts import time, so each case stubs the env,
// resets the module registry, and re-imports the client fresh.
async function loadClient(canvasId?: string) {
  if (canvasId === undefined) {
    vi.stubEnv('CANVAS_ID', '');
    delete process.env.CANVAS_ID;
  } else {
    vi.stubEnv('CANVAS_ID', canvasId);
  }
  vi.resetModules();
  const mod = await import('../core/canvas-client.js');
  // Skip the /health identity probe so the fetch mock only sees /api calls
  mod.markCanvasIdentityVerified();
  return mod;
}

function okFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, elements: [], count: 0 })
  }));
}

describe('canvas-client CANVAS_ID threading', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('getElements hits /api/elements with canvasId when CANVAS_ID is set', async () => {
    const mod = await loadClient('c9');
    const mock = okFetchMock();
    vi.stubGlobal('fetch', mock);
    await mod.getElements();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0]![0])).toContain('canvasId=c9');
  });

  it('batchUpdateElementsOnCanvas scopes its URL to the canvas', async () => {
    const mod = await loadClient('c9');
    const mock = okFetchMock();
    vi.stubGlobal('fetch', mock);
    await mod.batchUpdateElementsOnCanvas([]);
    const url = String(mock.mock.calls[0]![0]);
    expect(url).toContain('/api/elements/batch-update');
    expect(url).toContain('canvasId=c9');
  });

  it('undoOnCanvas scopes its URL to the canvas', async () => {
    const mod = await loadClient('c9');
    const mock = okFetchMock();
    vi.stubGlobal('fetch', mock);
    await mod.undoOnCanvas();
    const url = String(mock.mock.calls[0]![0]);
    expect(url).toContain('/api/undo');
    expect(url).toContain('canvasId=c9');
  });

  it('leaves URLs bare on the default canvas (CANVAS_ID unset)', async () => {
    const mod = await loadClient(undefined);
    const mock = okFetchMock();
    vi.stubGlobal('fetch', mock);
    await mod.getElements();
    expect(String(mock.mock.calls[0]![0])).not.toContain('canvasId=');
  });

  it('a 503 response throws with code BROWSER_REQUIRED', async () => {
    const mod = await loadClient('c9');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'No canvas connected. Open http://127.0.0.1:3000/?canvasId=c9 in a browser first.' })
    })));
    await expect(mod.undoOnCanvas()).rejects.toMatchObject({ code: 'BROWSER_REQUIRED' });
  });
});
