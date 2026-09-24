import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { MemoryDashboardStore } from '../store.js';
import { SEED_ITEMS } from '../../../test/fixtures/seed.js';

describe('GET /healthz', () => {
  it('returns 200 and status ok when store is ready', async () => {
    const store = new MemoryDashboardStore(SEED_ITEMS, true);
    const app = createApp(store);

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 503 when store is not ready', async () => {
    const store = new MemoryDashboardStore(SEED_ITEMS, false);
    const app = createApp(store);

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not ready' });
  });
});
