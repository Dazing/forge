import type { RequestHandler } from 'express';
import type { DashboardStore } from '../shared/dashboard.js';

/**
 * Health endpoint handler.
 * Returns 200 when the store is ready, 503 otherwise.
 * This is the operational slice — separate from the dashboard slice.
 */
export function healthHandler(store: DashboardStore): RequestHandler {
  return async (_req, res) => {
    const ready = await store.isReady();
    if (!ready) {
      res.status(503).json({ status: 'not ready' });
      return;
    }
    res.json({ status: 'ok' });
  };
}
