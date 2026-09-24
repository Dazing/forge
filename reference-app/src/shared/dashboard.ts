/**
 * Shared types for the dashboard domain.
 * This module is stateless — no mutable state, no I/O.
 * Both server and client import from here.
 */

export interface DashboardItem {
  id: string;
  label: string;
  value: number;
}

export interface DashboardSummary {
  generatedAt: string;
  items: DashboardItem[];
}

/**
 * Store abstraction for dashboard data.
 * The server implements this; tests inject an in-memory fixture.
 */
export interface DashboardStore {
  isReady(): Promise<boolean>;
  getSummary(): Promise<DashboardSummary>;
}

/**
 * Pure helper: compute total of all item values.
 */
export function totalValue(summary: DashboardSummary): number {
  return summary.items.reduce((sum, item) => sum + item.value, 0);
}

