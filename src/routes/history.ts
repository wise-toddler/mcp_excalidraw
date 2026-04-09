import { Router, Request, Response } from 'express';
import logger from '../utils/logger.js';
import { generateId } from '../types.js';
import { openInBrowser, waitForClient, clients, broadcastToCanvas } from '../websocket.js';
import { getCanvasId } from '../helpers.js';

const router = Router();

// Undo/Redo: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingHistoryAction {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingHistoryActions = new Map<string, PendingHistoryAction>();

router.post('/api/undo', async (req: Request, res: Response) => {
  try {
    if (clients.size === 0) {
      // Auto-open browser and wait for connection
      const canvasUrl = `http://localhost:${process.env.PORT || '3000'}`;
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

router.post('/api/redo', async (req: Request, res: Response) => {
  try {
    if (clients.size === 0) {
      // Auto-open browser and wait for connection
      const canvasUrl = `http://localhost:${process.env.PORT || '3000'}`;
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
router.post('/api/history/result', (req: Request, res: Response) => {
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

export default router;
