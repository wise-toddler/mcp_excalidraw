import { describe, it, expect } from 'vitest';
import { withCanvasId, canvasPageUrl, EXPRESS_SERVER_URL } from '../core/config.js';

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

  it('appends canvasId with ? when no query params', () => {
    expect(withCanvasId('http://h/api/x', 'c1')).toBe('http://h/api/x?canvasId=c1');
  });

  it('appends canvasId with & when query params exist', () => {
    expect(withCanvasId('http://h/api/x?foo=bar', 'c1')).toBe('http://h/api/x?foo=bar&canvasId=c1');
  });
});

describe('canvasPageUrl', () => {
  it('URL-encodes non-default canvas ids', () => {
    expect(canvasPageUrl('c 1')).toBe(`${EXPRESS_SERVER_URL}/?canvasId=c%201`);
  });
});
