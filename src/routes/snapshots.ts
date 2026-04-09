import { Router, Request, Response } from 'express';
import logger from '../utils/logger.js';
import { getCanvas, Snapshot } from '../types.js';
import { getCanvasId } from '../helpers.js';

const router = Router();

// Snapshots: save
router.post('/api/snapshots', (req: Request, res: Response) => {
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
router.get('/api/snapshots', (req: Request, res: Response) => {
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
router.get('/api/snapshots/:name', (req: Request, res: Response) => {
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

export default router;
