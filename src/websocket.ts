import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { exec } from 'child_process';
import os from 'os';
import logger from './utils/logger.js';
import {
  getCanvas,
  ExcalidrawFile,
  WebSocketMessage,
  InitialElementsMessage,
  SyncStatusMessage,
} from './types.js';

// WebSocket connections
export const clients = new Set<WebSocket>();
// Track which canvas each WebSocket client is subscribed to
export const clientCanvasMap = new Map<WebSocket, string>();

// Broadcast to all connected clients (kept for backward compat)
export function broadcast(message: WebSocketMessage): void {
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
export function broadcastToCanvas(canvasId: string, message: WebSocketMessage): void {
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

/** Open a URL in the system's default browser. */
export function openInBrowser(url: string): void {
  const platform = os.platform();
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) logger.warn('Failed to auto-open browser:', err.message);
  });
}

// Exported WSS reference — assigned inside setupWebSocket
export let wss: WebSocketServer;

/** Wait for a WebSocket client to connect within the given timeout. */
export function waitForClient(timeoutMs: number = 15000): Promise<void> {
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

/** Create and configure the WebSocket server on the given HTTP server. */
export function setupWebSocket(httpServer: import('http').Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer });

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

  return wss;
}
