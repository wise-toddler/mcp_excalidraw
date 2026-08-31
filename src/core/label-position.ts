import { generateId, normalizeFontFamily } from '../types.js';
import type { ElementInput } from './normalize.js';

export const LABEL_POSITIONS = [
  'center',
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
] as const;
export type LabelPosition = typeof LABEL_POSITIONS[number];

// Expand a raw element input carrying a non-center labelPosition into the
// shape (text stripped) plus a free-standing text element placed at that
// corner/edge. This runs on RAW input BEFORE prepareElement, so the
// text→label conversion never consumes the text first (the fork ran
// convertTextToLabel first, which left its labelPosition branch dead for
// batch creates). labelPosition is always stripped from the returned shape
// so it never leaks into the REST payload.
export function expandLabelPosition(input: ElementInput): ElementInput[] {
  const { labelPosition: rawLabelPosition, ...rest } = input;
  const labelPosition = rawLabelPosition as LabelPosition | undefined;

  if (
    labelPosition === undefined ||
    labelPosition === 'center' ||
    !rest.text ||
    rest.type === 'text' ||
    rest.type === 'arrow' ||
    rest.type === 'line'
  ) {
    return [rest];
  }

  const x = rest.x as number;
  const y = rest.y as number;
  const W = (rest.width as number | undefined) ?? 160;
  const H = (rest.height as number | undefined) ?? 80;
  const pad = 10;
  const tw = 100; // assumed text width for right-edge placement
  const th = 24; // assumed text height for bottom-edge placement

  let textX = x + pad;
  let textY = y + pad;
  switch (labelPosition) {
    case 'top-left': textX = x + pad; textY = y + pad; break;
    case 'top-center': textX = x + W / 4; textY = y + pad; break;
    case 'top-right': textX = x + W - pad - tw; textY = y + pad; break;
    case 'bottom-left': textX = x + pad; textY = y + H - pad - th; break;
    case 'bottom-center': textX = x + W / 4; textY = y + H - pad - th; break;
    case 'bottom-right': textX = x + W - pad - tw; textY = y + H - pad - th; break;
  }

  const shape: ElementInput = { ...rest };
  delete shape.text;

  const textElement: ElementInput = {
    id: generateId(),
    type: 'text',
    x: textX,
    y: textY,
    width: W / 2,
    height: th,
    text: rest.text,
    fontSize: (rest.fontSize as number | undefined) ?? 16,
    fontFamily: normalizeFontFamily(rest.fontFamily) ?? 1,
    ...(rest.strokeColor !== undefined ? { strokeColor: rest.strokeColor } : {})
  };

  return [shape, textElement];
}
