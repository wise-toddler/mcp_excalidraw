// Canvas identity for multi-canvas support: read once from the page URL.
export const canvasId = new URLSearchParams(window.location.search).get('canvasId') || 'default';

// Append the page's canvasId to a same-origin URL (no-op on the default canvas).
export function withCanvasId(url: string): string {
  if (canvasId === 'default') return url;
  return `${url}${url.includes('?') ? '&' : '?'}canvasId=${encodeURIComponent(canvasId)}`;
}

if (canvasId !== 'default') {
  document.title = `Excalidraw — ${canvasId}`;
  // covers every relative /api/ fetch in App.tsx; Request objects and absolute URLs
  // bypass this — check on each upstream App.tsx merge (grep fetch()
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === 'string' && input.startsWith('/api/') ? withCanvasId(input) : input, init);
}
