import { describe, it, expect } from 'vitest';
import { expandLabelPosition, LABEL_POSITIONS } from '../core/label-position.js';
import { prepareElements } from '../core/normalize.js';

describe('expandLabelPosition', () => {
  it('passes center through with labelPosition stripped', () => {
    const out = expandLabelPosition({
      type: 'rectangle', x: 0, y: 0, text: 'hi', labelPosition: 'center'
    });
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('labelPosition');
    expect(out[0].text).toBe('hi');
  });

  it('passes elements without text through with labelPosition stripped', () => {
    const out = expandLabelPosition({
      type: 'rectangle', x: 0, y: 0, labelPosition: 'top-left'
    });
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('labelPosition');
  });

  it('passes arrows through with labelPosition stripped', () => {
    const out = expandLabelPosition({
      type: 'arrow', x: 0, y: 0, text: 'edge', labelPosition: 'top-left'
    });
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('labelPosition');
    expect(out[0].text).toBe('edge');
  });

  it('expands top-left into shape without text plus text at (x+10, y+10)', () => {
    const out = expandLabelPosition({
      id: 'shape-1', type: 'rectangle', x: 100, y: 200, width: 300, height: 120,
      text: 'Title', labelPosition: 'top-left'
    });
    expect(out).toHaveLength(2);
    const [shape, label] = out;
    expect(shape.id).toBe('shape-1');
    expect(shape).not.toHaveProperty('text');
    expect(shape).not.toHaveProperty('labelPosition');
    expect(label.type).toBe('text');
    expect(label.x).toBe(110);
    expect(label.y).toBe(210);
    expect(label.text).toBe('Title');
    expect(label.width).toBe(150);
    expect(label.height).toBe(24);
  });

  it('places bottom-right at (x+W-110, y+H-34) and normalizes fontFamily mono to 3', () => {
    const out = expandLabelPosition({
      type: 'ellipse', x: 50, y: 60, width: 200, height: 100,
      text: 'B', labelPosition: 'bottom-right', fontFamily: 'mono', fontSize: 20
    });
    expect(out).toHaveLength(2);
    const label = out[1];
    expect(label.x).toBe(50 + 200 - 110);
    expect(label.y).toBe(60 + 100 - 34);
    expect(label.fontFamily).toBe(3);
    expect(label.fontSize).toBe(20);
  });
});

describe('prepareElements', () => {
  it('expands a labelled input into 2 elements and keeps the plain input id', () => {
    const out = prepareElements([
      { type: 'rectangle', x: 0, y: 0, text: 'A', labelPosition: 'bottom-right' },
      { id: 'plain-1', type: 'diamond', x: 400, y: 0 }
    ]);
    expect(out).toHaveLength(3);
    expect(out[1].type).toBe('text');
    expect(out[1].text).toBe('A');
    expect(out[2].id).toBe('plain-1');
  });
});

describe('LABEL_POSITIONS', () => {
  it('exposes the 7 positions with center first', () => {
    expect(LABEL_POSITIONS).toHaveLength(7);
    expect(LABEL_POSITIONS[0]).toBe('center');
  });
});
