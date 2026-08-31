import { describe, it, expect } from 'vitest';
import { generateId, normalizeFontFamily, validateElement } from '../types.js';

describe('generateId', () => {
  it('returns unique strings', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('normalizeFontFamily', () => {
  it('maps virgil to 1', () => {
    expect(normalizeFontFamily('virgil')).toBe(1);
  });

  it('maps helvetica to 2', () => {
    expect(normalizeFontFamily('helvetica')).toBe(2);
  });

  it('maps mono to 3', () => {
    expect(normalizeFontFamily('mono')).toBe(3);
  });

  it('maps hand to 1', () => {
    expect(normalizeFontFamily('hand')).toBe(1);
  });

  it('maps sans-serif to 2', () => {
    expect(normalizeFontFamily('sans-serif')).toBe(2);
  });

  it('maps excalifont to 5', () => {
    expect(normalizeFontFamily('excalifont')).toBe(5);
  });

  it('maps nunito to 6', () => {
    expect(normalizeFontFamily('nunito')).toBe(6);
  });

  it('maps comic shanns to 8', () => {
    expect(normalizeFontFamily('comic shanns')).toBe(8);
  });

  it('passes through numbers unchanged', () => {
    expect(normalizeFontFamily(1)).toBe(1);
    expect(normalizeFontFamily(3)).toBe(3);
    expect(normalizeFontFamily(5)).toBe(5);
  });

  it('returns undefined for undefined', () => {
    expect(normalizeFontFamily(undefined)).toBeUndefined();
  });

  it('is case insensitive', () => {
    expect(normalizeFontFamily('Virgil')).toBe(1);
    expect(normalizeFontFamily('HELVETICA')).toBe(2);
  });
});

describe('validateElement', () => {
  it('throws on missing required fields', () => {
    expect(() => validateElement({ type: 'rectangle' })).toThrow('Missing required fields');
  });

  it('throws on missing type', () => {
    expect(() => validateElement({ x: 0, y: 0 })).toThrow('Missing required fields');
  });

  it('throws on missing x', () => {
    expect(() => validateElement({ type: 'rectangle', y: 0 })).toThrow('Missing required fields');
  });

  it('throws on invalid type', () => {
    expect(() => validateElement({ type: 'invalid' as any, x: 0, y: 0 })).toThrow('Invalid element type');
  });

  it('returns true for valid element', () => {
    expect(validateElement({ type: 'rectangle', x: 10, y: 20 })).toBe(true);
  });
});
