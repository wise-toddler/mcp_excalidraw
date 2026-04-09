import { describe, it, expect } from 'vitest';
import { normalizePoints, convertTextToLabel, sanitizeFilePath, computeEdgePoint, getCanvasId } from '../helpers.js';
import { ServerElement } from '../types.js';

describe('normalizePoints', () => {
  it('converts {x,y} objects to [x,y] tuples', () => {
    const result = normalizePoints([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
    expect(result).toEqual([[10, 20], [30, 40]]);
  });

  it('passes through tuples unchanged', () => {
    const result = normalizePoints([[5, 10], [15, 20]]);
    expect(result).toEqual([[5, 10], [15, 20]]);
  });

  it('handles mixed input', () => {
    const result = normalizePoints([{ x: 1, y: 2 }, [3, 4]]);
    expect(result).toEqual([[1, 2], [3, 4]]);
  });
});

describe('convertTextToLabel', () => {
  it('converts text to label on shapes', () => {
    const element = { id: '1', type: 'rectangle', x: 0, y: 0, text: 'Hello' } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result.label).toEqual({ text: 'Hello' });
    expect((result as any).text).toBeUndefined();
  });

  it('leaves text elements unchanged', () => {
    const element = { id: '1', type: 'text', x: 0, y: 0, text: 'Hello' } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result.text).toBe('Hello');
    expect(result.type).toBe('text');
  });

  it('returns element as-is when no text', () => {
    const element = { id: '1', type: 'rectangle', x: 0, y: 0 } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result).toEqual(element);
  });
});

describe('sanitizeFilePath', () => {
  it('allows paths under cwd', () => {
    const result = sanitizeFilePath(process.cwd() + '/test-output.png');
    expect(result).toContain('test-output.png');
  });

  it('allows /tmp paths', () => {
    const result = sanitizeFilePath('/tmp/export.png');
    expect(result).toContain('export.png');
  });

  it('blocks /etc/passwd traversal', () => {
    expect(() => sanitizeFilePath('/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks relative traversal', () => {
    expect(() => sanitizeFilePath('../../etc/passwd')).toThrow('Path traversal blocked');
  });
});

describe('computeEdgePoint', () => {
  it('returns edge of rectangle', () => {
    const el = { id: '1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 } as ServerElement;
    // Target is to the right: should return right edge
    const pt = computeEdgePoint(el, 200, 25);
    expect(pt.x).toBe(100); // right edge: x + width
    expect(pt.y).toBeCloseTo(25, 0);
  });

  it('returns edge of ellipse', () => {
    const el = { id: '1', type: 'ellipse', x: 0, y: 0, width: 100, height: 100 } as ServerElement;
    // Target directly to the right
    const pt = computeEdgePoint(el, 200, 50);
    expect(pt.x).toBeCloseTo(100, 0); // cx + a = 50 + 50
    expect(pt.y).toBeCloseTo(50, 0);
  });

  it('returns edge of diamond', () => {
    const el = { id: '1', type: 'diamond', x: 0, y: 0, width: 100, height: 100 } as ServerElement;
    // Target directly to the right
    const pt = computeEdgePoint(el, 200, 50);
    expect(pt.x).toBeCloseTo(100, 0); // right vertex
    expect(pt.y).toBeCloseTo(50, 0);
  });

  it('handles zero-distance (returns bottom point)', () => {
    const el = { id: '1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 } as ServerElement;
    const cx = 50, cy = 25;
    const pt = computeEdgePoint(el, cx, cy);
    expect(pt.x).toBe(cx);
    expect(pt.y).toBe(cy + 25); // cy + hh
  });
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
