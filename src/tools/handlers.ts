import { deflateSync } from 'zlib';
import { webcrypto } from 'crypto';
import { z } from 'zod';
import fetch from 'node-fetch';
import fs from 'fs';
import logger from '../utils/logger.js';
import {
  ElementSchema,
  ElementIdSchema,
  ElementIdsSchema,
  GroupIdSchema,
  AlignElementsSchema,
  DistributeElementsSchema,
  QuerySchema,
  ResourceSchema,
} from '../schemas.js';
import { normalizePoints, convertTextToLabel, sanitizeFilePath } from '../helpers.js';
import { DIAGRAM_DESIGN_GUIDE } from '../diagram-guide.js';
import {
  EXPRESS_SERVER_URL,
  CANVAS_ID,
  withCanvasId,
  createElementOnCanvas,
  updateElementOnCanvas,
  deleteElementOnCanvas,
  batchCreateElementsOnCanvas,
  batchUpdateElementsOnCanvas,
  getElementFromCanvas,
} from './sync.js';
import {
  ServerElement,
  ExcalidrawElementType,
  generateId,
  normalizeFontFamily,
} from '../types.js';

// API Response types (local to handler)
interface ApiResponse {
  success: boolean;
  element?: ServerElement;
  elements?: ServerElement[];
  message?: string;
  error?: string;
  count?: number;
}

// In-memory storage for scene state
interface SceneState {
  theme: string;
  viewport: { x: number; y: number; zoom: number };
  selectedElements: Set<string>;
  groups: Map<string, string[]>;
}

