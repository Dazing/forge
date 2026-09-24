import type { RequestHandler } from 'express';
import type { DashboardStore } from '../shared/dashboard.js';

/**
 * Dashboard API handler.
 * Returns the current dashboard summary as JSON.
 */
export function dashboardHandler(store: DashboardStore): RequestHandler {
  return async (_req, res) => {
    const summary = await store.getSummary();
    res.json(summary);
  };
}
