/**
 * In-memory DashboardStore implementation.
 * Used by unit tests and as the default store when node:sqlite is unavailable.
 */
import type { DashboardStore, DashboardSummary, DashboardItem } from '../shared/dashboard.js';

export class MemoryDashboardStore implements DashboardStore {
  private items: DashboardItem[];
  private ready: boolean;

  constructor(items: DashboardItem[] = [], ready: boolean = true) {
    this.items = items;
    this.ready = ready;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  async getSummary(): Promise<DashboardSummary> {
    return {
      generatedAt: new Date().toISOString(),
      items: this.items,
    };
  }
}
