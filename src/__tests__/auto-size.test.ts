import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { autoSizeElement, checkLayout } from '../core/layout-checks.js';
import { prepareElements } from '../core/normalize.js';
import { canvases } from '../canvases.js';
import app from '../server.js';
import type { ServerElement } from '../types.js';

const sized = (el: Record<string, unknown>) => autoSizeElement(el as any) as any;

describe('autoSizeElement', () => {
  it('fills both dimensions from short text', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, text: 'Hello' });
    expect(el.width).toBe(200); // floor wins over 5 chars * 20 * 0.6 + 40
    expect(el.height).toBe(70);
  });

  it('grows past the floor for long text', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, text: 'Authentication Service Layer' });
    expect(el.width).toBe(28 * 20 * 0.6 + 40);
    expect(el.height).toBe(70);
  });

  it('fills only the missing width', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, height: 42, text: 'Hello' });
    expect(el.width).toBe(200);
    expect(el.height).toBe(42);
  });

  it('fills only the missing height', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, width: 42, text: 'Hello' });
    expect(el.width).toBe(42);
    expect(el.height).toBe(70);
  });

  it('never overrides explicit dimensions', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, width: 30, height: 10, text: 'A very long label indeed' });
    expect(el.width).toBe(30);
    expect(el.height).toBe(10);
  });

  it('leaves text-less shapes untouched', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0 });
    expect(el.width).toBeUndefined();
    expect(el.height).toBeUndefined();
  });

  it('leaves non-sizable types untouched', () => {
    for (const type of ['text', 'arrow', 'line']) {
      const el = sized({ id: 'a', type, x: 0, y: 0, text: 'Hello' });
      expect(el.width).toBeUndefined();
      expect(el.height).toBeUndefined();
    }
  });

  it('grows height for multi-line text', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, text: 'Line one\nLine two\nLine three' });
    expect(el.width).toBe(200);
    expect(el.height).toBe(3 * 20 * 1.5 + 20 + 20);
  });

  it('scales with fontSize', () => {
    const small = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, text: 'Big Heading Text', fontSize: 20 });
    const large = sized({ id: 'b', type: 'rectangle', x: 0, y: 0, text: 'Big Heading Text', fontSize: 40 });
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
    expect(large.width).toBe(16 * 40 * 0.6 + 40);
  });

  it('reads a bound label like the overflow check does', () => {
    const el = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, label: { text: 'Big Heading Text', fontSize: 40 } });
    expect(el.width).toBe(16 * 40 * 0.6 + 40);
  });

  it('pads an ellipse for its smaller inscribed text area', () => {
    const rect = sized({ id: 'a', type: 'rectangle', x: 0, y: 0, text: 'Hello' });
    const ellipse = sized({ id: 'b', type: 'ellipse', x: 0, y: 0, text: 'Hello' });
    expect(ellipse.width).toBe(Math.ceil(rect.width * 1.5));
    expect(ellipse.height).toBe(Math.ceil(rect.height * 1.3));
  });

  it('sizes diamonds too', () => {
    const el = sized({ id: 'a', type: 'diamond', x: 0, y: 0, text: 'Approved?' });
    expect(el.width).toBe(200);
    expect(el.height).toBe(70);
  });

  // The whole point of sharing estimateTextSize with the #9 overflow check
  it('never produces a box that trips its own text-overflow warning', () => {
    const texts = ['Hi', 'Authentication Service Layer', 'Line one\nLine two\nLine three', 'x'.repeat(120)];
    const elements: ServerElement[] = [];
    let y = 0;
    for (const type of ['rectangle', 'ellipse', 'diamond']) {
      for (const fontSize of [12, 20, 36]) {
        for (const text of texts) {
          elements.push(sized({ id: `e${elements.length}`, type, x: 0, y: (y += 2000), text, fontSize }));
        }
      }
    }
    const warnings = checkLayout(elements).filter(w => w.kind === 'text-overflow');
    expect(warnings).toEqual([]);
  });
});

describe('auto-size in the create pipeline', () => {
  it('prepareElements sizes a shape before its label is converted', () => {
    const [el] = prepareElements([{ type: 'rectangle', x: 0, y: 0, text: 'Hello' } as any]);
    expect(el!.width).toBe(200);
    expect(el!.height).toBe(70);
    expect(el!.label?.text).toBe('Hello');
  });

  it('prepareElements sizes the shape a labelPosition text is placed against', () => {
    const [shape, label] = prepareElements([
      { type: 'rectangle', x: 0, y: 0, text: 'Authentication Service Layer', labelPosition: 'bottom-right' } as any
    ]);
    expect(shape!.width).toBe(376);
    expect(shape!.height).toBe(70);
    // placed relative to the sized box, not the 160x80 fallback
    expect(label!.type).toBe('text');
    expect(label!.x).toBe(376 - 10 - 100);
    expect(label!.y).toBe(70 - 10 - 24);
  });
});

describe('auto-size over REST', () => {
  beforeEach(() => {
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

  it('POST /api/elements sizes a text-bearing shape with no dimensions', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, text: 'Authentication Service Layer' });
    expect(res.status).toBe(200);
    expect(res.body.element.width).toBe(376);
    expect(res.body.element.height).toBe(70);
  });

  it('POST /api/elements/batch sizes shapes and reports no text-overflow for them', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'b1', type: 'rectangle', x: 0, y: 0, text: 'Authentication Service Layer' },
          { id: 'b2', type: 'ellipse', x: 0, y: 2000, text: 'Rate Limiter' },
          { id: 'b3', type: 'diamond', x: 0, y: 4000, text: 'Token valid?' }
        ]
      });
    expect(res.status).toBe(200);
    for (const el of res.body.elements) {
      expect(el.width).toBeGreaterThan(0);
      expect(el.height).toBeGreaterThan(0);
    }
    const overflow = (res.body.layoutWarnings || []).filter((w: any) => w.kind === 'text-overflow');
    expect(overflow).toEqual([]);
  });

  it('leaves an imported element with explicit tiny dimensions alone', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'i1', type: 'rectangle', x: 0, y: 0, width: 40, height: 10, text: 'A long imported label' }
        ]
      });
    expect(res.status).toBe(200);
    expect(res.body.elements[0].width).toBe(40);
    expect(res.body.elements[0].height).toBe(10);
  });
});
