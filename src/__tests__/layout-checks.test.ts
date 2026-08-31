import { describe, it, expect } from 'vitest';
import {
  aabbIntersect,
  checkLayout,
  estimateTextSize,
  fullyContains,
  getElementBounds,
  warningsForElements
} from '../core/layout-checks.js';
import { ServerElement } from '../types.js';

const rect = (id: string, x: number, y: number, width: number, height: number, extra: Partial<ServerElement> = {}): ServerElement =>
  ({ id, type: 'rectangle', x, y, width, height, ...extra } as ServerElement);

describe('getElementBounds', () => {
  it('uses the shape box directly', () => {
    expect(getElementBounds(rect('a', 10, 20, 100, 50))).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('derives arrow bounds from points', () => {
    const arrow = { id: 'ar', type: 'arrow', x: 100, y: 100, points: [[0, 0], [50, -30]] } as unknown as ServerElement;
    expect(getElementBounds(arrow)).toEqual({ x: 100, y: 70, width: 50, height: 30 });
  });

  it('estimates text bounds when the canvas has not measured them', () => {
    const text = { id: 't', type: 'text', x: 0, y: 0, text: 'hello', fontSize: 20 } as ServerElement;
    // 5 chars * 20 * 0.6 = 60 wide, 1 line * 20 * 1.5 + 20 = 50 tall
    expect(getElementBounds(text)).toEqual({ x: 0, y: 0, width: 60, height: 50 });
  });

  it('estimateTextSize scales with line count and longest line', () => {
    expect(estimateTextSize('ab\ncdef')).toEqual({ width: 4 * 20 * 0.6, height: 2 * 20 * 1.5 + 20 });
  });
});

describe('aabbIntersect / fullyContains', () => {
  it('detects intersection and separation', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(aabbIntersect(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
    expect(aabbIntersect(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it('detects containment', () => {
    const outer = { x: 0, y: 0, width: 200, height: 200 };
    expect(fullyContains(outer, { x: 10, y: 10, width: 50, height: 50 })).toBe(true);
    expect(fullyContains(outer, { x: 190, y: 10, width: 50, height: 50 })).toBe(false);
  });
});

describe('checkLayout — overlap', () => {
  it('warns on overlapping solid shapes with a numeric suggestion', () => {
    const warnings = checkLayout([rect('a', 0, 0, 100, 100), rect('b', 0, 80, 100, 100)]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('overlap');
    expect(warnings[0]!.elementIds).toEqual(['a', 'b']);
    expect(warnings[0]!.message).toContain('overlap by 100x20px');
    // 20px overlap depth + 20px gap
    expect(warnings[0]!.suggestion).toBe('move b down by 40px');
  });

  it('suggests a horizontal move when the horizontal overlap is smaller', () => {
    const warnings = checkLayout([rect('a', 0, 0, 100, 100), rect('b', 70, 0, 100, 100)]);
    expect(warnings[0]!.suggestion).toBe('move b right by 50px');
  });

  it('skips a background zone that fully contains a child', () => {
    expect(checkLayout([rect('zone', 0, 0, 400, 300), rect('child', 20, 20, 100, 60)])).toEqual([]);
  });

  it('skips shapes that share a groupId', () => {
    expect(checkLayout([
      rect('a', 0, 0, 100, 100, { groupIds: ['g1'] }),
      rect('b', 0, 80, 100, 100, { groupIds: ['g1'] })
    ])).toEqual([]);
  });

  it('ignores arrows and lines crossing shapes', () => {
    const arrow = { id: 'ar', type: 'arrow', x: 0, y: 0, points: [[0, 0], [200, 200]] } as unknown as ServerElement;
    expect(checkLayout([rect('a', 0, 0, 100, 100), arrow])).toEqual([]);
  });

  it('ignores deleted elements', () => {
    expect(checkLayout([rect('a', 0, 0, 100, 100), rect('b', 0, 80, 100, 100, { isDeleted: true })])).toEqual([]);
  });
});

describe('checkLayout — text overflow', () => {
  it('warns when a label does not fit its shape', () => {
    const warnings = checkLayout([rect('box', 0, 0, 100, 40, { label: { text: 'a long label here', fontSize: 20 } })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('text-overflow');
    expect(warnings[0]!.elementIds).toEqual(['box']);
    // 1 line * 20 * 1.5 + 20 = 50 tall, 17 chars * 20 * 0.6 = 204 wide
    expect(warnings[0]!.suggestion).toBe('increase height to ≥50px and increase width to ≥204px');
  });

  it('stays quiet when the shape is big enough', () => {
    expect(checkLayout([rect('box', 0, 0, 300, 80, { label: { text: 'ok', fontSize: 20 } })])).toEqual([]);
  });

  it('checks a bound text element against its container', () => {
    const warnings = checkLayout([
      rect('box', 0, 0, 400, 30),
      { id: 't1', type: 'text', x: 5, y: 5, text: 'bound label', fontSize: 20, containerId: 'box' } as ServerElement
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('text-overflow');
    expect(warnings[0]!.elementIds).toEqual(['box', 't1']);
    expect(warnings[0]!.suggestion).toBe('increase height to ≥50px');
  });
});

describe('checkLayout — duplicate labels', () => {
  it('warns when a container has more than one bound text element', () => {
    const warnings = checkLayout([
      rect('box', 0, 0, 400, 200),
      { id: 't1', type: 'text', x: 5, y: 5, text: 'hi', containerId: 'box' } as ServerElement,
      { id: 't2', type: 'text', x: 5, y: 5, text: 'hi', containerId: 'box' } as ServerElement
    ]);
    const dup = warnings.filter(w => w.kind === 'duplicate-label');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.elementIds).toEqual(['box', 't1', 't2']);
    expect(dup[0]!.suggestion).toBe('delete the extra text element(s): t2');
  });

  it('stays quiet with a single bound text element', () => {
    const warnings = checkLayout([
      rect('box', 0, 0, 400, 200),
      { id: 't1', type: 'text', x: 5, y: 5, text: 'hi', containerId: 'box' } as ServerElement
    ]);
    expect(warnings.filter(w => w.kind === 'duplicate-label')).toEqual([]);
  });
});

describe('warningsForElements', () => {
  it('keeps only warnings involving the requested elements', () => {
    const scene = [
      rect('a', 0, 0, 100, 100),
      rect('b', 0, 80, 100, 100),
      rect('c', 500, 0, 100, 100),
      rect('d', 500, 80, 100, 100)
    ];
    expect(warningsForElements(scene, ['c']).map(w => w.elementIds)).toEqual([['c', 'd']]);
    expect(warningsForElements(scene, ['x'])).toEqual([]);
  });

  it('never throws on malformed input', () => {
    expect(warningsForElements([null as unknown as ServerElement], ['a'])).toEqual([]);
  });
});
