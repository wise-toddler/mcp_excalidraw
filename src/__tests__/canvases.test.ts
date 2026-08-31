import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  canvases,
  getCanvas,
  getCanvasId,
  elements,
  currentCanvasId,
  runWithCanvas,
  canvasContextMiddleware
} from '../canvases.js';
import { ServerElement } from '../types.js';

beforeEach(() => {
  // Clear default canvas maps and remove non-default canvases
  const def = canvases.get('default');
  if (def) {
    def.elements.clear();
    def.files.clear();
    def.snapshots.clear();
  }
  for (const key of canvases.keys()) {
    if (key !== 'default') canvases.delete(key);
  }
});

describe('getCanvasId', () => {
  it('extracts from query param', () => {
    const req = { query: { canvasId: 'mycanvas' }, headers: {} } as any;
    expect(getCanvasId(req)).toBe('mycanvas');
  });

  it('extracts from x-canvas-id header', () => {
    const req = { query: {}, headers: { 'x-canvas-id': 'header-canvas' } } as any;
    expect(getCanvasId(req)).toBe('header-canvas');
  });

  it('defaults to default', () => {
    const req = { query: {}, headers: {} } as any;
    expect(getCanvasId(req)).toBe('default');
  });

  it('prefers query param over header', () => {
    const req = { query: { canvasId: 'query' }, headers: { 'x-canvas-id': 'header' } } as any;
    expect(getCanvasId(req)).toBe('query');
  });
});

describe('getCanvas', () => {
  it('returns the default canvas', () => {
    const canvas = getCanvas();
    expect(canvas.id).toBe('default');
  });

  it('creates a new canvas if not exists', () => {
    const canvas = getCanvas('test-canvas');
    expect(canvas.id).toBe('test-canvas');
    expect(canvases.has('test-canvas')).toBe(true);
  });

  it('returns existing canvas on second call', () => {
    const first = getCanvas('same-canvas');
    first.elements.set('elem1', { id: 'elem1', type: 'rectangle', x: 0, y: 0 } as ServerElement);
    const second = getCanvas('same-canvas');
    expect(second.elements.has('elem1')).toBe(true);
  });

  it('updates lastAccessedAt on access', () => {
    const canvas = getCanvas('access-test');
    const firstAccess = canvas.lastAccessedAt;
    // Small delay to ensure timestamp differs
    const canvas2 = getCanvas('access-test');
    expect(canvas2.lastAccessedAt).toBeDefined();
    // The timestamps should be equal or later
    expect(new Date(canvas2.lastAccessedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(firstAccess).getTime()
    );
  });
});

describe('canvas context (AsyncLocalStorage + scoped Maps)', () => {
  it('writes inside runWithCanvas land on that canvas only', () => {
    const el = { id: 'x', type: 'rectangle', x: 0, y: 0 } as ServerElement;
    runWithCanvas('a', () => elements.set('x', el));
    expect(elements.has('x')).toBe(false);
    expect(getCanvas('a').elements.has('x')).toBe(true);
  });

  it('outside any context the scoped map is the default canvas map', () => {
    getCanvas('default').elements.set('d1', { id: 'd1', type: 'rectangle', x: 0, y: 0 } as ServerElement);
    expect(elements.size).toBe(getCanvas('default').elements.size);
    expect(elements.has('d1')).toBe(true);
  });

  it('canvasContextMiddleware strips canvasId and runs next inside context', () => {
    const req = { path: '/api/elements', query: { canvasId: 'z', type: 'rectangle' }, headers: {} } as any;
    const res = { redirect: vi.fn() } as any;
    let seenId: string | null = null;
    canvasContextMiddleware(req, res, () => { seenId = currentCanvasId(); });
    expect(seenId).toBe('z');
    expect(req.query.canvasId).toBeUndefined();
    expect(req.query.type).toBe('rectangle');
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects '/' without canvasId to /canvases", () => {
    const req = { path: '/', query: {}, headers: {} } as any;
    const res = { redirect: vi.fn() } as any;
    const next = vi.fn();
    canvasContextMiddleware(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/canvases');
    expect(next).not.toHaveBeenCalled();
  });
});
