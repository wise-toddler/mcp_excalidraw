import { describe, it, expect } from 'vitest';
import {
  ElementSchema,
  AlignElementsSchema,
  DistributeElementsSchema,
} from '../core/mcp-dispatch.js';
import { CreateElementSchema, UpdateElementSchema } from '../server.js';

describe('ElementSchema', () => {
  it('validates correct element', () => {
    const result = ElementSchema.safeParse({
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing type', () => {
    const result = ElementSchema.safeParse({ x: 10, y: 20 });
    expect(result.success).toBe(false);
  });

  it('rejects missing x', () => {
    const result = ElementSchema.safeParse({ type: 'rectangle', y: 20 });
    expect(result.success).toBe(false);
  });

  it('rejects missing y', () => {
    const result = ElementSchema.safeParse({ type: 'rectangle', x: 10 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type', () => {
    const result = ElementSchema.safeParse({ type: 'invalid', x: 0, y: 0 });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const result = ElementSchema.safeParse({
      type: 'text',
      x: 0,
      y: 0,
      text: 'hello',
      fontSize: 16,
      fontFamily: 'virgil',
    });
    expect(result.success).toBe(true);
  });
});

describe('CreateElementSchema', () => {
  it('validates with optional id', () => {
    const result = CreateElementSchema.safeParse({
      id: 'custom-id',
      type: 'ellipse',
      x: 0,
      y: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('custom-id');
    }
  });

  it('validates without id', () => {
    const result = CreateElementSchema.safeParse({
      type: 'rectangle',
      x: 5,
      y: 10,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing type', () => {
    const result = CreateElementSchema.safeParse({ x: 0, y: 0 });
    expect(result.success).toBe(false);
  });

  it('keeps label fontSize and fontFamily (issue #11)', () => {
    const result = CreateElementSchema.safeParse({
      type: 'rectangle',
      x: 0,
      y: 0,
      label: { text: 'a', fontSize: 20, fontFamily: 'mono' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toEqual({ text: 'a', fontSize: 20, fontFamily: 'mono' });
    }
  });
});

describe('UpdateElementSchema', () => {
  it('requires id', () => {
    const result = UpdateElementSchema.safeParse({ x: 10 });
    expect(result.success).toBe(false);
  });

  it('validates with id and partial update', () => {
    const result = UpdateElementSchema.safeParse({
      id: 'elem-1',
      x: 50,
      backgroundColor: '#ff0000',
    });
    expect(result.success).toBe(true);
  });
});

describe('AlignElementsSchema', () => {
  it('validates alignment enum', () => {
    for (const alignment of ['left', 'center', 'right', 'top', 'middle', 'bottom']) {
      const result = AlignElementsSchema.safeParse({
        elementIds: ['a', 'b'],
        alignment,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid alignment', () => {
    const result = AlignElementsSchema.safeParse({
      elementIds: ['a'],
      alignment: 'diagonal',
    });
    expect(result.success).toBe(false);
  });
});

describe('DistributeElementsSchema', () => {
  it('validates direction enum', () => {
    for (const direction of ['horizontal', 'vertical']) {
      const result = DistributeElementsSchema.safeParse({
        elementIds: ['a', 'b', 'c'],
        direction,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid direction', () => {
    const result = DistributeElementsSchema.safeParse({
      elementIds: ['a'],
      direction: 'diagonal',
    });
    expect(result.success).toBe(false);
  });
});
