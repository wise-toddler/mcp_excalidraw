import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { canvases } from '../canvases.js';
import { expandElementsForExport } from '../core/expand-elements.js';
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
