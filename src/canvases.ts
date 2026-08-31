// Multi-canvas server state (server-side only; never import from src/core or src/cli).
//
// Mechanism: every Express request (and WebSocket connection) runs inside an
// AsyncLocalStorage context carrying its canvas id. The `elements`/`files`/
// `snapshots` exports below are Proxy-backed Maps that resolve to the current
// canvas's Map on every property access, so upstream handlers keep using the
// bare module-level Maps unchanged while transparently operating per-canvas.
// Code running outside any context (module init, tests, background tasks)
// falls through to the 'default' canvas — identical to upstream's
// single-canvas behaviour. Fallback if context is ever lost: call
// `getCanvas(getCanvasId(req))` explicitly per handler and use its Maps.
import { AsyncLocalStorage } from 'async_hooks';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import {
  ServerElement,
  ExcalidrawFile,
  Snapshot,
  elements as defaultElements,
  files as defaultFiles,
  snapshots as defaultSnapshots
} from './types.js';

// Canvas: a self-contained drawing workspace
export interface Canvas {
  id: string;
  elements: Map<string, ServerElement>;
  files: Map<string, ExcalidrawFile>;
  snapshots: Map<string, Snapshot>;
  createdAt: string;
  lastAccessedAt: string;
  // Monotonic counter bumped by every server-side scene mutation. Clients echo
  // the last version they saw as `baseVersion` on POST /api/elements/sync, so a
  // tab holding a stale scene can be rejected instead of overwriting newer
  // edits (#12) — see the last-writer guard in the sync route.
  sceneVersion: number;
}

// All canvases — "default" is created on startup
export const canvases = new Map<string, Canvas>();

// Initialize default canvas using existing global maps (same object identity)
canvases.set('default', {
  id: 'default',
  elements: defaultElements,
  files: defaultFiles,
  snapshots: defaultSnapshots,
  createdAt: new Date().toISOString(),
  lastAccessedAt: new Date().toISOString(),
  sceneVersion: 0,
});

// Get or create a canvas by ID
export function getCanvas(canvasId: string = 'default'): Canvas {
  let canvas = canvases.get(canvasId);
  if (!canvas) {
    canvas = {
      id: canvasId,
      elements: new Map(),
      files: new Map(),
      snapshots: new Map(),
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      sceneVersion: 0,
    };
    canvases.set(canvasId, canvas);
  }
  canvas.lastAccessedAt = new Date().toISOString();
  return canvas;
}

// Per-request canvas context
const store = new AsyncLocalStorage<string>();
export const currentCanvasId = (): string => store.getStore() ?? 'default';
export const runWithCanvas = <T>(id: string, fn: () => T): T => store.run(id, fn);

// Proxy-backed scoped Maps: every property access resolves against the current
// canvas's Map. Reflect.get covers the `size` getter and Symbol.iterator; bind
// covers get/set/delete/has/clear/forEach/values/entries. canvases.get first so
// plain reads don't churn lastAccessedAt.
function scoped<K, V>(pick: (c: Canvas) => Map<K, V>): Map<K, V> {
  return new Proxy(pick(canvases.get('default')!), {
    get(_t, prop) {
      const id = currentCanvasId();
      const m = pick(canvases.get(id) ?? getCanvas(id));
      const v = Reflect.get(m, prop);
      return typeof v === 'function' ? v.bind(m) : v;
    }
  });
}

export const elements = scoped(c => c.elements);
export const files = scoped(c => c.files);
export const snapshots = scoped(c => c.snapshots);

// ─── Scene version (last-writer guard) ────────────────────────
// Read the current canvas's scene version (0 for a canvas never mutated).
export function currentSceneVersion(canvasId: string = currentCanvasId()): number {
  return canvases.get(canvasId)?.sceneVersion ?? 0;
}

// Bump on every server-side scene mutation; call before broadcasting so the
// message carries the new version.
export function bumpSceneVersion(canvasId: string = currentCanvasId()): number {
  const canvas = getCanvas(canvasId);
  canvas.sceneVersion += 1;
  return canvas.sceneVersion;
}

// Extract canvasId from query param or header, default to 'default'
// (structural req type so it is testable without express)
export function getCanvasId(req: { query: any; headers: any }): string {
  return (req.query?.canvasId as string) || (req.headers?.['x-canvas-id'] as string) || 'default';
}

// Express middleware: redirect bare '/' to the canvas dashboard, then run the
// rest of the pipeline inside this request's canvas context. Deleting canvasId
// from req.query keeps GET /api/elements/search (which spreads `...filters`
// into exact-match filters) from excluding every element on a named canvas.
export function canvasContextMiddleware(req: any, res: any, next: any): void {
  if (req.path === '/' && !req.query.canvasId) return res.redirect('/canvases');
  const id = getCanvasId(req);
  getCanvas(id);
  delete (req.query as any).canvasId;
  runWithCanvas(id, next);
}

// ─── WebSocket bookkeeping ────────────────────────────────────
export const clientCanvasMap = new Map<WebSocket, string>();

export function canvasIdFromUpgrade(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').searchParams.get('canvasId') || 'default';
}

export function registerClient(ws: WebSocket, req: IncomingMessage): string {
  const canvasId = canvasIdFromUpgrade(req);
  clientCanvasMap.set(ws, canvasId);
  ws.on('close', () => { clientCanvasMap.delete(ws); });
  ws.on('error', () => { clientCanvasMap.delete(ws); });
  return canvasId;
}

// Clients on a canvas; a client with no map entry counts as 'default'
export function clientsForCanvas(id: string, clients: Set<WebSocket>): WebSocket[] {
  return Array.from(clients).filter(ws => (clientCanvasMap.get(ws) ?? 'default') === id);
}

// Close every client on a canvas (used by DELETE /api/canvases/:id)
export function closeCanvasClients(id: string, clients: Set<WebSocket>): void {
  for (const ws of clientsForCanvas(id, clients)) {
    ws.close(1000, 'canvas deleted');
  }
}
