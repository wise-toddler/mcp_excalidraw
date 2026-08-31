import path from 'path';
import { generateId, ServerElement, normalizeFontFamily } from '../types.js';
import { ALLOWED_EXPORT_DIRS } from './config.js';
import { expandLabelPosition } from './label-position.js';
import { autoSizeElement } from './layout-checks.js';

// Safe file path validation to prevent path traversal attacks
export function sanitizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_EXPORT_DIRS.some(dir =>
    resolved === dir || resolved.startsWith(dir + path.sep)
  );
  if (!allowed) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside allowed directories. ` +
      `Set EXCALIDRAW_EXPORT_DIR to add more allowed directories (${path.delimiter}-separated).`
    );
  }
  return resolved;
}

// Normalize points to [x, y] tuple format that Excalidraw expects
export function normalizePoints(points: Array<{ x: number; y: number } | [number, number]>): [number, number][] {
  return points.map(p => {
    if (Array.isArray(p)) return p as [number, number];
    return [p.x, p.y] as [number, number];
  });
}

// Helper function to convert text property to label format for Excalidraw
export function convertTextToLabel(element: ServerElement): ServerElement {
  const { text, ...rest } = element;
  if (text) {
    // For standalone text elements, keep text as direct property
    if (element.type === 'text') {
      return element; // Keep text as direct property
    }
    // For other elements (rectangle, ellipse, diamond), convert to label format.
    // Propagate fontSize/fontFamily into the label — Excalidraw's convertToExcalidrawElements
    // reads these from the label object, NOT the container shape. Without this the bound
    // text renders at the default size regardless of the requested fontSize (issue #11).
    const label: NonNullable<ServerElement['label']> = { text };
    if (element.fontSize !== undefined) label.fontSize = element.fontSize as number;
    const ff = normalizeFontFamily(element.fontFamily as any);
    if (ff !== undefined) label.fontFamily = ff;
    return {
      ...rest,
      label
    } as ServerElement;
  }
  return element;
}

// Normalize a label's fontFamily to the numeric value Excalidraw expects.
// Direct REST callers may pass a string fontFamily (e.g. "helvetica") on the label.
export function normalizeLabel(label: ServerElement['label']): ServerElement['label'] {
  if (!label) return label;
  const ff = normalizeFontFamily(label.fontFamily);
  return ff !== undefined ? { ...label, fontFamily: ff } : label;
}

// Rehydrate the fork's `start`/`end` refs from Excalidraw's
// `startBinding`/`endBinding` on an incoming scene. Exports (and any scene
// authored on excalidraw.com) carry only the bindings, so without this an
// imported arrow renders bound but behaves unbound on the server: the
// re-routing that follows `start.id`/`end.id` stops dragging it along when a
// bound shape is moved (#14). An explicit ref always wins, and a binding
// pointing outside the scene is left untouched.
export function rehydrateArrowRefs<T extends { id?: string; type?: string }>(sceneElements: T[]): T[] {
  const ids = new Set(sceneElements.map(el => (el as any)?.id).filter(Boolean));
  return sceneElements.map(el => {
    const arrow = el as any;
    if (!arrow || (arrow.type !== 'arrow' && arrow.type !== 'line')) return el;
    const startId = arrow.startBinding?.elementId;
    const endId = arrow.endBinding?.elementId;
    const patch: Record<string, { id: string }> = {};
    if (!arrow.start && startId && ids.has(startId)) patch.start = { id: startId };
    if (!arrow.end && endId && ids.has(endId)) patch.end = { id: endId };
    return Object.keys(patch).length > 0 ? { ...arrow, ...patch } : el;
  });
}

export interface ElementInput {
  id?: string;
  type: string;
  points?: Array<{ x: number; y: number } | [number, number]>;
  startElementId?: string;
  endElementId?: string;
  fontFamily?: string | number;
  [key: string]: unknown;
}

// Shared element preparation: id generation, arrow binding conversion,
// fontFamily normalization, default points for bound arrows, timestamps,
// and text→label conversion. Used by create/batch-create in both the MCP
// server and the CLI so the two front-ends produce identical elements.
export function prepareElement(rawElementData: ElementInput): ServerElement {
  // Size text-bearing shapes that came without width/height (#10). A no-op
  // when prepareElements already sized them ahead of labelPosition expansion.
  const elementData = autoSizeElement(rawElementData);
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
  } as ServerElement;

  // Normalize fontFamily from string names to numeric values
  if (element.fontFamily !== undefined) {
    element.fontFamily = normalizeFontFamily(element.fontFamily);
  }

  // For bound arrows without explicit points, set a default
  if ((startElementId || endElementId) && !elementProps.points) {
    (element as any).points = [[0, 0], [100, 0]];
  }

  // Convert text to label format for Excalidraw
  return convertTextToLabel(element);
}

// Prepare a batch of raw inputs: labelPosition expansion must run BEFORE
// prepareElement so convertTextToLabel doesn't consume `text` first, and
// auto-sizing runs before that again so the free-standing label is placed
// against the sized shape rather than the 160x80 fallback.
export function prepareElements(inputs: ElementInput[]): ServerElement[] {
  return inputs.map(autoSizeElement).flatMap(expandLabelPosition).map(prepareElement);
}

// Shared update-payload preparation (points, fontFamily, text→label,
// updatedAt) — used by the MCP update_element tool and the CLI.
//
// `knownType` is the element's actual type as fetched from the canvas.
// Update payloads usually don't carry `type`, and text→label conversion must
// only happen for non-text elements — converting a standalone text element's
// `text` into `label` silently fails to change the visible text.
export function prepareElementUpdate(
  id: string,
  updates: Record<string, unknown>,
  knownType?: string
): Partial<ServerElement> & { id: string } {
  const { points: rawPoints, ...rest } = updates as {
    points?: Array<{ x: number; y: number } | [number, number]>;
    [key: string]: unknown;
  };

  const updatePayload: Partial<ServerElement> & { id: string } = {
    id,
    ...rest,
    points: rawPoints ? normalizePoints(rawPoints) : undefined,
    updatedAt: new Date().toISOString()
  };

  if (updatePayload.fontFamily !== undefined) {
    updatePayload.fontFamily = normalizeFontFamily(updatePayload.fontFamily);
  }

  // Convert text→label only when the element is known to be a non-text
  // shape. Unknown type keeps `text` as-is (the safe direction for text
  // elements; when the canvas is up, callers always know the type).
  const effectiveType = (updates.type as string | undefined) ?? knownType;
  if (updatePayload.text !== undefined && effectiveType && effectiveType !== 'text') {
    const { text, ...withoutText } = updatePayload;
    // Propagate fontSize/fontFamily into the label (issue #11) so
    // `update_element --fontSize` on a labelled shape resizes its text too.
    const label: NonNullable<ServerElement['label']> = { text: text as string };
    if (updatePayload.fontSize !== undefined) label.fontSize = updatePayload.fontSize as number;
    if (updatePayload.fontFamily !== undefined) label.fontFamily = updatePayload.fontFamily;
    return { ...withoutText, label } as Partial<ServerElement> & { id: string };
  }

  return updatePayload;
}
