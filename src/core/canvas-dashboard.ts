// Pure HTML renderer for the canvas dashboard page (GET /canvases)

export interface CanvasSummary {
  id: string;
  elementCount: number;
  fileCount: number;
  snapshotCount: number;
  createdAt: string;
  lastAccessedAt: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderCanvasDashboard(list: CanvasSummary[]): string {
  return `<!DOCTYPE html>
<html><head><title>Excalidraw Canvases</title>
<style>
  body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 20px; }
  h1 { color: #1e1e1e; }
  .canvas-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin: 12px 0; display: flex; justify-content: space-between; align-items: center; }
  .canvas-card:hover { background: #f5f5f5; }
  .canvas-info { flex: 1; }
  .canvas-name { font-weight: 600; font-size: 18px; }
  .canvas-meta { color: #666; font-size: 14px; margin-top: 4px; }
  .canvas-link { padding: 8px 16px; background: #1971c2; color: white; text-decoration: none; border-radius: 6px; }
  .canvas-link:hover { background: #1561a9; }
</style></head><body>
<h1>Excalidraw Canvases</h1>
<p>${list.length} canvas${list.length !== 1 ? 'es' : ''} active</p>
${list.map(c => `
<div class="canvas-card">
  <div class="canvas-info">
    <div class="canvas-name">${escapeHtml(c.id)}</div>
    <div class="canvas-meta">${c.elementCount} elements &middot; ${c.fileCount} files &middot; Created: ${new Date(c.createdAt).toLocaleString()}</div>
  </div>
  <a class="canvas-link" href="/?canvasId=${encodeURIComponent(c.id)}">Open</a>
</div>`).join('')}
</body></html>`;
}
