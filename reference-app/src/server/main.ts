import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.js';
import { MemoryDashboardStore } from './store.js';
import { SqliteDashboardStore } from './sqlite-store.js';
import type { DashboardItem, DashboardStore } from '../shared/dashboard.js';

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Deterministic seed data — mirrors test/fixtures/seed.ts.
 */
const SEED: DashboardItem[] = [
  { id: 'orders', label: 'Orders', value: 128 },
  { id: 'revenue', label: 'Revenue', value: 4250 },
  { id: 'users', label: 'Active Users', value: 97 },
];

function createStore(): DashboardStore {
  try {
    const dataDir = process.env.DATA_DIR ?? './data';
    const dbPath = join(dataDir, 'dashboard.db');
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        value INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO dashboard_items (id, label, value) VALUES (?, ?, ?)`
    );
    for (const item of SEED) {
      insert.run(item.id, item.label, item.value);
    }

    return new SqliteDashboardStore(db);
  } catch {
    // node:sqlite unavailable or DB I/O failed — fall back to in-memory
    return new MemoryDashboardStore(SEED);
  }
}

const store = createStore();
const app = createApp(store);

app.listen(PORT, () => {
  console.log(`[reference-app] listening on :${PORT}`);
});
