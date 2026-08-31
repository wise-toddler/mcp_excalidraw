import { describe, it, expect } from 'vitest';
import { computeEdgePoint } from '../server.js';
import { ServerElement } from '../types.js';

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
