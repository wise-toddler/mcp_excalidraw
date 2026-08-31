// Text-based layout feedback so an agent drawing blind (no screenshot) still
// learns when its scene collides, overflows, or duplicated a label. Everything
// here is a *warning*: layout problems must never fail a create/update.
import { ServerElement } from '../types.js';

export interface LayoutWarning {
  kind: 'overlap' | 'text-overflow' | 'duplicate-label';
  elementIds: string[];
  message: string;
  suggestion?: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Excalidraw's default font size when an element carries none
const DEFAULT_FONT_SIZE = 20;
// Breathing room suggested on top of the measured overlap depth
const GAP = 20;
// Types checked for overlap: solid, filled shapes. Arrows/lines/text are
// expected to cross things and would drown the signal in noise.
const SOLID_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image']);

// Rough render size of a text block. Deliberately an over-estimate: line
// height ~1.5x plus container padding, glyph width ~0.6em.
export function estimateTextSize(text: string, fontSize?: number): { width: number; height: number } {
  const size = fontSize || DEFAULT_FONT_SIZE;
  const lines = text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: longest * size * 0.6,
    height: Math.max(1, lines.length) * size * 1.5 + 20
  };
}

// Shapes an agent creates with text but no width/height: size the box from the
// text instead of leaving it at the client default — forgetting the manual
// `max(200, chars*10+40)` formula is the #1 cause of truncated labels (#10).
// Deliberately shares estimateTextSize with the overflow check above, so an
// auto-sized box can never trigger its own text-overflow warning.
const AUTO_SIZE_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);
const MIN_AUTO_WIDTH = 200;
const MIN_AUTO_HEIGHT = 70;
const AUTO_WIDTH_PADDING = 40;
const AUTO_HEIGHT_PADDING = 20;
// An ellipse's inscribed text area is smaller than its bounding box
const ELLIPSE_WIDTH_FACTOR = 1.5;
const ELLIPSE_HEIGHT_FACTOR = 1.3;

// Fill in a missing width/height on a text-bearing shape. An explicitly
// supplied dimension is never overridden, and elements without text (or of
// any other type) are returned untouched. Create paths only — updates and
// imports carry real dimensions.
export function autoSizeElement<T extends { type?: string; width?: unknown; height?: unknown }>(el: T): T {
  if (!el || !el.type || !AUTO_SIZE_TYPES.has(el.type)) return el;
  const needsWidth = el.width == null;
  const needsHeight = el.height == null;
  if (!needsWidth && !needsHeight) return el;

  const contained = containedText(el as unknown as ServerElement);
  if (!contained?.text) return el;

  const needed = estimateTextSize(contained.text, contained.fontSize);
  const isEllipse = el.type === 'ellipse';
  const patch: Record<string, number> = {};
  if (needsWidth) {
    patch.width = Math.ceil(
      Math.max(MIN_AUTO_WIDTH, needed.width + AUTO_WIDTH_PADDING) * (isEllipse ? ELLIPSE_WIDTH_FACTOR : 1)
    );
  }
  if (needsHeight) {
    patch.height = Math.ceil(
      Math.max(MIN_AUTO_HEIGHT, needed.height + AUTO_HEIGHT_PADDING) * (isEllipse ? ELLIPSE_HEIGHT_FACTOR : 1)
    );
  }
  return { ...el, ...patch };
}

// Axis-aligned bounding box. Shapes use their own box; arrows/lines/freedraw
// derive one from their points (bounds only — they are never overlap-checked);
// text falls back to the estimate when the canvas has not measured it yet.
export function getElementBounds(el: ServerElement): Bounds {
  const points = Array.isArray(el.points) ? el.points : undefined;
  if (points && points.length > 0 && (el.type === 'arrow' || el.type === 'line' || el.type === 'freedraw')) {
    const xs = points.map((p: any) => (Array.isArray(p) ? p[0] : p.x));
    const ys = points.map((p: any) => (Array.isArray(p) ? p[1] : p.y));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: el.x + minX,
      y: el.y + minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY
    };
  }

  if (el.type === 'text') {
    const estimated = estimateTextSize(el.text || '', el.fontSize);
    return {
      x: el.x,
      y: el.y,
      width: el.width ?? estimated.width,
      height: el.height ?? estimated.height
    };
  }

  return { x: el.x, y: el.y, width: el.width || 0, height: el.height || 0 };
}

export function aabbIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;
}

// True when `inner` sits entirely inside `outer` — the background-zone pattern
// (a big container rectangle behind a cluster), which is intentional.
export function fullyContains(outer: Bounds, inner: Bounds): boolean {
  return outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
}

function sharesGroup(a: ServerElement, b: ServerElement): boolean {
  const groups = a.groupIds || [];
  return groups.length > 0 && (b.groupIds || []).some(g => groups.includes(g));
}

function quote(text: string): string {
  const flat = text.replace(/\n/g, ' ');
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat;
}

