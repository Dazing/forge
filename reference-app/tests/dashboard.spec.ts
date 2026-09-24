import { test, expect } from '@playwright/test';

test('dashboard route renders seeded items', async ({ page }) => {
  // Navigate to the dashboard; the route is registered at /dashboard
  await page.goto('/dashboard');

  // Wait for the dashboard region to be present (loading → ready)
  await expect(page.getByRole('region', { name: 'dashboard' })).toBeVisible();

  // Assert all three seeded items are visible
  for (const id of ['orders', 'revenue', 'users']) {
    const item = page.getByTestId(`item-${id}`);
    await expect(item).toBeVisible();
  }

  // Verify specific values
  await expect(page.getByTestId('value-orders')).toHaveText('128');
  await expect(page.getByTestId('value-revenue')).toHaveText('4250');
  await expect(page.getByTestId('value-users')).toHaveText('97');

  // The timestamp is rendered
  await expect(page.getByTestId('dashboard-timestamp')).not.toHaveText('');
});

test('dashboard error state is reachable', async ({ page }) => {
  // Block the API to force the error state
  await page.route('/api/dashboard', (route) =>
    route.abort(),
  );
  await page.goto('/dashboard');

  await expect(page.getByTestId('dashboard-error')).toBeVisible();
});
