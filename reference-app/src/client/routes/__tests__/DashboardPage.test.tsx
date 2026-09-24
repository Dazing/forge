import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from '../DashboardPage.js';
import type { DashboardSummary } from '../../../shared/dashboard.js';

const summary: DashboardSummary = {
  generatedAt: '2026-01-15T00:00:00.000Z',
  items: [
    { id: 'orders', label: 'Orders', value: 128 },
    { id: 'revenue', label: 'Revenue', value: 4250 },
    { id: 'users', label: 'Active Users', value: 97 },
  ],
};

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders loading state, then loads items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve({ ok: true, status: 200, json: () => Promise.resolve(summary) }), 10),
          ),
      ),
    );

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Loading state visible
    expect(screen.getByText('Loading…')).toBeVisible();

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'dashboard' })).toBeVisible();
    });

    expect(screen.getByTestId('item-orders')).toHaveTextContent('Orders');
    expect(screen.getByTestId('value-revenue')).toHaveTextContent('4250');
    expect(screen.getByTestId('item-users')).toHaveTextContent('Active Users');
    expect(screen.getByTestId('dashboard-timestamp')).toHaveTextContent('2026-01-15');
  });

  it('renders error state when API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-error')).toHaveTextContent('network down');
    });
  });

  it('renders HTTP error state when API returns 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject() }),
    );

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-error')).toHaveTextContent('HTTP 500');
    });
  });
});
