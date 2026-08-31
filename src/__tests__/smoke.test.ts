import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../server.js';

describe('GET /health (identity smoke test)', () => {
  it('reports the service identity fields the client identity gate requires', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('mcp-excalidraw-canvas');
    expect(typeof res.body.pid).toBe('number');
  });
});
