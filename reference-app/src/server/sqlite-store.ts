import type { DatabaseSync } from 'node:sqlite';
import type { DashboardStore, DashboardSummary, DashboardItem } from '../shared/dashboard.js';

/**
 * SQLite-backed DashboardStore using node:sqlite (Node 22+).
 * Reads items from a migration-created table.
 */
export class SqliteDashboardStore implements DashboardStore {
  private items: DashboardItem[] = [];
  private ready = false;

  constructor(private db: DatabaseSync, private table = 'dashboard_items') {}

  private loadItems(): void {
    const rows = this.db
      .prepare(`SELECT id, label, value FROM ${this.table} ORDER BY id`)
      .all() as { id: string; label: string; value: number }[];
    this.items = rows.map((r) => ({ id: r.id, label: r.label, value: r.value }));
    this.ready = true;
  }

  async isReady(): Promise<boolean> {
    if (!this.ready) {
      try {
        this.loadItems();
      } catch {
        return false;
      }
    }
    return this.ready;
  }

  async getSummary(): Promise<DashboardSummary> {
    if (!this.ready) {
      await this.isReady();
    }
    return {
      generatedAt: new Date().toISOString(),
      items: this.items,
    };
  }
}
