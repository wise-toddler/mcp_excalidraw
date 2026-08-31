import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

// Load environment variables once for every entry point (MCP server, CLI, canvas server)
dotenv.config();

// Express server configuration
export const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || 'http://127.0.0.1:3000';
export const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true

// Opt-out for auto-starting the canvas server from the CLI / MCP server
export const EXCALIDRAW_NO_AUTOSTART = process.env.EXCALIDRAW_NO_AUTOSTART === '1';

// Safe file path validation base directory (see sanitizeFilePath)
export const ALLOWED_EXPORT_DIR = process.env.EXCALIDRAW_EXPORT_DIR || process.cwd();

// Multi-canvas support: canvas identity for this process
export const CANVAS_ID = process.env.CANVAS_ID || 'default';

// Append canvasId query param to API URLs for multi-canvas support
export function withCanvasId(url: string, canvasId: string = CANVAS_ID): string {
  if (canvasId === 'default') return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}canvasId=${encodeURIComponent(canvasId)}`;
}

// Browser-facing page URL for a canvas (default canvas gets the bare server URL)
export function canvasPageUrl(canvasId: string = CANVAS_ID): string {
  return canvasId === 'default'
    ? EXPRESS_SERVER_URL
    : `${EXPRESS_SERVER_URL}/?canvasId=${encodeURIComponent(canvasId)}`;
}

// Safe file path validation allowlist: EXCALIDRAW_EXPORT_DIR entries
// (path.delimiter-separated) plus the OS temp dir and /tmp (see sanitizeFilePath)
export const ALLOWED_EXPORT_DIRS = (process.env.EXCALIDRAW_EXPORT_DIR || process.cwd())
  .split(path.delimiter)
  .filter(Boolean)
  .concat([os.tmpdir(), '/tmp'])
  .map(p => path.resolve(p));
