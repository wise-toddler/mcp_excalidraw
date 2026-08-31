import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { canvases } from '../canvases.js';
import { expandElementsForExport } from '../core/expand-elements.js';
import { rehydrateArrowRefs } from '../core/normalize.js';
import app from '../server.js';

// Clear all canvas state between tests
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

// Build a rect+label+arrow scene through the REST API
async function createScene(query = ''): Promise<any[]> {
  const res = await request(app)
    .post(`/api/elements/batch${query}`)
    .send({
      elements: [
        { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, label: { text: 'Hello' } },
        { id: 'r2', type: 'rectangle', x: 300, y: 0, width: 120, height: 60 },
        { id: 'a1', type: 'arrow', x: 0, y: 0, start: { id: 'r1' }, end: { id: 'r2' } },
      ],
    });
  expect(res.status).toBe(200);
  return res.body.elements;
}

describe('Scene export roundtrip (upstream #95)', () => {
  it('expandElementsForExport emits bound label text and arrow bindings', async () => {
    const created = await createScene();
    const expanded = expandElementsForExport(created, { deterministic: true });

    const labelEl = expanded.find(e => e.id === 'r1-label');
    expect(labelEl).toBeDefined();
    expect(labelEl!.type).toBe('text');
    expect(labelEl!.containerId).toBe('r1');
    expect(labelEl!.text).toBe('Hello');

    const rect = expanded.find(e => e.id === 'r1');
    expect(rect!.boundElements).toEqual(
      expect.arrayContaining([{ type: 'text', id: 'r1-label' }])
    );

    const arrow = expanded.find(e => e.id === 'a1');
    expect(arrow!.startBinding?.elementId).toBe('r1');
    expect(arrow!.endBinding?.elementId).toBe('r2');
  });

  it('re-importing an expanded scene retains containerId and arrow bindings', async () => {
    const created = await createScene();
    const expanded = expandElementsForExport(created, { deterministic: true });

    const imported = await request(app)
      .post('/api/elements/batch?canvasId=rt')
      .send({ elements: expanded });
    expect(imported.status).toBe(200);
    expect(imported.body.count).toBe(expanded.length);

    const list = await request(app).get('/api/elements?canvasId=rt');
    expect(list.status).toBe(200);

    const labelEl = list.body.elements.find((e: any) => e.id === 'r1-label');
    expect(labelEl).toBeDefined();
    expect(labelEl.containerId).toBe('r1');

    const arrow = list.body.elements.find((e: any) => e.id === 'a1');
    expect(arrow.startBinding?.elementId).toBe('r1');
    expect(arrow.endBinding?.elementId).toBe('r2');
  });
});

describe('Arrow start/end refs rehydrated on import (#14)', () => {
  it('re-routes an imported arrow when a bound shape is moved', async () => {
    const created = await createScene();
    const expanded = expandElementsForExport(created, { deterministic: true });

    // The exported scene carries bindings only — the fork's refs are stripped
    const exported = expanded.find(e => e.id === 'a1')!;
    expect(exported.start).toBeUndefined();
    expect(exported.end).toBeUndefined();
    expect(exported.startBinding.elementId).toBe('r1');

    // Import it back over a cleared canvas
    const imported = await request(app).post('/api/elements/sync').send({ elements: expanded });
    expect(imported.status).toBe(200);

    const before = await request(app).get('/api/elements');
    const arrowBefore = before.body.elements.find((e: any) => e.id === 'a1');
    expect(arrowBefore.start).toEqual({ id: 'r1' });
    expect(arrowBefore.end).toEqual({ id: 'r2' });
    const pointsBefore = JSON.stringify(arrowBefore.points);

    // Moving a bound shape must drag the imported arrow along
    const moved = await request(app).put('/api/elements/r1').send({ x: 0, y: 400 });
    expect(moved.status).toBe(200);

    const after = await request(app).get('/api/elements');
    const arrowAfter = after.body.elements.find((e: any) => e.id === 'a1');
    expect(JSON.stringify(arrowAfter.points)).not.toBe(pointsBefore);
  });

  it('never overwrites an explicit ref and ignores bindings to absent elements', () => {
    const result = rehydrateArrowRefs([
      { id: 'r1', type: 'rectangle' },
      {
        id: 'a1',
        type: 'arrow',
        start: { id: 'r1' },
        startBinding: { elementId: 'ghost' },
        endBinding: { elementId: 'ghost' }
      }
    ] as any[]);

    const arrow: any = result.find((e: any) => e.id === 'a1');
    expect(arrow.start).toEqual({ id: 'r1' });
    expect(arrow.end).toBeUndefined();
  });
});
