// Fork-only Express routes: canvases API + dashboard, batch-update, and
// undo/redo history. Kept out of server.ts so the upstream file stays close to
// its original shape; dependencies are injected to avoid a circular runtime
// import with server.ts (only its types are imported here).
import { Router, Request, Response } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import logger from './utils/logger.js';
import {
  generateId,
  ServerElement,
  WebSocketMessage,
  ElementUpdatedMessage,
  normalizeFontFamily
} from './types.js';
import {
  elements,
  canvases,
  getCanvas,
  currentCanvasId,
  closeCanvasClients,
  bumpSceneVersion
} from './canvases.js';
import { normalizeLabel } from './core/normalize.js';
import { renderCanvasDashboard, CanvasSummary } from './core/canvas-dashboard.js';
import type { UpdateElementSchema } from './server.js';

export interface ForkRouteDeps {
  broadcast: (m: WebSocketMessage) => void;
  clients: Set<WebSocket>;
  wss: WebSocketServer;
  rerouteBoundArrows: (id: string) => ServerElement[];
  UpdateElementSchema: typeof UpdateElementSchema;
  pageUrl: (canvasId: string) => string;
  // Step-5 hook: returns whether a frontend client is (or becomes) available
  // for the canvas — server.ts currently passes a plain connected-check.
  ensureClient: (canvasId: string) => Promise<boolean>;
}

// Undo/Redo: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingHistoryAction {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingHistoryActions = new Map<string, PendingHistoryAction>();

export function forkRoutes(deps: ForkRouteDeps): Router {
  const router = Router();

  // ─── Canvas management API ─────────────────────────────────────
  // List all canvases
  router.get('/api/canvases', (req: Request, res: Response) => {
    const list: CanvasSummary[] = Array.from(canvases.values()).map(c => ({
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
    closeCanvasClients(id!, deps.clients);
    canvases.delete(id!);
    res.json({ success: true, message: `Canvas "${id}" deleted` });
  });

  // Canvases HTML page
  router.get('/canvases', (req: Request, res: Response) => {
    const list: CanvasSummary[] = Array.from(canvases.values()).map(c => ({
      id: c.id,
      elementCount: c.elements.size,
      fileCount: c.files.size,
      snapshotCount: c.snapshots.size,
      createdAt: c.createdAt,
      lastAccessedAt: c.lastAccessedAt,
    }));
    res.type('html').send(renderCanvasDashboard(list));
  });

  // ─── Batch update elements ─────────────────────────────────────
  router.post('/api/elements/batch-update', (req: Request, res: Response) => {
    try {
      const { elements: updatesToApply } = req.body;

      if (!Array.isArray(updatesToApply)) {
        return res.status(400).json({
          success: false,
          error: 'Expected an array of element updates'
        });
      }

      const updatedElements: ServerElement[] = [];
      const reroutedArrows: ServerElement[] = [];
      const errors: string[] = [];

      for (const update of updatesToApply) {
        const parsed = deps.UpdateElementSchema.parse(update);
        if (parsed.label) parsed.label = normalizeLabel(parsed.label);
        const existing = elements.get(parsed.id);
        if (!existing) {
          errors.push(`Element ${parsed.id} not found`);
          continue;
        }
        const updatedElement: ServerElement = {
          ...existing,
          ...parsed,
          fontFamily: parsed.fontFamily !== undefined ? normalizeFontFamily(parsed.fontFamily) : existing.fontFamily,
          updatedAt: new Date().toISOString(),
          version: (existing.version || 0) + 1
        };
        elements.set(parsed.id, updatedElement);
        updatedElements.push(updatedElement);

        // Moving/resizing a shape must drag its bound arrows along
        // (upstream PUT /api/elements/:id does the same; the fork route predates it)
        const geometryChanged = ['x', 'y', 'width', 'height']
          .some(key => Object.prototype.hasOwnProperty.call(update, key));
        if (geometryChanged && updatedElement.type !== 'arrow' && updatedElement.type !== 'line') {
          reroutedArrows.push(...deps.rerouteBoundArrows(parsed.id));
        }
      }

      if (updatedElements.length > 0) bumpSceneVersion();

      // Broadcast updates
      for (const el of [...updatedElements, ...reroutedArrows]) {
        deps.broadcast({ type: 'element_updated', element: el } as ElementUpdatedMessage);
      }

      res.json({
        success: true,
        elements: updatedElements,
        count: updatedElements.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      logger.error('Error batch updating elements:', error);
      res.status(400).json({
        success: false,
        error: (error as Error).message
      });
    }
  });

  // ─── Undo/Redo history ─────────────────────────────────────────
  // One handler for both kinds; the frontend performs the action and reports
  // back via POST /api/history/result.
  async function handleHistoryAction(kind: 'undo' | 'redo', req: Request, res: Response): Promise<void> {
    const label = kind === 'undo' ? 'Undo' : 'Redo';
    try {
      const canvasId = currentCanvasId();
      if (!(await deps.ensureClient(canvasId))) {
        res.status(503).json({
          success: false,
          error: `No frontend client connected. Open ${deps.pageUrl(canvasId)} in a browser first.`
        });
        return;
      }

      const requestId = generateId();
      const promise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingHistoryActions.delete(requestId);
          reject(new Error(`${label} request timed out after 10 seconds`));
        }, 10000);
        pendingHistoryActions.set(requestId, { resolve, reject, timeout });
      });

      deps.broadcast({ type: `${kind}_request`, requestId });

      promise
        .then(result => res.json(result))
        .catch(error => res.status(500).json({ success: false, error: (error as Error).message }));
    } catch (error) {
      logger.error(`Error initiating ${kind}:`, error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  router.post('/api/undo', (req: Request, res: Response) => handleHistoryAction('undo', req, res));
  router.post('/api/redo', (req: Request, res: Response) => handleHistoryAction('redo', req, res));

  // Undo/Redo: result (Frontend -> Express -> MCP)
  router.post('/api/history/result', (req: Request, res: Response) => {
    try {
      const { requestId, message, error } = req.body;

      if (!requestId) {
        return res.status(400).json({ success: false, error: 'requestId is required' });
      }

      const pending = pendingHistoryActions.get(requestId);
      if (!pending) {
        return res.json({ success: true });
      }

      clearTimeout(pending.timeout);
      pendingHistoryActions.delete(requestId);

      if (error) {
        pending.resolve({ success: false, message: error });
      } else {
        pending.resolve({ success: true, message: message || 'History action completed' });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('Error processing history result:', error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  return router;
}
