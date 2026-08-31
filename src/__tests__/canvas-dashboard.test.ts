import { describe, it, expect } from 'vitest';
import { renderCanvasDashboard, CanvasSummary } from '../core/canvas-dashboard.js';

const summary = (id: string): CanvasSummary => ({
  id,
  elementCount: 1,
  fileCount: 0,
  snapshotCount: 0,
  createdAt: new Date().toISOString(),
  lastAccessedAt: new Date().toISOString(),
});

describe('renderCanvasDashboard', () => {
  it('renders the title and every canvas id', () => {
    const html = renderCanvasDashboard([summary('default'), summary('scratch')]);
    expect(html).toContain('Excalidraw Canvases');
    expect(html).toContain('default');
    expect(html).toContain('scratch');
    expect(html).toContain('/?canvasId=scratch');
  });

  it('escapes HTML in canvas ids', () => {
    const html = renderCanvasDashboard([summary('<script>alert(1)</script>')]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
