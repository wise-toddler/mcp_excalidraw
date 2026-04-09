import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import os from 'os';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  elements,
  files,
  snapshots,
  canvases,
  getCanvas,
  Canvas,
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  ExcalidrawFile,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  Snapshot,
  normalizeFontFamily
} from './types.js';
import { z } from 'zod';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Redirect / to /canvases when multiple canvases exist (before static files)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/' && !req.query.canvasId && canvases.size > 1) {
    return res.redirect('/canvases');
  }
  next();
});

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')));
// Serve Excalidraw fonts so the font subsetting worker can fetch them for export
app.use('/assets/fonts', express.static(
  path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')
));

// Extract canvasId from query param or header, default to 'default'
function getCanvasId(req: Request): string {
  return (req.query.canvasId as string) || (req.headers['x-canvas-id'] as string) || 'default';
}

// WebSocket connections
const clients = new Set<WebSocket>();
// Track which canvas each WebSocket client is subscribed to
const clientCanvasMap = new Map<WebSocket, string>();

/** Open a URL in the system's default browser. */
function openInBrowser(url: string): void {
  const platform = os.platform();
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) logger.warn('Failed to auto-open browser:', err.message);
  });
}

/** Wait for a WebSocket client to connect within the given timeout. */
function waitForClient(timeoutMs: number = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (clients.size > 0) return resolve();
    const timeout = setTimeout(() => {
      wss.removeListener('connection', onConnect);
      reject(new Error('No browser connected within timeout. Open the canvas URL manually.'));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timeout);
      // Give browser a moment to fully initialize Excalidraw
      setTimeout(resolve, 2000);
    };
    wss.once('connection', onConnect);
  });
}

// Broadcast to all connected clients (kept for backward compat)
function broadcast(message: WebSocketMessage): void {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    } catch (err) {
      logger.warn('Failed to send to client, removing');
      clients.delete(client);
      clientCanvasMap.delete(client);
    }
  });
}

// Broadcast only to clients subscribed to a specific canvas
function broadcastToCanvas(canvasId: string, message: WebSocketMessage): void {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    const clientCanvas = clientCanvasMap.get(client) || 'default';
    if (clientCanvas === canvasId) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      } catch (err) {
        logger.warn('Failed to send to client, removing');
        clients.delete(client);
        clientCanvasMap.delete(client);
      }
    }
  });
}

function normalizeLineBreakMarkup(text: string): string {
  return text
    .replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket, req: any) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const canvasId = url.searchParams.get('canvasId') || 'default';
  clients.add(ws);
  clientCanvasMap.set(ws, canvasId);
  logger.info(`New WebSocket connection established for canvas: ${canvasId}`);

  // Send current elements for THIS canvas to new client
  const canvas = getCanvas(canvasId);
  const filesObj: Record<string, ExcalidrawFile> = {};
  canvas.files.forEach((f, id) => { filesObj[id] = f; });
  const initialMessage: InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } = {
    type: 'initial_elements',
    elements: Array.from(canvas.elements.values()),
    ...(canvas.files.size > 0 ? { files: filesObj } : {})
  };
  ws.send(JSON.stringify(initialMessage));

  // Send sync status to new client
  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: canvas.elements.size,
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));

  ws.on('close', () => {
    clients.delete(ws);
    clientCanvasMap.delete(ws);
    logger.info('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    clients.delete(ws);
    clientCanvasMap.delete(ws);
  });
});

// Schema validation
const CreateElementSchema = z.object({
  id: z.string().optional(), // Allow passing ID for MCP sync
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  // Arrow-specific properties
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
});

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
});

// API Routes

