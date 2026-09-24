import { useEffect, useState } from 'react';
import type { DashboardSummary } from '../../shared/dashboard.js';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: DashboardSummary };

export default function DashboardPage() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetch('/api/dashboard')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<DashboardSummary>;
      })
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ status: 'error', message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div role="region" aria-label="dashboard-loading">
        <h1>Dashboard</h1>
        <p role="status">Loading…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div role="region" aria-label="dashboard-error">
        <h1>Dashboard</h1>
        <p role="alert" data-testid="dashboard-error">{state.message}</p>
      </div>
    );
  }

  const { data } = state;
  return (
    <div role="region" aria-label="dashboard">
      <h1>Dashboard</h1>
      <time data-testid="dashboard-timestamp" dateTime={data.generatedAt}>
        {data.generatedAt}
      </time>
      <ul data-testid="dashboard-items">
        {data.items.map((item) => (
          <li key={item.id} data-testid={`item-${item.id}`}>
            <span>{item.label}</span>
            <span data-testid={`value-${item.id}`}>{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
