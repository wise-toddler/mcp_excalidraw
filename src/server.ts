import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { canvases, getCanvas } from './types.js';
import { setupWebSocket, clients } from './websocket.js';
import { getCanvasId } from './helpers.js';
import elementsRouter from './routes/elements.js';
import filesRouter from './routes/files.js';
import exportRouter from './routes/export.js';
import historyRouter from './routes/history.js';
import snapshotsRouter from './routes/snapshots.js';
import canvasesRouter from './routes/canvases.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Redirect / to /canvases when multiple canvases exist (before static files)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/' && !req.query.canvasId) {
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

// Initialize WebSocket
setupWebSocket(server);

// Mount route modules
app.use(elementsRouter);
app.use(filesRouter);
app.use(exportRouter);
app.use(historyRouter);
app.use(snapshotsRouter);
app.use(canvasesRouter);

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

// Start server (skip when running tests)
if (process.env.NODE_ENV !== 'test') {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.HOST || 'localhost';

  server.listen(PORT, HOST, () => {
    logger.info(`POC server running on http://${HOST}:${PORT}`);
    logger.info(`WebSocket server running on ws://${HOST}:${PORT}`);
  });
}

export default app;