// Get all elements
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const canvas = getCanvas(getCanvasId(req));
    const elementsArray = Array.from(canvas.elements.values());
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element
app.post('/api/elements', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const params = CreateElementSchema.parse(req.body);
    logger.info('Creating element via API', { type: params.type });

    // Prioritize passed ID (for MCP sync), otherwise generate new ID
    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      fontFamily: normalizeFontFamily(params.fontFamily),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    // Resolve arrow bindings against existing elements
    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings([element], canvas.elements);
    }

    canvas.elements.set(id, element);

    // Broadcast to all connected clients on this canvas
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element
    };
    broadcastToCanvas(canvasId, message);

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element
app.put('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const { id } = req.params;
    const updates = UpdateElementSchema.parse({ id, ...req.body });

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const existingElement = canvas.elements.get(id);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      fontFamily: updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existingElement.fontFamily,
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1
    };

    // Keep Excalidraw text source in sync when clients update text via REST.
    // If originalText lags behind text, rendered wrapping/position can drift.
    const hasTextUpdate = Object.prototype.hasOwnProperty.call(req.body, 'text');
    const hasOriginalTextUpdate = Object.prototype.hasOwnProperty.call(req.body, 'originalText');
    if (updatedElement.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? '';
      const existingText = typeof existingElement.text === 'string' ? existingElement.text : '';
      const existingOriginalText = typeof existingElement.originalText === 'string'
        ? existingElement.originalText
        : '';
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText);
      const normalizedExistingText = normalizeLineBreakMarkup(existingText);
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText);

      // Handle common cleanup flow: caller normalizes the rendered text value.
      // In this case, prefer normalized originalText so words aren't split by stale wraps.
      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updatedElement.text = normalizedExistingOriginalText;
        updatedElement.originalText = normalizedExistingOriginalText;
      } else {
        updatedElement.originalText = incomingText;
      }
    }

    canvas.elements.set(id, updatedElement);

    // Broadcast to all connected clients on this canvas
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement
    };
    broadcastToCanvas(canvasId, message);

    res.json({
      success: true,
      element: updatedElement
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Clear all elements (must be before /:id route)
app.delete('/api/elements/clear', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const count = canvas.elements.size;
    canvas.elements.clear();

    broadcastToCanvas(canvasId, {
      type: 'canvas_cleared',
      timestamp: new Date().toISOString()
    });

    logger.info(`Canvas cleared: ${count} elements removed`);

    res.json({
      success: true,
      message: `Cleared ${count} elements`,
      count
    });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    if (!canvas.elements.has(id)) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    canvas.elements.delete(id);

    // Broadcast to all connected clients on this canvas
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id!
    };
    broadcastToCanvas(canvasId, message);

    res.json({
      success: true,
      message: `Element ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Query elements with filters
app.get('/api/elements/search', (req: Request, res: Response) => {
  try {
    const canvas = getCanvas(getCanvasId(req));
    const { type, canvasId: _cid, ...filters } = req.query;
    let results = Array.from(canvas.elements.values());

    // Filter by type if specified
    if (type && typeof type === 'string') {
      results = results.filter(element => element.type === type);
    }

    // Apply additional filters
    if (Object.keys(filters).length > 0) {
      results = results.filter(element => {
        return Object.entries(filters).every(([key, value]) => {
          return (element as any)[key] === value;
        });
      });
    }

    res.json({
      success: true,
      elements: results,
      count: results.length
    });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get element by ID
app.get('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const canvas = getCanvas(getCanvasId(req));
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const element = canvas.elements.get(id);

    if (!element) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    // Diamond edge: use diamond geometry (rotated square)
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // Scale factor to reach diamond edge
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    // Ellipse edge: parametric intersection
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  // Rectangle: find intersection with edges
  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  // Check if ray intersects top/bottom edge or left/right edge
  if (Math.abs(tanA * hw) <= hh) {
    // Intersects left or right edge
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    // Intersects top or bottom edge
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Helper: resolve arrow bindings in a batch
function resolveArrowBindings(batchElements: ServerElement[], canvasElements: Map<string, ServerElement> = elements): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  // Also check existing elements for cross-batch references
  canvasElements.forEach((el, id) => {
    if (!elementMap.has(id)) elementMap.set(id, el);
  });

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    // Calculate arrow path from edge to edge
    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    // Apply gap: move start point slightly away from source, end point slightly away from target
    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP
    };
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP
    };

    // Set arrow position and points
    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Do NOT delete `start` and `end` here.
    // Excalidraw's frontend `convertToExcalidrawElements` method looks for these exact properties
    // to calculate mathematically sound `startBinding`, `endBinding`, `focus`, `gap`, and `boundElements`.
  }
}

// Batch create elements
app.post('/api/elements/batch', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const { elements: elementsToCreate } = req.body;

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }

    const createdElements: ServerElement[] = [];

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      // Prioritize passed ID (for MCP sync), otherwise generate new ID
      const id = params.id || generateId();
      const element: ServerElement = {
        id,
        ...params,
        fontFamily: normalizeFontFamily(params.fontFamily),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };

      createdElements.push(element);
    });

    // Resolve arrow bindings (computes positions, startBinding, endBinding, boundElements)
    resolveArrowBindings(createdElements, canvas.elements);

    // Store all elements after binding resolution
    createdElements.forEach(el => canvas.elements.set(el.id, el));

    // Broadcast to all connected clients on this canvas
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    broadcastToCanvas(canvasId, message);

    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Batch update elements
app.post('/api/elements/batch-update', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const { elements: updatesToApply } = req.body;

    if (!Array.isArray(updatesToApply)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of element updates'
      });
    }

    const updatedElements: ServerElement[] = [];
    const errors: string[] = [];

    for (const update of updatesToApply) {
      const parsed = UpdateElementSchema.parse(update);
      const existing = canvas.elements.get(parsed.id);
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
      canvas.elements.set(parsed.id, updatedElement);
      updatedElements.push(updatedElement);
    }

    // Broadcast updates
    for (const el of updatedElements) {
      broadcastToCanvas(canvasId, { type: 'element_updated', element: el } as ElementUpdatedMessage);
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

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const { mermaidDiagram, config } = req.body;

    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }

    logger.info('Received Mermaid conversion request', {
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config
    });

    // Broadcast to WebSocket clients on this canvas to process the Mermaid diagram
    const canvasId = getCanvasId(req);
    broadcastToCanvas(canvasId, {
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString()
    });

    // Return the diagram for frontend processing
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Sync elements from frontend (overwrite sync)
app.post('/api/elements/sync', (req: Request, res: Response) => {
  try {
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const { elements: frontendElements, timestamp } = req.body;

    logger.info(`Sync request received: ${frontendElements.length} elements`, {
      timestamp,
      elementCount: frontendElements.length
    });

    // Validate input data
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }

    // Record element count before sync
    const beforeCount = canvas.elements.size;

    // 1. Clear existing memory storage
    canvas.elements.clear();
    logger.info(`Cleared existing elements: ${beforeCount} elements removed`);

    // 2. Batch write new data
    let successCount = 0;
    const processedElements: ServerElement[] = [];

    frontendElements.forEach((element: any, index: number) => {
      try {
        // Ensure element has ID, generate one if missing
        const elementId = element.id || generateId();

        // Add server metadata
        const processedElement: ServerElement = {
          ...element,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: 1
        };

        // Store to memory
        canvas.elements.set(elementId, processedElement);
        processedElements.push(processedElement);
        successCount++;

      } catch (elementError) {
        logger.warn(`Failed to process element ${index}:`, elementError);
      }
    });

    logger.info(`Sync completed: ${successCount}/${frontendElements.length} elements synced`);

    // 3. Broadcast sync event to WebSocket clients on this canvas
    broadcastToCanvas(canvasId, {
      type: 'elements_synced',
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'manual_sync'
    });

    // 4. Return sync results
    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: canvas.elements.size
    });

  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation'
    });
  }
});

// ─── Files API (for image elements) ───────────────────────────
// GET all files
app.get('/api/files', (req: Request, res: Response) => {
  const canvas = getCanvas(getCanvasId(req));
  const filesObj: Record<string, ExcalidrawFile> = {};
  canvas.files.forEach((f, id) => { filesObj[id] = f; });
  res.json({ files: filesObj });
});

// POST add/update files (batch)
app.post('/api/files', (req: Request, res: Response) => {
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
app.delete('/api/files/:id', (req: Request, res: Response) => {
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

// Image export: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  collectionTimeout: ReturnType<typeof setTimeout> | null;
  bestResult: { format: string; data: string } | null;
}
const pendingExports = new Map<string, PendingExport>();

app.post('/api/export/image', async (req: Request, res: Response) => {
  try {
    const { format, background } = req.body;

    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be "png" or "svg"'
      });
    }

    if (clients.size === 0) {
      // Auto-open browser and wait for connection
      const canvasUrl = `http://localhost:${PORT}`;
      logger.info('No frontend client connected, auto-opening browser...');
      openInBrowser(canvasUrl);
      try {
        await waitForClient();
        logger.info('Browser connected, proceeding with export');
      } catch (err) {
        return res.status(503).json({
          success: false,
          error: (err as Error).message
        });
      }
    }

    const requestId = generateId();

    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingExports.get(requestId);
        pendingExports.delete(requestId);
        // If we collected any result during the window, use it
        if (pending?.bestResult) {
          resolve(pending.bestResult);
        } else {
          reject(new Error('Export timed out after 30 seconds'));
        }
      }, 30000);

      pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null });
    });

    // Re-broadcast current elements so all connected clients (including stale ones)
    // sync to the canonical server state before exporting
    const canvasId = getCanvasId(req);
    const canvas = getCanvas(canvasId);
    const filesObj: Record<string, ExcalidrawFile> = {};
    canvas.files.forEach((f, id) => { filesObj[id] = f; });
    broadcastToCanvas(canvasId, {
      type: 'initial_elements',
      elements: Array.from(canvas.elements.values()),
      ...(canvas.files.size > 0 ? { files: filesObj } : {})
    } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> });

    // Give browsers time to process the reload before requesting export
    setTimeout(() => {
      broadcastToCanvas(canvasId, {
        type: 'export_image_request',
        requestId,
        format,
        background: background ?? true
      });
    }, 800);

    exportPromise
      .then(result => {
        res.json({
          success: true,
          format: result.format,
          data: result.data
        });
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Image export: result (Frontend -> Express -> MCP)
app.post('/api/export/image/result', (req: Request, res: Response) => {
  try {
    const { requestId, format, data, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingExports.get(requestId);
    if (!pending) {
      // Already resolved by another client, or expired — ignore silently
      return res.json({ success: true });
    }

    if (error) {
      // Don't reject on error — another WebSocket client may still succeed.
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }

    // Keep the largest response (most complete canvas state wins)
    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data };
    }

    // Start a short collection window on the first response, then resolve with best
    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId);
        if (p?.bestResult) {
          clearTimeout(p.timeout);
          pendingExports.delete(requestId);
          p.resolve(p.bestResult);
        }
      }, 3000);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

app.post('/api/viewport', async (req: Request, res: Response) => {
  try {
    const { scrollToContent, scrollToElementId, zoom, offsetX, offsetY } = req.body;

    if (clients.size === 0) {
      // Auto-open browser and wait for connection
      const canvasUrl = `http://localhost:${PORT}`;
      logger.info('No frontend client connected, auto-opening browser...');
      openInBrowser(canvasUrl);
      try {
        await waitForClient();
        logger.info('Browser connected, proceeding with viewport');
      } catch (err) {
        return res.status(503).json({
          success: false,
          error: (err as Error).message
        });
      }
    }

    const requestId = generateId();

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);

      pendingViewports.set(requestId, { resolve, reject, timeout });
    });

    broadcastToCanvas(getCanvasId(req), {
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementId,
      zoom,
      offsetX,
      offsetY
    });

    viewportPromise
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: result (Frontend -> Express -> MCP)
app.post('/api/viewport/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingViewports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.resolve({ success: false, message: error });
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Undo/Redo: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingHistoryAction {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingHistoryActions = new Map<string, PendingHistoryAction>();

app.post('/api/undo', async (req: Request, res: Response) => {
  try {
    if (clients.size === 0) {
      // Auto-open browser and wait for connection
      const canvasUrl = `http://localhost:${PORT}`;
      logger.info('No frontend client connected, auto-opening browser...');
      openInBrowser(canvasUrl);
      try {
        await waitForClient();
        logger.info('Browser connected, proceeding with undo');
      } catch (err) {
        return res.status(503).json({
          success: false,
          error: (err as Error).message
        });
      }
    }

    const requestId = generateId();
    const promise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingHistoryActions.delete(requestId);
        reject(new Error('Undo request timed out after 10 seconds'));
      }, 10000);
      pendingHistoryActions.set(requestId, { resolve, reject, timeout });
    });

    broadcastToCanvas(getCanvasId(req), { type: 'undo_request', requestId });

    promise
      .then(result => res.json(result))
      .catch(error => res.status(500).json({ success: false, error: (error as Error).message }));
  } catch (error) {
    logger.error('Error initiating undo:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.post('/api/redo', async (req: Request, res: Response) => {
  try {
    if (clients.size === 0) {
      // Auto-open browser and wait for connection
      const canvasUrl = `http://localhost:${PORT}`;
      logger.info('No frontend client connected, auto-opening browser...');
      openInBrowser(canvasUrl);
      try {
        await waitForClient();
        logger.info('Browser connected, proceeding with redo');
      } catch (err) {
        return res.status(503).json({
          success: false,
          error: (err as Error).message
        });
      }
    }

    const requestId = generateId();
    const promise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingHistoryActions.delete(requestId);
        reject(new Error('Redo request timed out after 10 seconds'));
      }, 10000);
      pendingHistoryActions.set(requestId, { resolve, reject, timeout });
    });

    broadcastToCanvas(getCanvasId(req), { type: 'redo_request', requestId });

    promise
      .then(result => res.json(result))
      .catch(error => res.status(500).json({ success: false, error: (error as Error).message }));
  } catch (error) {
    logger.error('Error initiating redo:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Undo/Redo: result (Frontend -> Express -> MCP)
app.post('/api/history/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body;

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

// Snapshots: save
app.post('/api/snapshots', (req: Request, res: Response) => {
  try {
    const canvas = getCanvas(getCanvasId(req));
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required'
      });
    }

    const snapshot: Snapshot = {
      name,
      elements: Array.from(canvas.elements.values()),
      createdAt: new Date().toISOString()
    };

    canvas.snapshots.set(name, snapshot);
    logger.info(`Snapshot saved: "${name}" with ${snapshot.elements.length} elements`);

    res.json({
      success: true,
      name,
      elementCount: snapshot.elements.length,
      createdAt: snapshot.createdAt
    });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: list
app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const canvas = getCanvas(getCanvasId(req));
    const list = Array.from(canvas.snapshots.values()).map(s => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt
    }));

    res.json({
      success: true,
      snapshots: list,
      count: list.length
    });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: get by name
app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  try {
    const canvas = getCanvas(getCanvasId(req));
    const { name } = req.params;
    const snapshot = canvas.snapshots.get(name!);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found`
      });
    }

    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ─── Canvas management API ─────────────────────────────────────
// List all canvases
app.get('/api/canvases', (req: Request, res: Response) => {
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
app.post('/api/canvases', (req: Request, res: Response) => {
  const { id } = req.body;
  const canvasId = id || generateId();
  if (canvases.has(canvasId)) {
    return res.status(409).json({ success: false, error: `Canvas "${canvasId}" already exists` });
  }
  const canvas = getCanvas(canvasId);
  res.json({ success: true, canvas: { id: canvas.id, createdAt: canvas.createdAt } });
});

// Delete a canvas
app.delete('/api/canvases/:id', (req: Request, res: Response) => {
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
app.get('/canvases', (req: Request, res: Response) => {
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

// Serve the frontend — redirect to /canvases if multiple canvases exist and no canvasId specified
app.get('/', (req: Request, res: Response) => {
  if (!req.query.canvasId && canvases.size > 1) {
    return res.redirect('/canvases');
  }
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const canvas = getCanvas(getCanvasId(req));
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    elements_count: canvas.elements.size,
    websocket_clients: clients.size,
    canvas_count: canvases.size
  });
});

// Sync status endpoint
app.get('/api/sync/status', (req: Request, res: Response) => {
  const canvas = getCanvas(getCanvasId(req));
  res.json({
    success: true,
    elementCount: canvas.elements.size,
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: clients.size
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || 'localhost';

server.listen(PORT, HOST, () => {
  logger.info(`POC server running on http://${HOST}:${PORT}`);
  logger.info(`WebSocket server running on ws://${HOST}:${PORT}`);
});

export default app;
