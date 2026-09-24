import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { MemoryDashboardStore } from '../store.js';
import { SEED_ITEMS } from '../../../test/fixtures/seed.js';

describe('GET /api/dashboard', () => {
  it('returns 200 with seeded summary', async () => {
    const store = new MemoryDashboardStore(SEED_ITEMS);
    const app = createApp(store);

    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(SEED_ITEMS);
    expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty items array when store has no data', async () => {
    const store = new MemoryDashboardStore([]);
    const app = createApp(store);

    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