const sceneState: SceneState = {
  theme: 'light',
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedElements: new Set(),
  groups: new Map()
};

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
  try {
    switch (name) {
      case 'create_element': {
        const params = ElementSchema.parse(args);
        logger.info('Creating element via MCP', { type: params.type });

        const { startElementId, endElementId, id: customId, ...elementProps } = params;
        const id = customId || generateId();
        const element: ServerElement = {
          id,
          ...elementProps,
          points: elementProps.points ? normalizePoints(elementProps.points) : undefined,
          // Convert binding IDs to Excalidraw's start/end format
          ...(startElementId ? { start: { id: startElementId } } : {}),
          ...(endElementId ? { end: { id: endElementId } } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        };

        // Normalize fontFamily from string names to numeric values
        if (element.fontFamily !== undefined) {
          element.fontFamily = normalizeFontFamily(element.fontFamily);
        }

        // For bound arrows without explicit points, set a default
        if ((startElementId || endElementId) && !elementProps.points) {
          (element as any).points = [[0, 0], [100, 0]];
        }

        // Handle labelPosition: create free-standing text element if non-center
        const labelPos = (element as any).labelPosition;
        const textContent = (element as any).text;

        if (labelPos && labelPos !== 'center' && textContent && element.type !== 'text' && element.type !== 'arrow' && element.type !== 'line') {
          const { text: _t, labelPosition: _lp, ...shapeProps } = element as any;
          const shapeElement = shapeProps as ServerElement;

          const padding = 10;
          const shapeX = element.x;
          const shapeY = element.y;
          const shapeW = element.width || 160;
          const shapeH = element.height || 80;

          let textX = shapeX + padding;
          let textY = shapeY + padding;

          switch (labelPos) {
            case 'top-left': textX = shapeX + padding; textY = shapeY + padding; break;
            case 'top-center': textX = shapeX + shapeW / 4; textY = shapeY + padding; break;
            case 'top-right': textX = shapeX + shapeW - padding - 100; textY = shapeY + padding; break;
            case 'bottom-left': textX = shapeX + padding; textY = shapeY + shapeH - padding - 24; break;
            case 'bottom-center': textX = shapeX + shapeW / 4; textY = shapeY + shapeH - padding - 24; break;
            case 'bottom-right': textX = shapeX + shapeW - padding - 100; textY = shapeY + shapeH - padding - 24; break;
          }

          const textElement: ServerElement = {
            id: generateId(),
            type: 'text' as ExcalidrawElementType,
            x: textX,
            y: textY,
            width: shapeW / 2,
            height: 24,
            text: textContent,
            fontSize: (element as any).fontSize || 16,
            fontFamily: normalizeFontFamily((element as any).fontFamily) || 1,
          };

          const canvasElements = await batchCreateElementsOnCanvas([shapeElement, textElement]);
          if (!canvasElements) {
            throw new Error('Failed to create element: HTTP server unavailable');
          }

          logger.info('Element with labelPosition created via MCP', { id: shapeElement.id, labelPos });

          return {
            content: [{
              type: 'text',
              text: `Element created with free-standing label!\n\n${JSON.stringify(canvasElements, null, 2)}\n\n✅ Synced to canvas`
            }]
          };
        }

        // Convert text to label format for Excalidraw (strip labelPosition if present)
        const { labelPosition: _lp2, ...cleanElement } = element as any;
        const excalidrawElement = convertTextToLabel(cleanElement as ServerElement);

        // Create element directly on HTTP server (no local storage)
        const canvasElement = await createElementOnCanvas(excalidrawElement);

        if (!canvasElement) {
          throw new Error('Failed to create element: HTTP server unavailable');
        }

        logger.info('Element created via MCP and synced to canvas', {
          id: excalidrawElement.id,
          type: excalidrawElement.type,
          synced: !!canvasElement
        });

        return {
          content: [{
            type: 'text',
            text: `Element created successfully!\n\n${JSON.stringify(canvasElement, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'update_element': {
        const params = ElementIdSchema.merge(ElementSchema.partial()).parse(args);
        const { id, points: rawPoints, ...updates } = params;

        if (!id) throw new Error('Element ID is required');

        // Build update payload with timestamp and version increment
        const updatePayload: Partial<ServerElement> & { id: string } = {
          id,
          ...updates,
          points: rawPoints ? normalizePoints(rawPoints) : undefined,
          updatedAt: new Date().toISOString()
        };

        // Normalize fontFamily from string names to numeric values
        if (updatePayload.fontFamily !== undefined) {
          updatePayload.fontFamily = normalizeFontFamily(updatePayload.fontFamily);
        }

        // Convert text to label format for Excalidraw
        const excalidrawElement = convertTextToLabel(updatePayload as ServerElement);

        // Update element directly on HTTP server (no local storage)
        const canvasElement = await updateElementOnCanvas(excalidrawElement);

        if (!canvasElement) {
          throw new Error('Failed to update element: HTTP server unavailable or element not found');
        }

        logger.info('Element updated via MCP and synced to canvas', {
          id: excalidrawElement.id,
          synced: !!canvasElement
        });

        return {
          content: [{
            type: 'text',
            text: `Element updated successfully!\n\n${JSON.stringify(canvasElement, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'delete_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;

        // Delete element directly on HTTP server (no local storage)
        const canvasResult = await deleteElementOnCanvas(id);

        if (!canvasResult || !(canvasResult as ApiResponse).success) {
          throw new Error('Failed to delete element: HTTP server unavailable or element not found');
        }

        const result = { id, deleted: true, syncedToCanvas: true };
        logger.info('Element deleted via MCP and synced to canvas', result);

        return {
          content: [{
            type: 'text',
            text: `Element deleted successfully!\n\n${JSON.stringify(result, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'query_elements': {
        const params = QuerySchema.parse(args || {});
        const { type, filter } = params;

        try {
          // Build query parameters
          const queryParams = new URLSearchParams();
          if (type) queryParams.set('type', type);
          if (filter) {
            Object.entries(filter).forEach(([key, value]) => {
              queryParams.set(key, String(value));
            });
          }

          // Query elements from HTTP server
          const url = withCanvasId(`${EXPRESS_SERVER_URL}/api/elements/search?${queryParams}`);
          const response = await fetch(url);

          if (!response.ok) {
            throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
          }

          const data = await response.json() as ApiResponse;
          const results = data.elements || [];

          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to query elements: ${(error as Error).message}`);
        }
      }

      case 'get_resource': {
        const params = ResourceSchema.parse(args);
        const { resource } = params;
        logger.info('Getting resource', { resource });

        let result: any;
        switch (resource) {
          case 'scene':
            result = {
              theme: sceneState.theme,
              viewport: sceneState.viewport,
              selectedElements: Array.from(sceneState.selectedElements)
            };
            break;
          case 'library':
          case 'elements':
            try {
              // Get elements from HTTP server
              const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements`));
              if (!response.ok) {
                throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
              }
              const data = await response.json() as ApiResponse;
              result = {
                elements: data.elements || []
              };
            } catch (error) {
              throw new Error(`Failed to get elements: ${(error as Error).message}`);
            }
            break;
          case 'theme':
            result = {
              theme: sceneState.theme
            };
            break;
          default:
            throw new Error(`Unknown resource: ${resource}`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }

      case 'group_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;

        try {
          const groupId = generateId();
          sceneState.groups.set(groupId, elementIds);

          // Update elements on canvas with proper error handling
          // Fetch existing groups and append new groupId to preserve multi-group membership
          const updatePromises = elementIds.map(async (id) => {
            const element = await getElementFromCanvas(id);
            const existingGroups = element?.groupIds || [];
            const updatedGroupIds = [...existingGroups, groupId];
            return await updateElementOnCanvas({ id, groupIds: updatedGroupIds });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;

          if (successCount === 0) {
            sceneState.groups.delete(groupId); // Rollback local state
            throw new Error('Failed to group any elements: HTTP server unavailable');
          }

          logger.info('Grouping elements', { elementIds, groupId, successCount });

          const result = { groupId, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to group elements: ${(error as Error).message}`);
        }
      }

      case 'ungroup_elements': {
        const params = GroupIdSchema.parse(args);
        const { groupId } = params;

        if (!sceneState.groups.has(groupId)) {
          throw new Error(`Group ${groupId} not found`);
        }

        try {
          const elementIds = sceneState.groups.get(groupId);
          sceneState.groups.delete(groupId);

          // Update elements on canvas, removing only this specific groupId
          const updatePromises = (elementIds ?? []).map(async (id) => {
            // Fetch current element to get existing groupIds
            const element = await getElementFromCanvas(id);
            if (!element) {
              logger.warn(`Element ${id} not found on canvas, skipping ungroup`);
              return null;
            }

            // Remove only the specific groupId, preserve others
            const updatedGroupIds = (element.groupIds || []).filter(gid => gid !== groupId);
            return await updateElementOnCanvas({ id, groupIds: updatedGroupIds });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result !== null).length;

          if (successCount === 0) {
            throw new Error('Failed to ungroup: no elements were updated (elements may not exist on canvas)');
          }

          logger.info('Ungrouping elements', { groupId, elementIds, successCount });

          const result = { groupId, ungrouped: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to ungroup elements: ${(error as Error).message}`);
        }
      }

      case 'align_elements': {
        const params = AlignElementsSchema.parse(args);
        const { elementIds, alignment } = params;
        logger.info('Aligning elements', { elementIds, alignment });

        // Fetch all elements
        const elementsToAlign: ServerElement[] = [];
        for (const id of elementIds) {
          const el = await getElementFromCanvas(id);
          if (el) elementsToAlign.push(el);
        }

        if (elementsToAlign.length < 2) {
          throw new Error('Need at least 2 elements to align');
        }

        // Calculate alignment target
        let updateFn: (el: ServerElement) => { x?: number; y?: number };
        switch (alignment) {
          case 'left': {
            const minX = Math.min(...elementsToAlign.map(el => el.x));
            updateFn = () => ({ x: minX });
            break;
          }
          case 'right': {
            const maxRight = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
            updateFn = (el) => ({ x: maxRight - (el.width || 0) });
            break;
          }
          case 'center': {
            const centers = elementsToAlign.map(el => el.x + (el.width || 0) / 2);
            const avgCenter = centers.reduce((a, b) => a + b, 0) / centers.length;
            updateFn = (el) => ({ x: avgCenter - (el.width || 0) / 2 });
            break;
          }
          case 'top': {
            const minY = Math.min(...elementsToAlign.map(el => el.y));
            updateFn = () => ({ y: minY });
            break;
          }
          case 'bottom': {
            const maxBottom = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
            updateFn = (el) => ({ y: maxBottom - (el.height || 0) });
            break;
          }
          case 'middle': {
            const middles = elementsToAlign.map(el => el.y + (el.height || 0) / 2);
            const avgMiddle = middles.reduce((a, b) => a + b, 0) / middles.length;
            updateFn = (el) => ({ y: avgMiddle - (el.height || 0) / 2 });
            break;
          }
        }

        // Apply updates
        const updatePromises = elementsToAlign.map(async (el) => {
          const coords = updateFn(el);
          return await updateElementOnCanvas({ id: el.id, ...coords });
        });
        const results = await Promise.all(updatePromises);
        const successCount = results.filter(r => r).length;

        if (successCount === 0) {
          throw new Error('Failed to align any elements: HTTP server unavailable');
        }

        const result = { aligned: true, elementIds, alignment, successCount };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }

      case 'distribute_elements': {
        const params = DistributeElementsSchema.parse(args);
        const { elementIds, direction } = params;
        logger.info('Distributing elements', { elementIds, direction });

        // Fetch all elements
        const elementsToDist: ServerElement[] = [];
        for (const id of elementIds) {
          const el = await getElementFromCanvas(id);
          if (el) elementsToDist.push(el);
        }

        if (elementsToDist.length < 3) {
          throw new Error('Need at least 3 elements to distribute');
        }

        if (direction === 'horizontal') {
          // Sort by x position
          elementsToDist.sort((a, b) => a.x - b.x);
          const first = elementsToDist[0]!;
          const last = elementsToDist[elementsToDist.length - 1]!;
          const totalSpan = (last.x + (last.width || 0)) - first.x;
          const totalElementWidth = elementsToDist.reduce((sum, el) => sum + (el.width || 0), 0);
          const gap = (totalSpan - totalElementWidth) / (elementsToDist.length - 1);

          let currentX = first.x;
          for (const el of elementsToDist) {
            await updateElementOnCanvas({ id: el.id, x: currentX });
            currentX += (el.width || 0) + gap;
          }
        } else {
          // Sort by y position
          elementsToDist.sort((a, b) => a.y - b.y);
          const first = elementsToDist[0]!;
          const last = elementsToDist[elementsToDist.length - 1]!;
          const totalSpan = (last.y + (last.height || 0)) - first.y;
          const totalElementHeight = elementsToDist.reduce((sum, el) => sum + (el.height || 0), 0);
          const gap = (totalSpan - totalElementHeight) / (elementsToDist.length - 1);

          let currentY = first.y;
          for (const el of elementsToDist) {
            await updateElementOnCanvas({ id: el.id, y: currentY });
            currentY += (el.height || 0) + gap;
          }
        }

        const result = { distributed: true, elementIds, direction, count: elementsToDist.length };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }

      case 'lock_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;

        try {
          // Lock elements through HTTP API updates
          const updatePromises = elementIds.map(async (id) => {
            return await updateElementOnCanvas({ id, locked: true });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;

          if (successCount === 0) {
            throw new Error('Failed to lock any elements: HTTP server unavailable');
          }

          const result = { locked: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to lock elements: ${(error as Error).message}`);
        }
      }

      case 'unlock_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;

        try {
          // Unlock elements through HTTP API updates
          const updatePromises = elementIds.map(async (id) => {
            return await updateElementOnCanvas({ id, locked: false });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;

          if (successCount === 0) {
            throw new Error('Failed to unlock any elements: HTTP server unavailable');
          }

          const result = { unlocked: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to unlock elements: ${(error as Error).message}`);
        }
      }

      case 'create_from_mermaid': {
        const params = z.object({
          mermaidDiagram: z.string(),
          config: z.object({
            startOnLoad: z.boolean().optional(),
            flowchart: z.object({
              curve: z.enum(['linear', 'basis']).optional()
            }).optional(),
            themeVariables: z.object({
              fontSize: z.string().optional()
            }).optional(),
            maxEdges: z.number().optional(),
            maxTextSize: z.number().optional()
          }).optional()
        }).parse(args);

        logger.info('Creating Excalidraw elements from Mermaid diagram via MCP', {
          diagramLength: params.mermaidDiagram.length,
          hasConfig: !!params.config
        });

        try {
          // Send the Mermaid diagram to the frontend via the API
          // The frontend will use mermaid-to-excalidraw to convert it
          const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements/from-mermaid`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mermaidDiagram: params.mermaidDiagram,
              config: params.config
            })
          });

          if (!response.ok) {
            throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
          }

          const result = await response.json() as ApiResponse;

          logger.info('Mermaid diagram sent to frontend for conversion', {
            success: result.success
          });

          return {
            content: [{
              type: 'text',
              text: `Mermaid diagram sent for conversion!\n\n${JSON.stringify(result, null, 2)}\n\n⚠️  Note: The actual conversion happens in the frontend canvas with DOM access. Open the canvas at ${EXPRESS_SERVER_URL} to see the diagram rendered.`
            }]
          };
        } catch (error) {
          throw new Error(`Failed to process Mermaid diagram: ${(error as Error).message}`);
        }
      }

      case 'batch_create_elements': {
        const params = z.object({ elements: z.array(ElementSchema) }).parse(args);
        logger.info('Batch creating elements via MCP', { count: params.elements.length });

        const createdElements: ServerElement[] = [];

        for (const elementData of params.elements) {
          const { startElementId, endElementId, id: customId, ...elementProps } = elementData;
          const id = customId || generateId();
          const element: ServerElement = {
            id,
            ...elementProps,
            points: elementProps.points ? normalizePoints(elementProps.points) : undefined,
            // Convert binding IDs to Excalidraw's start/end format
            ...(startElementId ? { start: { id: startElementId } } : {}),
            ...(endElementId ? { end: { id: endElementId } } : {}),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };

          // Normalize fontFamily from string names to numeric values
          if (element.fontFamily !== undefined) {
            element.fontFamily = normalizeFontFamily(element.fontFamily);
          }

          // For bound arrows without explicit points, set a default
          if ((startElementId || endElementId) && !elementProps.points) {
            (element as any).points = [[0, 0], [100, 0]];
          }

          const excalidrawElement = convertTextToLabel(element);
          createdElements.push(excalidrawElement);
        }

        // Expand elements with labelPosition into shape + free-standing text
        const expandedElements: ServerElement[] = [];
        for (const el of createdElements) {
          const labelPos = (el as any).labelPosition;
          const textContent = (el as any).text;

          if (labelPos && labelPos !== 'center' && textContent && el.type !== 'text' && el.type !== 'arrow' && el.type !== 'line') {
            const { text: _t, labelPosition: _lp, ...shapeProps } = el as any;
            expandedElements.push(shapeProps as ServerElement);

            const padding = 10;
            const shapeX = el.x;
            const shapeY = el.y;
            const shapeW = el.width || 160;
            const shapeH = el.height || 80;

            let textX = shapeX + padding;
            let textY = shapeY + padding;

            switch (labelPos) {
              case 'top-left': textX = shapeX + padding; textY = shapeY + padding; break;
              case 'top-center': textX = shapeX + shapeW / 4; textY = shapeY + padding; break;
              case 'top-right': textX = shapeX + shapeW - padding - 100; textY = shapeY + padding; break;
              case 'bottom-left': textX = shapeX + padding; textY = shapeY + shapeH - padding - 24; break;
              case 'bottom-center': textX = shapeX + shapeW / 4; textY = shapeY + shapeH - padding - 24; break;
              case 'bottom-right': textX = shapeX + shapeW - padding - 100; textY = shapeY + shapeH - padding - 24; break;
            }

            const textElement: ServerElement = {
              id: generateId(),
              type: 'text' as ExcalidrawElementType,
              x: textX,
              y: textY,
              width: shapeW / 2,
              height: 24,
              text: textContent,
              fontSize: (el as any).fontSize || 16,
              fontFamily: normalizeFontFamily((el as any).fontFamily) || 1,
            };
            expandedElements.push(textElement);
          } else {
            // Strip labelPosition before sending to canvas
            const { labelPosition: _lp, ...cleanEl } = el as any;
            expandedElements.push(cleanEl as ServerElement);
          }
        }

        const canvasElements = await batchCreateElementsOnCanvas(expandedElements);

        if (!canvasElements) {
          throw new Error('Failed to batch create elements: HTTP server unavailable');
        }

        const result = {
          success: true,
          elements: canvasElements,
          count: canvasElements.length,
          syncedToCanvas: true
        };

        logger.info('Batch elements created via MCP and synced to canvas', {
          count: result.count,
          synced: result.syncedToCanvas
        });

        return {
          content: [{
            type: 'text',
            text: `${result.count} elements created successfully!\n\n${JSON.stringify(result, null, 2)}\n\n${result.syncedToCanvas ? '✅ All elements synced to canvas' : '⚠️  Canvas sync failed (elements still created locally)'}`
          }]
        };
      }

      case 'batch_update_elements': {
        const params = z.object({
          elements: z.array(ElementIdSchema.merge(ElementSchema.partial()))
        }).parse(args);

        const canvasElements = await batchUpdateElementsOnCanvas(params.elements as Array<Partial<ServerElement> & { id: string }>);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              updatedCount: canvasElements?.length ?? params.elements.length,
              elements: canvasElements || params.elements
            }, null, 2)
          }]
        };
      }

      case 'get_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;

        const element = await getElementFromCanvas(id);
        if (!element) {
          throw new Error(`Element ${id} not found`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(element, null, 2) }]
        };
      }

      case 'clear_canvas': {
        logger.info('Clearing canvas via MCP');

        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements/clear`), {
          method: 'DELETE'
        });

        if (!response.ok) {
          throw new Error(`Failed to clear canvas: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApiResponse;

        return {
          content: [{
            type: 'text',
            text: `Canvas cleared.\n\n${JSON.stringify(data, null, 2)}`
          }]
        };
      }

      case 'export_scene': {
        const params = z.object({
          filePath: z.string().optional()
        }).parse(args || {});

        logger.info('Exporting scene via MCP');

        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements`));
        if (!response.ok) {
          throw new Error(`Failed to fetch elements: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApiResponse;
        const sceneElements = data.elements || [];

        // Fetch files for image elements
        let sceneFiles: Record<string, any> = {};
        try {
          const filesResponse = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/files`));
          if (filesResponse.ok) {
            const filesData = await filesResponse.json() as any;
            sceneFiles = filesData.files || {};
          }
        } catch { /* files endpoint may not exist */ }

        const excalidrawScene: any = {
          type: 'excalidraw',
          version: 2,
          source: 'mcp-excalidraw-server',
          elements: sceneElements,
          appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null
          },
          ...(Object.keys(sceneFiles).length > 0 ? { files: sceneFiles } : {})
        };

        const jsonString = JSON.stringify(excalidrawScene, null, 2);

        if (params.filePath) {
          const safePath = sanitizeFilePath(params.filePath);
          fs.writeFileSync(safePath, jsonString, 'utf-8');
          return {
            content: [{
              type: 'text',
              text: `Scene exported to ${safePath} (${sceneElements.length} elements)`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: jsonString
          }]
        };
      }

      case 'import_scene': {
        const params = z.object({
          filePath: z.string().optional(),
          data: z.string().optional(),
          mode: z.enum(['replace', 'merge'])
        }).parse(args);

        logger.info('Importing scene via MCP', { mode: params.mode });

        let sceneData: any;
        if (params.filePath) {
          const safeImportPath = sanitizeFilePath(params.filePath);
          const fileContent = fs.readFileSync(safeImportPath, 'utf-8');
          sceneData = JSON.parse(fileContent);
        } else if (params.data) {
          sceneData = JSON.parse(params.data);
        } else {
          throw new Error('Either filePath or data must be provided');
        }

        // Extract elements from .excalidraw format or raw array
        const importElements: ServerElement[] = Array.isArray(sceneData)
          ? sceneData
          : (sceneData.elements || []);

        if (importElements.length === 0) {
          throw new Error('No elements found in the import data');
        }

        // If replace mode, clear first
        if (params.mode === 'replace') {
          await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements/clear`), { method: 'DELETE' });
        }

        // Batch create the imported elements
        const elementsToCreate = importElements.map(el => ({
          ...el,
          id: el.id || generateId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        }));

        const canvasElements = await batchCreateElementsOnCanvas(elementsToCreate);

        // Import files if present (for image elements)
        let importedFileCount = 0;
        const importFiles = sceneData.files;
        if (importFiles && typeof importFiles === 'object') {
          const fileList = Object.values(importFiles);
          if (fileList.length > 0) {
            try {
              await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/files`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fileList)
              });
              importedFileCount = fileList.length;
            } catch { /* best effort */ }
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Imported ${elementsToCreate.length} elements${importedFileCount > 0 ? ` and ${importedFileCount} files` : ''} (mode: ${params.mode})\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'export_to_image': {
        const params = z.object({
          format: z.enum(['png', 'svg']),
          filePath: z.string().optional(),
          background: z.boolean().optional()
        }).parse(args);

        logger.info('Exporting to image via MCP', { format: params.format });

        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/export/image`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: params.format,
            background: params.background ?? true
          })
        });

        if (!response.ok) {
          const errorData = await response.json() as ApiResponse;
          throw new Error(errorData.error || `Export failed: ${response.status}`);
        }

        const result = await response.json() as { success: boolean; format: string; data: string };

        if (params.filePath) {
          const safeImagePath = sanitizeFilePath(params.filePath);
          if (params.format === 'svg') {
            fs.writeFileSync(safeImagePath, result.data, 'utf-8');
          } else {
            fs.writeFileSync(safeImagePath, Buffer.from(result.data, 'base64'));
          }
          return {
            content: [{
              type: 'text',
              text: `Image exported to ${safeImagePath} (format: ${params.format})`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: params.format === 'svg'
              ? result.data
              : `Base64 ${params.format} data (${result.data.length} chars). Use filePath to save to disk.`
          }]
        };
      }

      case 'duplicate_elements': {
        const params = z.object({
          elementIds: z.array(z.string()),
          offsetX: z.number().optional(),
          offsetY: z.number().optional()
        }).parse(args);

        const offsetX = params.offsetX ?? 20;
        const offsetY = params.offsetY ?? 20;

        logger.info('Duplicating elements via MCP', { count: params.elementIds.length });

        const duplicates: ServerElement[] = [];
        for (const id of params.elementIds) {
          const original = await getElementFromCanvas(id);
          if (!original) {
            logger.warn(`Element ${id} not found, skipping duplicate`);
            continue;
          }

          const { createdAt, updatedAt, version, syncedAt, source, syncTimestamp, ...rest } = original;
          const duplicate: ServerElement = {
            ...rest,
            id: generateId(),
            x: original.x + offsetX,
            y: original.y + offsetY,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };
          duplicates.push(duplicate);
        }

        if (duplicates.length === 0) {
          throw new Error('No elements could be duplicated (none found)');
        }

        const canvasElements = await batchCreateElementsOnCanvas(duplicates);

        return {
          content: [{
            type: 'text',
            text: `Duplicated ${duplicates.length} elements (offset: ${offsetX}, ${offsetY})\n\n${JSON.stringify(canvasElements, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'snapshot_scene': {
        const params = z.object({ name: z.string() }).parse(args);
        logger.info('Saving snapshot via MCP', { name: params.name });

        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/snapshots`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: params.name })
        });

        if (!response.ok) {
          throw new Error(`Failed to save snapshot: ${response.status} ${response.statusText}`);
        }

        const result = await response.json() as any;

        return {
          content: [{
            type: 'text',
            text: `Snapshot "${params.name}" saved (${result.elementCount} elements)\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      }

      case 'restore_snapshot': {
        const params = z.object({ name: z.string() }).parse(args);
        logger.info('Restoring snapshot via MCP', { name: params.name });

        // Fetch the snapshot
        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/snapshots/${encodeURIComponent(params.name)}`));
        if (!response.ok) {
          throw new Error(`Snapshot "${params.name}" not found`);
        }

        const data = await response.json() as { success: boolean; snapshot: { name: string; elements: ServerElement[]; createdAt: string } };

        // Clear current canvas
        await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements/clear`), { method: 'DELETE' });

        // Restore elements
        const canvasElements = await batchCreateElementsOnCanvas(data.snapshot.elements);

        return {
          content: [{
            type: 'text',
            text: `Snapshot "${params.name}" restored (${data.snapshot.elements.length} elements)\n\n✅ Canvas updated`
          }]
        };
      }

      case 'describe_scene': {
        logger.info('Describing scene via MCP');

        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements`));
        if (!response.ok) {
          throw new Error(`Failed to fetch elements: ${response.status}`);
        }

        const data = await response.json() as ApiResponse;
        const allElements = data.elements || [];

        if (allElements.length === 0) {
          return {
            content: [{ type: 'text', text: 'The canvas is empty. No elements to describe.' }]
          };
        }

        // Count by type
        const typeCounts: Record<string, number> = {};
        for (const el of allElements) {
          typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
        }

        // Bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const el of allElements) {
          minX = Math.min(minX, el.x);
          minY = Math.min(minY, el.y);
          maxX = Math.max(maxX, el.x + (el.width || 0));
          maxY = Math.max(maxY, el.y + (el.height || 0));
        }

        // Build element descriptions sorted top-to-bottom, left-to-right
        const sorted = [...allElements].sort((a, b) => {
          const rowDiff = Math.floor(a.y / 50) - Math.floor(b.y / 50);
          return rowDiff !== 0 ? rowDiff : a.x - b.x;
        });

        const elementDescs: string[] = [];
        for (const el of sorted) {
          const parts: string[] = [];
          parts.push(`[${el.id}] ${el.type}`);
          parts.push(`at (${Math.round(el.x)}, ${Math.round(el.y)})`);
          if (el.width || el.height) {
            parts.push(`size ${Math.round(el.width || 0)}x${Math.round(el.height || 0)}`);
          }
          if (el.text) parts.push(`text: "${el.text}"`);
          if (el.label?.text) parts.push(`label: "${el.label.text}"`);
          if (el.backgroundColor && el.backgroundColor !== 'transparent') {
            parts.push(`bg: ${el.backgroundColor}`);
          }
          if (el.strokeColor && el.strokeColor !== '#000000') {
            parts.push(`stroke: ${el.strokeColor}`);
          }
          if (el.locked) parts.push('(locked)');
          if (el.groupIds && el.groupIds.length > 0) {
            parts.push(`groups: [${el.groupIds.join(', ')}]`);
          }
          elementDescs.push(`  ${parts.join(' | ')}`);
        }

        // Find connections (arrows)
        const arrows = allElements.filter(el => el.type === 'arrow');
        const connectionDescs: string[] = [];
        for (const arrow of arrows) {
          const arrowAny = arrow as any;
          if (arrowAny.startBinding?.elementId || arrowAny.endBinding?.elementId) {
            const from = arrowAny.startBinding?.elementId || '?';
            const to = arrowAny.endBinding?.elementId || '?';
            connectionDescs.push(`  ${from} --> ${to} (arrow: ${arrow.id})`);
          }
        }

        // Build description
        const lines: string[] = [];
        lines.push(`## Canvas Description`);
        lines.push(`Total elements: ${allElements.length}`);
        lines.push(`Types: ${Object.entries(typeCounts).map(([t, c]) => `${t}(${c})`).join(', ')}`);
        lines.push(`Bounding box: (${Math.round(minX)}, ${Math.round(minY)}) to (${Math.round(maxX)}, ${Math.round(maxY)}) = ${Math.round(maxX - minX)}x${Math.round(maxY - minY)}`);
        lines.push('');
        lines.push('### Elements (top-to-bottom, left-to-right):');
        lines.push(...elementDescs);

        if (connectionDescs.length > 0) {
          lines.push('');
          lines.push('### Connections:');
          lines.push(...connectionDescs);
        }

        // Groups
        const groupedElements = allElements.filter(el => el.groupIds && el.groupIds.length > 0);
        if (groupedElements.length > 0) {
          const groupMap: Record<string, string[]> = {};
          for (const el of groupedElements) {
            for (const gid of (el.groupIds || [])) {
              if (!groupMap[gid]) groupMap[gid] = [];
              groupMap[gid]!.push(el.id);
            }
          }
          lines.push('');
          lines.push('### Groups:');
          for (const [gid, ids] of Object.entries(groupMap)) {
            lines.push(`  Group ${gid}: [${ids.join(', ')}]`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }]
        };
      }

      case 'get_canvas_screenshot': {
        const params = z.object({
          background: z.boolean().optional()
        }).parse(args || {});

        logger.info('Taking canvas screenshot via MCP');

        const response = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/export/image`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: 'png',
            background: params.background ?? true
          })
        });

        if (!response.ok) {
          const errorData = await response.json() as ApiResponse;
          throw new Error(errorData.error || `Screenshot failed: ${response.status}`);
        }

        const result = await response.json() as { success: boolean; format: string; data: string };

        return {
          content: [
            {
              type: 'image' as const,
              data: result.data,
              mimeType: 'image/png'
            },
            {
              type: 'text',
              text: 'Canvas screenshot captured. This is what the diagram currently looks like.'
            }
          ]
        };
      }

      case 'read_diagram_guide': {
        return {
          content: [{ type: 'text', text: DIAGRAM_DESIGN_GUIDE }]
        };
      }

      case 'export_to_excalidraw_url': {
        logger.info('Exporting to excalidraw.com URL');

        // 1. Fetch current scene elements
        const urlExportResponse = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/elements`));
        if (!urlExportResponse.ok) {
          throw new Error(`Failed to fetch elements: ${urlExportResponse.status}`);
        }
        const urlExportData = await urlExportResponse.json() as ApiResponse;
        const urlExportElements = urlExportData.elements || [];

        if (urlExportElements.length === 0) {
          throw new Error('Canvas is empty — nothing to export');
        }

        // 2. Clean elements: strip server metadata, add Excalidraw defaults,
        // generate bound text elements, and resolve arrow bindings
        const cleanedExportElements: Record<string, any>[] = [];
        const boundTextElements: Record<string, any>[] = [];
        let indexCounter = 0;

        function makeBaseElement(el: any, rest: any): Record<string, any> {
          return {
            ...rest,
            angle: rest.angle ?? 0,
            strokeColor: rest.strokeColor ?? '#1e1e1e',
            backgroundColor: rest.backgroundColor ?? 'transparent',
            fillStyle: rest.fillStyle ?? 'solid',
            strokeWidth: rest.strokeWidth ?? 2,
            strokeStyle: rest.strokeStyle ?? 'solid',
            roughness: rest.roughness ?? 1,
            opacity: rest.opacity ?? 100,
            groupIds: rest.groupIds ?? [],
            frameId: rest.frameId ?? null,
            index: rest.index ?? `a${indexCounter++}`,
            roundness: rest.roundness ?? (
              el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse'
                ? { type: 3 } : null
            ),
            seed: rest.seed ?? Math.floor(Math.random() * 2147483647),
            version: rest.version ?? 1,
            versionNonce: rest.versionNonce ?? Math.floor(Math.random() * 2147483647),
            isDeleted: false,
            boundElements: rest.boundElements ?? null,
            updated: Date.now(),
            link: rest.link ?? null,
            locked: rest.locked ?? false
          };
        }

        for (const el of urlExportElements) {
          // Strip server-only fields
          const {
            createdAt, updatedAt, syncedAt, source: _src,
            syncTimestamp, label, start, end, text,
            version: _ver,
            ...rest
          } = el as any;

          const base = makeBaseElement(el, rest);

          // Standalone text elements: keep text directly
          if (el.type === 'text') {
            base.text = text ?? '';
            base.originalText = text ?? '';
            base.fontSize = rest.fontSize ?? 20;
            base.fontFamily = normalizeFontFamily(rest.fontFamily) ?? 1;
            base.textAlign = rest.textAlign ?? 'center';
            base.verticalAlign = rest.verticalAlign ?? 'middle';
            base.autoResize = rest.autoResize ?? true;
            base.lineHeight = rest.lineHeight ?? 1.25;
            base.containerId = rest.containerId ?? null;
            cleanedExportElements.push(base);
            continue;
          }

          // Arrows: server already resolved bindings (start/end → startBinding/endBinding + positions)
          if (el.type === 'arrow' || el.type === 'line') {
            base.points = rest.points ?? [[0, 0], [100, 0]];
            base.lastCommittedPoint = null;
            // Preserve server-resolved bindings with fixedPoint for excalidraw.com
            if (rest.startBinding) {
              base.startBinding = { ...rest.startBinding, fixedPoint: rest.startBinding.fixedPoint ?? null };
            } else {
              base.startBinding = null;
            }
            if (rest.endBinding) {
              base.endBinding = { ...rest.endBinding, fixedPoint: rest.endBinding.fixedPoint ?? null };
            } else {
              base.endBinding = null;
            }
            base.startArrowhead = rest.startArrowhead ?? null;
            base.endArrowhead = rest.endArrowhead ?? (el.type === 'arrow' ? 'arrow' : null);
            base.elbowed = rest.elbowed ?? false;
          }

          // Generate bound text element for label on shapes and arrows
          const labelText = label?.text || text;
          if (labelText) {
            const textId = `${base.id}-label`;
            // Add binding reference to parent
            base.boundElements = [
              ...(Array.isArray(base.boundElements) ? base.boundElements : []),
              { type: 'text', id: textId }
            ];

            // Compute text position: centered in shape, or at arrow midpoint
            let textX: number, textY: number, textW: number, textH: number;
            const isArrow = el.type === 'arrow' || el.type === 'line';

            if (isArrow) {
              // Position at midpoint of arrow path
              const pts = base.points || [[0, 0], [100, 0]];
              const lastPt = pts[pts.length - 1];
              const midX = base.x + (lastPt[0] / 2);
              const midY = base.y + (lastPt[1] / 2);
              const labelW = Math.max(labelText.length * 10, 60);
              textX = midX - labelW / 2;
              textY = midY - 12;
              textW = labelW;
              textH = 24;
            } else {
              // Center inside shape container
              const containerW = base.width ?? 160;
              const containerH = base.height ?? 80;
              textX = base.x + 10;
              textY = base.y + containerH / 4;
              textW = containerW - 20;
              textH = containerH / 2;
            }

            boundTextElements.push({
              id: textId,
              type: 'text',
              x: textX,
              y: textY,
              width: textW,
              height: textH,
              angle: 0,
              strokeColor: isArrow ? '#1e1e1e' : base.strokeColor,
              backgroundColor: 'transparent',
              fillStyle: 'solid',
              strokeWidth: 1,
              strokeStyle: 'solid',
              roughness: 1,
              opacity: 100,
              groupIds: [],
              frameId: null,
              index: `a${indexCounter++}`,
              roundness: null,
              seed: Math.floor(Math.random() * 2147483647),
              version: 1,
              versionNonce: Math.floor(Math.random() * 2147483647),
              isDeleted: false,
              boundElements: null,
              updated: Date.now(),
              link: null,
              locked: false,
              text: labelText,
              originalText: labelText,
              fontSize: isArrow ? 14 : (rest.fontSize ?? 16),
              fontFamily: normalizeFontFamily(rest.fontFamily) ?? 1,
              textAlign: 'center',
              verticalAlign: 'middle',
              autoResize: true,
              lineHeight: 1.25,
              containerId: base.id
            });
          }

          cleanedExportElements.push(base);
        }

        // Patch shapes' boundElements to include connected arrows
        const shapeBoundArrows = new Map<string, { type: string; id: string }[]>();
        for (const el of cleanedExportElements) {
          if (el.startBinding?.elementId) {
            const arr = shapeBoundArrows.get(el.startBinding.elementId) || [];
            arr.push({ type: 'arrow', id: el.id });
            shapeBoundArrows.set(el.startBinding.elementId, arr);
          }
          if (el.endBinding?.elementId) {
            const arr = shapeBoundArrows.get(el.endBinding.elementId) || [];
            arr.push({ type: 'arrow', id: el.id });
            shapeBoundArrows.set(el.endBinding.elementId, arr);
          }
        }
        for (const el of cleanedExportElements) {
          const arrowBindings = shapeBoundArrows.get(el.id);
          if (arrowBindings) {
            el.boundElements = [
              ...(Array.isArray(el.boundElements) ? el.boundElements : []),
              ...arrowBindings
            ];
          }
        }

        // Append all bound text elements after their parents
        cleanedExportElements.push(...boundTextElements);

        // Build .excalidraw scene JSON
        const excalidrawScene = {
          type: 'excalidraw',
          version: 2,
          source: 'https://excalidraw.com',
          elements: cleanedExportElements,
          appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null
          },
          files: {}
        };
        const sceneJson = JSON.stringify(excalidrawScene);
        const dataBytes = new TextEncoder().encode(sceneJson);

        // Excalidraw's concatBuffers: [4-byte version=1][4-byte len][chunk]...
        function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        }

        const encoder = new TextEncoder();

        // 3. Inner data: concatBuffers(fileMetadata, dataJSON)
        const fileMetadata = encoder.encode('{}');
        const innerData = concatBuffers(fileMetadata, dataBytes);

        // 4. Compress with zlib deflate
        const compressed = deflateSync(Buffer.from(innerData));

        // 5. Encrypt with AES-GCM 128-bit key
        const cryptoKey = await webcrypto.subtle.generateKey(
          { name: 'AES-GCM', length: 128 },
          true,
          ['encrypt']
        );

        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const encrypted = await webcrypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          cryptoKey,
          compressed
        );

        // 6. Outer payload: concatBuffers(encodingMeta, iv, ciphertext)
        const encodingMeta = encoder.encode(JSON.stringify({
          version: 2,
          compression: 'pako@1',
          encryption: 'AES-GCM'
        }));
        const ciphertext = new Uint8Array(encrypted);
        const payload = concatBuffers(encodingMeta, iv, ciphertext);

        // 7. POST to excalidraw.com JSON store
        const uploadResponse = await fetch('https://json.excalidraw.com/api/v2/post/', {
          method: 'POST',
          body: Buffer.from(payload)
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload to excalidraw.com failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
        }

        const uploadResult = await uploadResponse.json() as { id: string };

        // 8. Export key as JWK to get the "k" field
        const jwk = await webcrypto.subtle.exportKey('jwk', cryptoKey);

        // 9. Build shareable URL
        const shareUrl = `https://excalidraw.com/#json=${uploadResult.id},${jwk.k}`;

        return {
          content: [{
            type: 'text',
            text: `Diagram exported to excalidraw.com!\n\nShareable URL: ${shareUrl}\n\nAnyone with this link can view and edit the diagram.`
          }]
        };
      }

      case 'set_viewport': {
        const viewportParams = z.object({
          scrollToContent: z.boolean().optional(),
          scrollToElementId: z.string().optional(),
          zoom: z.number().min(0.1).max(10).optional(),
          offsetX: z.number().optional(),
          offsetY: z.number().optional()
        }).parse(args || {});

        logger.info('Setting viewport via MCP', viewportParams);

        const viewportResponse = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/viewport`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(viewportParams)
        });

        if (!viewportResponse.ok) {
          const viewportError = await viewportResponse.json() as ApiResponse;
          throw new Error(viewportError.error || `Viewport request failed: ${viewportResponse.status}`);
        }

        const viewportResult = await viewportResponse.json() as { success: boolean; message?: string };

        return {
          content: [{
            type: 'text',
            text: `Viewport updated successfully.\n\n${JSON.stringify(viewportResult, null, 2)}`
          }]
        };
      }

      case 'undo': {
        const undoResponse = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/undo`), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const undoResult = await undoResponse.json() as any;
        return {
          content: [{ type: 'text', text: JSON.stringify(undoResult, null, 2) }]
        };
      }

      case 'redo': {
        const redoResponse = await fetch(withCanvasId(`${EXPRESS_SERVER_URL}/api/redo`), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const redoResult = await redoResponse.json() as any;
        return {
          content: [{ type: 'text', text: JSON.stringify(redoResult, null, 2) }]
        };
      }

      case 'get_canvas_url': {
        return {
          content: [{ type: 'text', text: `Canvas URL: ${EXPRESS_SERVER_URL}${CANVAS_ID !== 'default' ? `/?canvasId=${CANVAS_ID}` : ''}` }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error(`Error handling tool call: ${(error as Error).message}`, { error });
    return {
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }
}
