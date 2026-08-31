import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { canvases } from '../canvases.js';
import app from '../server.js';

// Clear all canvas state between tests
beforeEach(() => {
  // Clear default canvas elements/files/snapshots
  const def = canvases.get('default');
  if (def) {
    def.elements.clear();
    def.files.clear();
    def.snapshots.clear();
  }
  // Remove non-default canvases
  for (const key of canvases.keys()) {
    if (key !== 'default') canvases.delete(key);
  }
});

// ─── Elements ─────────────────────────────────────────────────
describe('Elements API', () => {
  it('POST /api/elements creates element', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 10, y: 20, width: 100, height: 50 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.element.type).toBe('rectangle');
    expect(res.body.element.x).toBe(10);
    expect(res.body.element.id).toBeDefined();
  });

  it('GET /api/elements lists elements', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    await request(app).post('/api/elements').send({ type: 'ellipse', x: 10, y: 10 });

    const res = await request(app).get('/api/elements');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.elements).toHaveLength(2);
  });

  it('GET /api/elements/:id gets specific element', async () => {
    const created = await request(app)
      .post('/api/elements')
      .send({ type: 'diamond', x: 5, y: 5, width: 80, height: 80 });
    const id = created.body.element.id;

    const res = await request(app).get(`/api/elements/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.element.id).toBe(id);
    expect(res.body.element.type).toBe('diamond');
  });

  it('PUT /api/elements/:id updates element', async () => {
    const created = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 50, height: 50 });
    const id = created.body.element.id;

    const res = await request(app)
      .put(`/api/elements/${id}`)
      .send({ x: 100, backgroundColor: '#ff0000' });
    expect(res.status).toBe(200);
    expect(res.body.element.x).toBe(100);
    expect(res.body.element.backgroundColor).toBe('#ff0000');
    expect(res.body.element.version).toBe(2);
  });

  it('DELETE /api/elements/:id deletes element', async () => {
    const created = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0 });
    const id = created.body.element.id;

    const res = await request(app).delete(`/api/elements/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const check = await request(app).get(`/api/elements/${id}`);
    expect(check.status).toBe(404);
  });

  it('DELETE /api/elements/clear clears all elements', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    await request(app).post('/api/elements').send({ type: 'ellipse', x: 10, y: 10 });

    const res = await request(app).delete('/api/elements/clear');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const list = await request(app).get('/api/elements');
    expect(list.body.count).toBe(0);
  });

  it('GET /api/elements/search?type=rectangle filters by type', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    await request(app).post('/api/elements').send({ type: 'ellipse', x: 10, y: 10 });
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 20, y: 20 });

    const res = await request(app).get('/api/elements/search?type=rectangle');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.elements.every((e: any) => e.type === 'rectangle')).toBe(true);
  });

  it('POST /api/elements/batch creates multiple elements', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          { type: 'ellipse', x: 100, y: 100, width: 80, height: 80 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.elements).toHaveLength(2);
  });

  it('POST /api/elements/batch reports layoutWarnings for overlapping shapes', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'ov1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
          { id: 'ov2', type: 'rectangle', x: 0, y: 80, width: 100, height: 100 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.layoutWarnings).toHaveLength(1);
    expect(res.body.layoutWarnings[0].kind).toBe('overlap');
    expect(res.body.layoutWarnings[0].elementIds).toEqual(['ov1', 'ov2']);
    expect(res.body.layoutWarnings[0].suggestion).toBe('move ov2 down by 40px');
  });

  it('POST /api/elements/batch stays quiet for a zone containing a child', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'zone', type: 'rectangle', x: 0, y: 0, width: 400, height: 300 },
          { id: 'child', type: 'rectangle', x: 20, y: 20, width: 100, height: 60 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.layoutWarnings).toBeUndefined();
  });

  it('POST /api/elements/batch-update reports layoutWarnings after a move', async () => {
    await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'mv1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
          { id: 'mv2', type: 'rectangle', x: 500, y: 0, width: 100, height: 100 },
        ],
      });

    const res = await request(app)
      .post('/api/elements/batch-update')
      .send({ elements: [{ id: 'mv2', x: 70 }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.layoutWarnings).toHaveLength(1);
    expect(res.body.layoutWarnings[0].kind).toBe('overlap');
    expect(res.body.layoutWarnings[0].suggestion).toBe('move mv2 right by 50px');
  });

  it('POST /api/elements/batch-update updates and reports errors', async () => {
    const c1 = await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    const id1 = c1.body.element.id;

    const res = await request(app)
      .post('/api/elements/batch-update')
      .send({
        elements: [
          { id: id1, x: 999 },
          { id: 'nonexistent', x: 0 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors).toContain('Element nonexistent not found');
  });

  it('POST /api/elements/batch-update moving a shape reroutes its bound arrow', async () => {
    const created = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'rectA', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
          { id: 'rectB', type: 'rectangle', x: 400, y: 0, width: 100, height: 60 },
          { id: 'arrow1', type: 'arrow', x: 0, y: 0, start: { id: 'rectA' }, end: { id: 'rectB' } },
        ],
      });
    expect(created.status).toBe(200);
    const arrowBefore = created.body.elements.find((e: any) => e.id === 'arrow1');

    const res = await request(app)
      .post('/api/elements/batch-update')
      .send({ elements: [{ id: 'rectA', x: 300 }] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);

    const arrowAfter = await request(app).get('/api/elements/arrow1');
    expect(arrowAfter.status).toBe(200);
    expect(arrowAfter.body.element.x).not.toBe(arrowBefore.x);
    expect(arrowAfter.body.element.version).toBeGreaterThan(arrowBefore.version);
  });

  it('POST /api/elements/sync syncs from frontend', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });

    const res = await request(app)
      .post('/api/elements/sync')
      .send({
        elements: [
          { id: 'sync-1', type: 'ellipse', x: 10, y: 10 },
          { id: 'sync-2', type: 'diamond', x: 20, y: 20 },
        ],
        timestamp: new Date().toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.beforeCount).toBe(1);
    expect(res.body.afterCount).toBe(2);
  });
});

