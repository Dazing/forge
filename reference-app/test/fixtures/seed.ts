import type { DashboardItem } from '../../src/shared/dashboard.js';

/**
 * Deterministic seed data shared by the app default store and all tests.
 * The Playwright spec and unit tests both assert against these exact IDs.
 */
export const SEED_ITEMS: DashboardItem[] = [
  { id: 'orders', label: 'Orders', value: 128 },
  { id: 'revenue', label: 'Revenue', value: 4250 },
  { id: 'users', label: 'Active Users', value: 97 },
];
