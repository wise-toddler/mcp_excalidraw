import { Router, Request, Response } from 'express';
import { getCanvas, ExcalidrawFile } from '../types.js';
import { broadcastToCanvas } from '../websocket.js';
import { getCanvasId } from '../helpers.js';

const router = Router();

// ─── Files API (for image elements) ───────────────────────────
// GET all files
router.get('/api/files', (req: Request, res: Response) => {
  const canvas = getCanvas(getCanvasId(req));
  const filesObj: Record<string, ExcalidrawFile> = {};
  canvas.files.forEach((f, id) => { filesObj[id] = f; });
  res.json({ files: filesObj });
});

// POST add/update files (batch)
router.post('/api/files', (req: Request, res: Response) => {
  const canvasId = getCanvasId(req);
  const canvas = getCanvas(canvasId);
  const body = req.body;
  const fileList: ExcalidrawFile[] = Array.isArray(body) ? body : (body?.files || []);
  for (const f of fileList) {
    if (f.id && f.dataURL) {
      canvas.files.set(f.id, { id: f.id, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: f.created || Date.now() });
    }
  }
  // Broadcast files to connected clients on this canvas
  broadcastToCanvas(canvasId, { type: 'files_added', files: fileList });
  res.json({ success: true, count: fileList.length });
});

// DELETE a file
router.delete('/api/files/:id', (req: Request, res: Response) => {
  const canvasId = getCanvasId(req);
  const canvas = getCanvas(canvasId);
  const id = req.params.id as string;
  if (canvas.files.delete(id)) {
    broadcastToCanvas(canvasId, { type: 'file_deleted', fileId: id });
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: `File with ID ${id} not found` });
  }
});

export default router;