// The text an element renders inside its own box (bound label or shape text)
function containedText(el: ServerElement): { text: string; fontSize?: number } | null {
  if (el.label?.text) return { text: el.label.text, fontSize: el.label.fontSize ?? el.fontSize };
  if (el.type !== 'text' && el.text) return { text: el.text, fontSize: el.fontSize };
  return null;
}

function overlapWarnings(candidates: ServerElement[]): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (sharesGroup(a, b)) continue;

      const ba = getElementBounds(a);
      const bb = getElementBounds(b);
      if (!aabbIntersect(ba, bb)) continue;
      // Background zone containing a child: intentional, not a collision
      if (fullyContains(ba, bb) || fullyContains(bb, ba)) continue;

      const overlapX = Math.min(ba.x + ba.width, bb.x + bb.width) - Math.max(ba.x, bb.x);
      const overlapY = Math.min(ba.y + ba.height, bb.y + bb.height) - Math.max(ba.y, bb.y);

      let suggestion: string;
      if (overlapY <= overlapX) {
        const lower = ba.y >= bb.y ? a : b;
        suggestion = `move ${lower.id} down by ${Math.round(overlapY) + GAP}px`;
      } else {
        const righter = ba.x >= bb.x ? a : b;
        suggestion = `move ${righter.id} right by ${Math.round(overlapX) + GAP}px`;
      }

      warnings.push({
        kind: 'overlap',
        elementIds: [a.id, b.id],
        message: `${a.type} ${a.id} and ${b.type} ${b.id} overlap by ${Math.round(overlapX)}x${Math.round(overlapY)}px`,
        suggestion
      });
    }
  }
  return warnings;
}

function textOverflowWarnings(all: ServerElement[]): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  const byId = new Map(all.map(el => [el.id, el]));
  // A container checked through its own label must not be reported twice via
  // the bound text element that mirrors it.
  const reported = new Set<string>();

  const check = (container: ServerElement, text: string, fontSize: number | undefined, ids: string[]): void => {
    if (reported.has(container.id)) return;
    const width = container.width;
    const height = container.height;
    if (!width && !height) return;

    const needed = estimateTextSize(text, fontSize);
    const tooTall = height !== undefined && height > 0 && needed.height > height;
    const tooWide = width !== undefined && width > 0 && needed.width > width;
    if (!tooTall && !tooWide) return;

    const fixes: string[] = [];
    if (tooTall) fixes.push(`increase height to ≥${Math.ceil(needed.height)}px`);
    if (tooWide) fixes.push(`increase width to ≥${Math.ceil(needed.width)}px`);

    reported.add(container.id);
    warnings.push({
      kind: 'text-overflow',
      elementIds: ids,
      message: `text "${quote(text)}" in ${container.type} ${container.id} needs ~${Math.ceil(needed.width)}x${Math.ceil(needed.height)}px but the element is ${Math.round(width || 0)}x${Math.round(height || 0)}px`,
      suggestion: fixes.join(' and ')
    });
  };

  for (const el of all) {
    const own = containedText(el);
    if (own) check(el, own.text, own.fontSize, [el.id]);
  }

  // Bound text elements (post-sync shape: the text lives beside its container)
  for (const el of all) {
    if (el.type !== 'text' || !el.containerId || !el.text) continue;
    const container = byId.get(el.containerId);
    if (container) check(container, el.text, el.fontSize, [container.id, el.id]);
  }

  return warnings;
}

function duplicateLabelWarnings(all: ServerElement[]): LayoutWarning[] {
  const byContainer = new Map<string, string[]>();
  for (const el of all) {
    if (el.type !== 'text' || !el.containerId) continue;
    const siblings = byContainer.get(el.containerId) || [];
    siblings.push(el.id);
    byContainer.set(el.containerId, siblings);
  }

  const warnings: LayoutWarning[] = [];
  for (const [containerId, textIds] of byContainer) {
    if (textIds.length < 2) continue;
    warnings.push({
      kind: 'duplicate-label',
      elementIds: [containerId, ...textIds],
      message: `${containerId} has ${textIds.length} bound text elements (${textIds.join(', ')}) — labels are stacked on top of each other`,
      suggestion: `delete the extra text element(s): ${textIds.slice(1).join(', ')}`
    });
  }
  return warnings;
}

// Run every layout check over a whole scene.
export function checkLayout(allElements: ServerElement[]): LayoutWarning[] {
  const live = allElements.filter(el => el && !el.isDeleted);
  const solids = live.filter(el => SOLID_TYPES.has(el.type));
  return [
    ...overlapWarnings(solids),
    ...textOverflowWarnings(live),
    ...duplicateLabelWarnings(live)
  ];
}

// Warnings a mutation is responsible for: at least one element from the
// request must be involved, so pre-existing mess doesn't spam every response.
// Never throws — a layout check must not turn a successful write into an error.
export function warningsForElements(allElements: ServerElement[], elementIds: string[]): LayoutWarning[] {
  try {
    const touched = new Set(elementIds);
    return checkLayout(allElements).filter(w => w.elementIds.some(id => touched.has(id)));
  } catch {
    return [];
  }
}
