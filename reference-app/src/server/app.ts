import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DashboardStore } from '../shared/dashboard.js';
import { healthHandler } from './health.js';
import { dashboardHandler } from './dashboard.js';

/**
 * Composition root for the app.
 * Wires store to routes; owns routing.
 */
export function createApp(store: DashboardStore): Express {
  const app = express();
  app.use(express.json());

  // Operational slice
  app.get('/healthz', healthHandler(store));

  // Dashboard slice
  app.get('/api/dashboard', dashboardHandler(store));

  // Static client files with SPA fallback.
  // The client build is in dist/ (Vite output). Serve it only when present
  // so that unit tests (supertest) don't require a pre-built client.
  const distDir = process.env.CLIENT_DIST ?? path.resolve(process.cwd(), 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA fallback: serve index.html for any non-API GET route.
    app.get('*', (req, res, next) => {
      const p = req.path;
      if (p.startsWith('/api/') || p === '/healthz') {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}
