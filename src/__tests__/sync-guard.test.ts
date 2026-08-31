// Regression tests for #12 (stale tab overwrites MCP edits — multi-line labels
// collapse back to one line) and #15 (stale tab re-injects duplicate bound
// text, inflating element counts).
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { canvases } from '../canvases.js';
import app from '../server.js';

const version = (): number => canvases.get('default')!.sceneVersion;

beforeEach(() => {
  const def = canvases.get('default');
  if (def) {
    def.elements.clear();
    def.files.clear();
    def.snapshots.clear();
    def.sceneVersion = 0;
  }
  for (const key of canvases.keys()) {
    if (key !== 'default') canvases.delete(key);
  }
});

describe('Scene sync last-writer guard', () => {
  it('rejects a stale sync and keeps the multi-line label (#12)', async () => {
    const created = await request(app)
      .post('/api/elements')
      .send({ type: 'text', x: 0, y: 0, text: 'one line' });
    const id = created.body.element.id;

    // MCP side writes a real multi-line label
    const updated = await request(app)
      .put(`/api/elements/${id}`)
      .send({ text: 'first line\nsecond line' });
    expect(updated.body.element.text).toBe('first line\nsecond line');

    const current = version();
    const stale = await request(app)
      .post('/api/elements/sync')
      .send({
        baseVersion: current - 1,
        elements: [{ id, type: 'text', x: 0, y: 0, text: 'one line' }]
      });

    expect(stale.status).toBe(409);
    expect(stale.body.success).toBe(false);
    expect(stale.body.error).toBe('stale sync rejected');
    expect(stale.body.currentVersion).toBe(current);

    // Scene untouched: the multi-line text survives
    const check = await request(app).get(`/api/elements/${id}`);
    expect(check.body.element.text).toBe('first line\nsecond line');
    expect(version()).toBe(current);
  });

  it('accepts a sync carrying the current baseVersion and bumps the version', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    const before = version();

    const res = await request(app)
      .post('/api/elements/sync')
      .send({
        baseVersion: before,
        elements: [{ id: 'sync-1', type: 'ellipse', x: 5, y: 5 }]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.sceneVersion).toBe(before + 1);
    expect(version()).toBe(before + 1);
  });

  it('dedupes bound text sharing one container (#15)', async () => {
    const res = await request(app)
      .post('/api/elements/sync')
      .send({
        elements: [
          {
            id: 'box',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            boundElements: [{ id: 'label-a', type: 'text' }]
          },
          { id: 'label-a', type: 'text', x: 10, y: 10, text: 'kept', containerId: 'box' },
          { id: 'label-b', type: 'text', x: 10, y: 10, text: 'duplicate', containerId: 'box' }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.dedupedCount).toBe(1);
    expect(res.body.count).toBe(2);

    const list = await request(app).get('/api/elements');
    const ids = list.body.elements.map((el: { id: string }) => el.id);
    expect(ids).toContain('label-a');
    expect(ids).not.toContain('label-b');
  });

  it('accepts a sync without baseVersion (back-compat)', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    const before = version();

    const res = await request(app)
      .post('/api/elements/sync')
      .send({ elements: [{ id: 'sync-2', type: 'diamond', x: 1, y: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dedupedCount).toBe(0);
    expect(version()).toBe(before + 1);
  });
});
