import type { PortfolioSummary } from '@foundry/contracts';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { PortfolioDashboard } from '../portfolio-dashboard';
import { AggregateBarChart } from './aggregate-bar-chart';
import { formatAggregate, toAggregateRows, visibleTotal, type AggregateDatum } from './k-anonymity';

const ROWS: AggregateDatum[] = [
  { key: 'idea', label: 'Idea', value: 7 },
  { key: 'discovery', label: 'Discovery', value: null },
  { key: 'validation', label: 'Validation', value: 4 },
  { key: 'growth', label: 'Growth', value: null },
];

describe('k-anonymity helpers', () => {
  it('never turns a suppressed value into a number', () => {
    expect(formatAggregate(null, 3)).toBe('Fewer than 3');
    expect(formatAggregate(0, 3)).toBe('0');
    expect(formatAggregate(12, 3)).toBe('12');
  });

  it('orders known keys first, keeps unknown keys, and does not invent missing ones', () => {
    const rows = toAggregateRows({ growth: 3, idea: null, zebra: 9, alpha: null }, (k) => k.toUpperCase(), [
      'idea',
      'discovery',
      'growth',
    ]);
    expect(rows.map((r) => r.key)).toEqual(['idea', 'growth', 'zebra', 'alpha']);
    expect(rows[0]).toEqual({ key: 'idea', label: 'IDEA', value: null });
  });

  it('labels a total that excludes suppressed groups as partial', () => {
    expect(visibleTotal(ROWS)).toEqual({ total: 11, partial: true });
    expect(visibleTotal([{ key: 'a', label: 'A', value: 2 }])).toEqual({ total: 2, partial: false });
  });
});

describe('AggregateBarChart (k-anonymity rendering)', () => {
  it('renders suppressed groups as “Fewer than k” with an outline mark and an explanation', () => {
    renderWithProviders(
      <AggregateBarChart
        rows={ROWS}
        k={3}
        label="Ventures by stage"
        categoryHeader="Stage"
        valueHeader="Ventures"
        unit="ventures"
        view="chart"
      />,
    );
    const list = screen.getByRole('list', { name: 'Ventures by stage' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);

    const discovery = items[1];
    expect(discovery).toHaveAttribute('data-suppressed', 'true');
    expect(discovery).toHaveTextContent('Discovery');
    expect(discovery).toHaveTextContent('Fewer than 3');
    // No digits leak for a suppressed row (not 0, not 1, not 2).
    expect(discovery?.textContent).not.toMatch(/[0-24-9]/);
    const bar = discovery?.querySelector('[data-slot="bar"]');
    expect(bar?.className).toContain('border-dashed');
    expect(bar?.className).not.toContain('bg-chart-2');

    // Known values are direct-labelled at the bar tip.
    expect(items[0]).toHaveTextContent('7');
    expect(items[0]?.querySelector('[data-slot="bar"]')?.className).toContain('bg-chart-2');

    // Every suppressed row has an explanation button, and the footnote explains k.
    expect(screen.getByRole('button', { name: 'Why is Discovery hidden?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Why is Growth hidden?' })).toBeInTheDocument();
    expect(screen.getByText(/k-anonymity, k = 3/)).toBeInTheDocument();
  });

  it('scales a suppressed outline to the possible range (k − 1), not to a value', () => {
    renderWithProviders(
      <AggregateBarChart
        rows={[
          { key: 'a', label: 'A', value: 8 },
          { key: 'b', label: 'B', value: null },
        ]}
        k={5}
        label="Chart"
        categoryHeader="Group"
        valueHeader="Count"
        unit="ventures"
        view="chart"
      />,
    );
    const bars = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector<HTMLElement>('[data-slot="bar"]'));
    expect(bars[0]).toHaveAttribute('data-ratio', '1.0000');
    expect(bars[1]).toHaveAttribute('data-ratio', '0.5000'); // (k − 1) / max = 4 / 8
    expect(bars[1]?.style.width).toMatch(/0\.5/);
  });

  it('carries the same wording into the table view, with a partial total', () => {
    renderWithProviders(
      <AggregateBarChart
        rows={ROWS}
        k={3}
        label="Ventures by stage"
        categoryHeader="Stage"
        valueHeader="Ventures"
        unit="ventures"
        view="table"
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Stage' })).toBeInTheDocument();
    const discovery = within(table).getByRole('rowheader', { name: 'Discovery' }).closest('tr');
    expect(discovery).toHaveTextContent('Fewer than 3');
    expect(within(table).getByText('At least 11')).toBeInTheDocument();
    expect(within(table).getByText(/shown as “fewer than 3” instead of an exact count/)).toBeInTheDocument();
  });

  it('shows no k-anonymity note when nothing is suppressed', () => {
    renderWithProviders(
      <AggregateBarChart
        rows={[{ key: 'idea', label: 'Idea', value: 5 }]}
        k={3}
        label="Ventures by stage"
        categoryHeader="Stage"
        valueHeader="Ventures"
        unit="ventures"
        view="chart"
      />,
    );
    expect(screen.queryByText(/Fewer than/)).not.toBeInTheDocument();
    expect(screen.queryByText(/k-anonymity/)).not.toBeInTheDocument();
  });
});

describe('PortfolioDashboard', () => {
  const summary: PortfolioSummary = {
    minGroupSize: 3,
    venturesByStage: { idea: 5, discovery: null, validation: 3 },
    escalationsByCategory: { legal: null, expert_judgment: 4 },
    openEscalationsByPriority: { P0: 0, P1: 2, P2: 5 },
    activeVentures30d: 11,
    sessions30d: 42,
    confirmedDecisions30d: 9,
    experimentsCompleted30d: 3,
    medianFeedbackRating30d: null,
  };

  async function renderDashboard() {
    const rootRoute = createRootRoute({
      component: () => <PortfolioDashboard summary={summary} tenant="ain" />,
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    renderWithProviders(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Ventures by stage' });
  }

  it('renders tiles, suppressed groups and a suppressed median without numbers', async () => {
    await renderDashboard();
    expect(screen.getByText('42')).toBeInTheDocument();
    const median = screen.getByText('Median founder rating').closest('[data-slot="metric-tile"]');
    expect(median).toHaveTextContent(/Not enough ratings to show without identifying anyone/);
    expect(median?.textContent).not.toMatch(/\d\.\d/);

    const stages = screen.getByRole('list', { name: 'Ventures by stage' });
    expect(within(stages).getByText('Fewer than 3')).toBeInTheDocument();
    const categories = screen.getByRole('list', { name: 'Escalations by category' });
    expect(within(categories).getByText('Legal').closest('li')).toHaveTextContent('Fewer than 3');

    // Missing priorities count as zero open escalations (that record is never suppressed).
    expect(screen.getByText('7 open across the portfolio')).toBeInTheDocument();
  });

  it('switches a chart to its accessible table', async () => {
    const user = userEvent.setup();
    await renderDashboard();
    const toggle = screen.getByRole('group', { name: 'Ventures by stage: view as' });
    await user.click(within(toggle).getByRole('button', { name: 'Table' }));
    expect(within(toggle).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Discovery' }).closest('tr')).toHaveTextContent(
      'Fewer than 3',
    );
  });
});
