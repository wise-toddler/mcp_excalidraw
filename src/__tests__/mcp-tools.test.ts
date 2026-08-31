import { describe, it, expect } from 'vitest';
import { tools } from '../core/mcp-tools.js';
import { LABEL_POSITIONS } from '../core/label-position.js';

describe('MCP tool definitions', () => {
  it('exposes 30 tools', () => {
    expect(tools).toHaveLength(30);
  });

  it('includes batch_update_elements, undo, redo and get_canvas_url', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('batch_update_elements');
    expect(names).toContain('undo');
    expect(names).toContain('redo');
    expect(names).toContain('get_canvas_url');
  });

  it('exposes labelPosition with 7 enum values on create_element and batch_create_elements', () => {
    const createElement = tools.find(t => t.name === 'create_element')!;
    const batchCreate = tools.find(t => t.name === 'batch_create_elements')!;

    const createProp = (createElement.inputSchema as any).properties.labelPosition;
    expect(createProp.enum).toEqual([...LABEL_POSITIONS]);
    expect(createProp.enum).toHaveLength(7);

    const batchProp = (batchCreate.inputSchema as any).properties.elements.items.properties.labelPosition;
    expect(batchProp.enum).toEqual([...LABEL_POSITIONS]);
    expect(batchProp.enum).toHaveLength(7);
  });
});
