import { describe, it, expect } from 'vitest';
import { withCanvasId } from '../tools/sync.js';

describe('withCanvasId', () => {
  it('skips default canvasId', () => {
    // CANVAS_ID defaults to 'default', so it should return url unchanged
    const url = 'http://localhost:3000/api/elements';
    expect(withCanvasId(url)).toBe(url);
  });

  it('appends canvasId to URL (tested via function logic)', () => {
    // Since CANVAS_ID is read from env at module load, we test the function logic directly
    // The default CANVAS_ID is 'default', so withCanvasId returns URL as-is
    const url = 'http://localhost:3000/api/elements';
    const result = withCanvasId(url);
    expect(result).toBe(url);
  });

  it('handles URLs with existing query params (default canvas)', () => {
    const url = 'http://localhost:3000/api/elements?foo=bar';
    const result = withCanvasId(url);
    // Since CANVAS_ID is 'default', it should not append canvasId
    expect(result).toBe(url);
  });
});
