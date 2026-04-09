import { Router, Request, Response } from 'express';
import { canvases, getCanvas, generateId } from '../types.js';

const router = Router();

// ─── Canvas management API ─────────────────────────────────────
// List all canvases
router.get('/api/canvases', (req: Request, res: Response) => {
  const list = Array.from(canvases.values()).map(c => ({
    id: c.id,
    elementCount: c.elements.size,
    fileCount: c.files.size,
    snapshotCount: c.snapshots.size,
    createdAt: c.createdAt,
    lastAccessedAt: c.lastAccessedAt,
  }));
  res.json({ success: true, canvases: list, count: list.length });
});

// Create a new canvas
router.post('/api/canvases', (req: Request, res: Response) => {
  const { id } = req.body;
  const canvasId = id || generateId();
  if (canvases.has(canvasId)) {
    return res.status(409).json({ success: false, error: `Canvas "${canvasId}" already exists` });
  }
  const canvas = getCanvas(canvasId);
  res.json({ success: true, canvas: { id: canvas.id, createdAt: canvas.createdAt } });
});

// Delete a canvas
router.delete('/api/canvases/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  if (id === 'default') {
    return res.status(400).json({ success: false, error: 'Cannot delete the default canvas' });
  }
  if (!canvases.has(id!)) {
    return res.status(404).json({ success: false, error: `Canvas "${id}" not found` });
  }
  canvases.delete(id!);
  res.json({ success: true, message: `Canvas "${id}" deleted` });
});

// Canvases HTML page
router.get('/canvases', (req: Request, res: Response) => {
  const list = Array.from(canvases.values());
  const html = `<!DOCTYPE html>
<html><head><title>Excalidraw Canvases</title>
<style>
  body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 20px; }
  h1 { color: #1e1e1e; }
  .canvas-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin: 12px 0; display: flex; justify-content: space-between; align-items: center; }
  .canvas-card:hover { background: #f5f5f5; }
  .canvas-info { flex: 1; }
  .canvas-name { font-weight: 600; font-size: 18px; }
  .canvas-meta { color: #666; font-size: 14px; margin-top: 4px; }
  .canvas-link { padding: 8px 16px; background: #1971c2; color: white; text-decoration: none; border-radius: 6px; }
  .canvas-link:hover { background: #1561a9; }
</style></head><body>
<h1>Excalidraw Canvases</h1>
<p>${list.length} canvas${list.length !== 1 ? 'es' : ''} active</p>
${list.map(c => `
<div class="canvas-card">
  <div class="canvas-info">
    <div class="canvas-name">${c.id}</div>
    <div class="canvas-meta">${c.elements.size} elements &middot; ${c.files.size} files &middot; Created: ${new Date(c.createdAt).toLocaleString()}</div>
  </div>
  <a class="canvas-link" href="/?canvasId=${c.id}">Open</a>
</div>`).join('')}
</body></html>`;
  res.send(html);
});

export default router;
