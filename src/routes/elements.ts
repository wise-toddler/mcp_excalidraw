import { Router, Request, Response } from 'express';
import logger from '../utils/logger.js';
import {
  getCanvas,
  generateId,
  normalizeFontFamily,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
} from '../types.js';
import { CreateElementSchema, UpdateElementSchema } from '../schemas.js';
import { broadcastToCanvas } from '../websocket.js';
import { getCanvasId, resolveArrowBindings, normalizeLineBreakMarkup } from '../helpers.js';

const router = Router();

// Get all elements
router.get('/api/elements', (req: Request, res: Response) => {
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
router.post('/api/elements', (req: Request, res: Response) => {
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
router.put('/api/elements/:id', (req: Request, res: Response) => {
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
router.delete('/api/elements/clear', (req: Request, res: Response) => {
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
router.delete('/api/elements/:id', (req: Request, res: Response) => {
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
router.get('/api/elements/search', (req: Request, res: Response) => {
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
router.get('/api/elements/:id', (req: Request, res: Response) => {
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

// Batch create elements
router.post('/api/elements/batch', (req: Request, res: Response) => {
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
router.post('/api/elements/batch-update', (req: Request, res: Response) => {
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
router.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
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
router.post('/api/elements/sync', (req: Request, res: Response) => {
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

export default router;