// ─── Canvas isolation ─────────────────────────────────────────
describe('Canvas isolation', () => {
  it('element on canvas A not on default', async () => {
    await request(app)
      .post('/api/elements')
      .set('x-canvas-id', 'isolated')
      .send({ type: 'rectangle', x: 0, y: 0 });

    const defaultElements = await request(app).get('/api/elements');
    expect(defaultElements.body.count).toBe(0);

    const isolatedElements = await request(app)
      .get('/api/elements')
      .set('x-canvas-id', 'isolated');
    expect(isolatedElements.body.count).toBe(1);
  });

  it('?canvasId query param works', async () => {
    await request(app)
      .post('/api/elements?canvasId=qp-canvas')
      .send({ type: 'ellipse', x: 0, y: 0 });

    const res = await request(app).get('/api/elements?canvasId=qp-canvas');
    expect(res.body.count).toBe(1);
  });

  it('x-canvas-id header works', async () => {
    await request(app)
      .post('/api/elements')
      .set('x-canvas-id', 'hdr-canvas')
      .send({ type: 'diamond', x: 5, y: 5 });

    const res = await request(app)
      .get('/api/elements')
      .set('x-canvas-id', 'hdr-canvas');
    expect(res.body.count).toBe(1);
  });

  it('search with canvasId does not treat it as a filter', async () => {
    await request(app)
      .post('/api/elements?canvasId=iso')
      .send({ type: 'rectangle', x: 0, y: 0 });

    const res = await request(app).get('/api/elements/search?type=rectangle&canvasId=iso');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

// ─── Canvases ─────────────────────────────────────────────────
describe('Canvases API', () => {
  it('POST /api/canvases creates canvas', async () => {
    const res = await request(app)
      .post('/api/canvases')
      .send({ id: 'test-canvas' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.canvas.id).toBe('test-canvas');
  });

  it('GET /api/canvases lists canvases', async () => {
    await request(app).post('/api/canvases').send({ id: 'c1' });
    const res = await request(app).get('/api/canvases');
    expect(res.status).toBe(200);
    expect(res.body.canvases.length).toBeGreaterThanOrEqual(2); // default + c1
  });

  it('DELETE /api/canvases/:id deletes canvas', async () => {
    await request(app).post('/api/canvases').send({ id: 'to-delete' });
    const res = await request(app).delete('/api/canvases/to-delete');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE /api/canvases/default should fail', async () => {
    const res = await request(app).delete('/api/canvases/default');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot delete the default canvas');
  });

  it('POST /api/canvases duplicate returns 409', async () => {
    await request(app).post('/api/canvases').send({ id: 'dup' });
    const res = await request(app).post('/api/canvases').send({ id: 'dup' });
    expect(res.status).toBe(409);
  });

  it('DELETE /api/canvases/:id on a canvas with elements removes it from the list', async () => {
    await request(app)
      .post('/api/elements?canvasId=full-canvas')
      .send({ type: 'rectangle', x: 0, y: 0 });

    const del = await request(app).delete('/api/canvases/full-canvas');
    expect(del.status).toBe(200);

    const list = await request(app).get('/api/canvases');
    expect(list.body.canvases.map((c: any) => c.id)).not.toContain('full-canvas');
  });

  it('GET /canvases returns HTML', async () => {
    const res = await request(app).get('/canvases');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toContain('Excalidraw Canvases');
  });

  it('GET / redirects to /canvases', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/canvases');
  });
});

// ─── History (undo/redo) ──────────────────────────────────────
describe('History API', () => {
  it('POST /api/undo with no clients returns 503 with canvas URL', async () => {
    const res = await request(app).post('/api/undo?canvasId=s1');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('?canvasId=');
  });

  it('POST /api/redo with no clients returns 503', async () => {
    const res = await request(app).post('/api/redo');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/history/result without requestId returns 400', async () => {
    const res = await request(app).post('/api/history/result').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/history/result with unknown requestId returns 200', async () => {
    const res = await request(app)
      .post('/api/history/result')
      .send({ requestId: 'unknown-id', success: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── Snapshots ────────────────────────────────────────────────
describe('Snapshots API', () => {
  it('POST /api/snapshots creates snapshot', async () => {
    await request(app).post('/api/elements').send({ type: 'rectangle', x: 0, y: 0 });
    const res = await request(app)
      .post('/api/snapshots')
      .send({ name: 'snap1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.name).toBe('snap1');
    expect(res.body.elementCount).toBe(1);
  });

  it('GET /api/snapshots lists snapshots', async () => {
    await request(app).post('/api/snapshots').send({ name: 'list-snap' });
    const res = await request(app).get('/api/snapshots');
    expect(res.status).toBe(200);
    expect(res.body.snapshots.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/snapshots/:name gets by name', async () => {
    await request(app).post('/api/elements').send({ type: 'ellipse', x: 10, y: 10 });
    await request(app).post('/api/snapshots').send({ name: 'get-snap' });

    const res = await request(app).get('/api/snapshots/get-snap');
    expect(res.status).toBe(200);
    expect(res.body.snapshot.name).toBe('get-snap');
    expect(res.body.snapshot.elements).toHaveLength(1);
  });

  it('GET /api/snapshots/nonexistent returns 404', async () => {
    const res = await request(app).get('/api/snapshots/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ─── Files ────────────────────────────────────────────────────
describe('Files API', () => {
  it('POST /api/files adds file', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({
        files: [{ id: 'file1', dataURL: 'data:image/png;base64,abc', mimeType: 'image/png' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
  });

  it('GET /api/files lists files', async () => {
    await request(app)
      .post('/api/files')
      .send({
        files: [{ id: 'f1', dataURL: 'data:image/png;base64,abc', mimeType: 'image/png' }],
      });
    const res = await request(app).get('/api/files');
    expect(res.status).toBe(200);
    expect(res.body.files).toBeDefined();
    expect(res.body.files['f1']).toBeDefined();
  });

  it('DELETE /api/files/:id deletes file', async () => {
    await request(app)
      .post('/api/files')
      .send({
        files: [{ id: 'del-file', dataURL: 'data:image/png;base64,abc', mimeType: 'image/png' }],
      });
    const res = await request(app).delete('/api/files/del-file');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE /api/files/:id returns 404 for missing file', async () => {
    const res = await request(app).delete('/api/files/missing');
    expect(res.status).toBe(404);
  });
});

// ─── Health & Status ──────────────────────────────────────────
describe('Health & Status', () => {
  it('GET /health returns healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.elements_count).toBeDefined();
    expect(res.body.canvas_count).toBeDefined();
    expect(res.body.canvas_clients).toBe(0);
  });

  it('GET /api/sync/status returns status', async () => {
    const res = await request(app).get('/api/sync/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.elementCount).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });
});

// ─── Browser-dependent routes (EXCALIDRAW_NO_BROWSER_OPEN=1 in vitest keeps
// the upstream instant-503 contract instead of auto-opening a browser) ──────
describe('Browser-dependent routes', () => {
  it('POST /api/export/image with no clients returns 503', async () => {
    const res = await request(app)
      .post('/api/export/image')
      .send({ format: 'png' });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('No frontend client connected');
  });

  it('POST /api/viewport with no clients returns 503', async () => {
    const res = await request(app)
      .post('/api/viewport')
      .send({ scrollToContent: true });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('No frontend client connected');
  });
});

// ─── Edge cases ───────────────────────────────────────────────
describe('Edge cases', () => {
  it('invalid element type returns 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'invalid', x: 0, y: 0 });
    expect(res.status).toBe(400);
  });

  it('update nonexistent element returns 404', async () => {
    const res = await request(app)
      .put('/api/elements/nonexistent')
      .send({ x: 10 });
    expect(res.status).toBe(404);
  });

  it('delete nonexistent element returns 404', async () => {
    const res = await request(app).delete('/api/elements/nonexistent');
    expect(res.status).toBe(404);
  });

  it('batch create rejects non-array', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: 'not-array' });
    expect(res.status).toBe(400);
  });

  it('snapshot without name returns 400', async () => {
    const res = await request(app)
      .post('/api/snapshots')
      .send({});
    expect(res.status).toBe(400);
  });

  it('delete nonexistent canvas returns 404', async () => {
    const res = await request(app).delete('/api/canvases/ghost');
    expect(res.status).toBe(404);
  });
});
