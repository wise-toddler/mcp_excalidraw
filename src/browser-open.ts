// Headless auto-open: when an API call needs a live frontend (export,
// viewport, undo/redo) and no browser tab is connected for the target canvas,
// open one and wait for its WebSocket to attach. Opt out with
// EXCALIDRAW_NO_BROWSER_OPEN=1 (tests/CI/headless keep the instant 503).
import { exec } from 'child_process';
import os from 'os';
import WebSocket, { WebSocketServer } from 'ws';
import logger from './utils/logger.js';
import { clientCanvasMap, clientsForCanvas } from './canvases.js';

/** Open a URL in the system's default browser. */
export function openInBrowser(url: string): void {
  const platform = os.platform();
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) logger.warn('Failed to auto-open browser:', err.message);
  });
}

/**
 * Canvas page URL for a browser to open — ALWAYS carries ?canvasId (even
 * 'default') so the tab never hits the '/' -> /canvases redirect, and maps
 * wildcard bind addresses to a connectable loopback host.
 */
export function canvasOpenUrl(host: string, port: number, canvasId: string): string {
  const displayHost =
    host === '0.0.0.0' || host === '::'
      ? '127.0.0.1'
      : host.includes(':')
        ? `[${host}]`
        : host;
  return `http://${displayHost}:${port}/?canvasId=${encodeURIComponent(canvasId)}`;
}

export const BROWSER_OPEN_DISABLED = process.env.EXCALIDRAW_NO_BROWSER_OPEN === '1';

/**
 * Ensure a frontend client is connected for the given canvas, auto-opening a
 * browser tab and waiting for its WebSocket when none is; resolves whether a
 * client is available.
 */
export async function ensureBrowserClient(opts: {
  canvasId: string;
  wss: WebSocketServer;
  clients: Set<WebSocket>;
  url: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const { canvasId, wss, clients, url, timeoutMs = 15000 } = opts;
  if (clientsForCanvas(canvasId, clients).length > 0) return true;
  if (BROWSER_OPEN_DISABLED) return false;

  openInBrowser(url);
  return new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => {
      wss.removeListener('connection', onConnect);
      resolve(false);
    }, timeoutMs);
    const onConnect = (ws: WebSocket): void => {
      // server.ts's connection handler (registerClient) was attached first,
      // so clientCanvasMap already knows which canvas this socket joined.
      if (clientCanvasMap.get(ws) !== canvasId) return;
      wss.removeListener('connection', onConnect);
      clearTimeout(timeout);
      // Give browser a moment to fully initialize Excalidraw
      setTimeout(() => resolve(true), 2000);
    };
    wss.on('connection', onConnect);
  });
}
