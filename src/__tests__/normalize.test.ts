import { describe, it, expect } from 'vitest';
import { normalizePoints, convertTextToLabel, sanitizeFilePath, prepareElementUpdate, normalizeLabel } from '../core/normalize.js';
import { ServerElement } from '../types.js';

describe('normalizePoints', () => {
  it('converts {x,y} objects to [x,y] tuples', () => {
    const result = normalizePoints([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
    expect(result).toEqual([[10, 20], [30, 40]]);
  });

  it('passes through tuples unchanged', () => {
    const result = normalizePoints([[5, 10], [15, 20]]);
    expect(result).toEqual([[5, 10], [15, 20]]);
  });

  it('handles mixed input', () => {
    const result = normalizePoints([{ x: 1, y: 2 }, [3, 4]]);
    expect(result).toEqual([[1, 2], [3, 4]]);
  });
});

describe('convertTextToLabel', () => {
  it('converts text to label on shapes', () => {
    const element = { id: '1', type: 'rectangle', x: 0, y: 0, text: 'Hello' } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result.label).toEqual({ text: 'Hello' });
    expect((result as any).text).toBeUndefined();
  });

  it('leaves text elements unchanged', () => {
    const element = { id: '1', type: 'text', x: 0, y: 0, text: 'Hello' } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result.text).toBe('Hello');
    expect(result.type).toBe('text');
  });

  it('returns element as-is when no text', () => {
    const element = { id: '1', type: 'rectangle', x: 0, y: 0 } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result).toEqual(element);
  });

  it('propagates fontSize into the label (issue #11)', () => {
    const element = { id: '1', type: 'rectangle', x: 0, y: 0, text: 'Hi', fontSize: 28 } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result.label).toEqual({ text: 'Hi', fontSize: 28 });
  });

  it('normalizes fontFamily string into the label', () => {
    const element = { id: '1', type: 'rectangle', x: 0, y: 0, text: 'Hi', fontFamily: 'mono' } as ServerElement;
    const result = convertTextToLabel(element);
    expect(result.label).toEqual({ text: 'Hi', fontFamily: 3 });
  });
});

describe('sanitizeFilePath', () => {
  it('allows paths under cwd', () => {
    const result = sanitizeFilePath(process.cwd() + '/test-output.png');
    expect(result).toContain('test-output.png');
  });

  it('allows /tmp paths', () => {
    const result = sanitizeFilePath('/tmp/export.png');
    expect(result).toContain('export.png');
  });

  it('blocks /etc/passwd traversal', () => {
    expect(() => sanitizeFilePath('/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks relative traversal', () => {
    expect(() => sanitizeFilePath('../../etc/passwd')).toThrow('Path traversal blocked');
  });
});

describe('prepareElementUpdate', () => {
  it('propagates fontSize into the label on text updates (issue #11)', () => {
    const result = prepareElementUpdate('id', { text: 'x', fontSize: 20 }, 'rectangle');
    expect(result.label?.text).toBe('x');
    expect(result.label?.fontSize).toBe(20);
  });
});

describe('normalizeLabel', () => {
  it('normalizes string fontFamily to numeric', () => {
    const result = normalizeLabel({ text: 'a', fontFamily: 'mono' });
    expect(result?.fontFamily).toBe(3);
  });
});
