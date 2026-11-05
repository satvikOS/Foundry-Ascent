import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import LandingSections from './sections';

class Never {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
}

function renderSections() {
  const root = createRootRoute({ component: () => <LandingSections me={null} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  return renderWithProviders(<RouterProvider router={router} />);
}

describe('LandingSections', () => {
  beforeEach(() => {
    stubFetch();
    vi.stubGlobal('IntersectionObserver', Never);
  });

  it('lists the Ain Foundry path: three modules and the EIR sessions', async () => {
    renderSections();
    const program = await screen.findByRole('region', { name: 'For students on the Ain Foundry path' });
    for (const name of [
      'Business Model Canvas',
      'The Perfect Pitch',
      'The Business Plan',
      'EIR Foundry Sessions',
    ]) {
      expect(within(program).getByText(name)).toBeInTheDocument();
    }
  });

  it('opens one kind of venture at a time, by keyboard too', async () => {
    const user = userEvent.setup();
    renderSections();
    const software = await screen.findByRole('button', { name: 'Software' });
    const spinouts = screen.getByRole('button', { name: 'University spinouts' });
    expect(software).toHaveAttribute('aria-expanded', 'true');
    expect(spinouts).toHaveAttribute('aria-expanded', 'false');
    spinouts.focus();
    await user.keyboard('{Enter}');
    expect(spinouts).toHaveAttribute('aria-expanded', 'true');
    expect(software).toHaveAttribute('aria-expanded', 'false');
    const panel = screen.getByRole('region', { name: 'University spinouts' });
    expect(within(panel).getByText('Routes IP and licensing questions to people')).toBeInTheDocument();
    // The closed panels are inert: nothing in them can take focus.
    expect(document.getElementById(software.getAttribute('aria-controls') ?? '')).toHaveAttribute('inert');
  });

  it('keeps the product fragments out of the tab order and the accessibility tree', async () => {
    renderSections();
    await screen.findByRole('heading', { name: 'How a session works' });
    const fragments = document.querySelectorAll('.l-fragment');
    expect(fragments.length).toBeGreaterThanOrEqual(4);
    for (const fragment of fragments) {
      expect(fragment).toHaveAttribute('inert');
      expect(fragment).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('signs in from the final call to action, and says how to get a code', async () => {
    renderSections();
    expect(await screen.findByText('No access code? Ask your Ain Foundry program lead.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Sign in' });
    expect(links.every((link) => link.getAttribute('href') === '/sign-in')).toBe(true);
  });

  it('promises only what is true and on the page: no dead “read more” links, the sharing policy as it is', async () => {
    renderSections();
    const principles = await screen.findByRole('region', { name: 'Principles we don’t trade away' });
    expect(within(principles).queryAllByRole('link')).toEqual([]);
    const trust = screen.getByRole('region', { name: 'Built to be trusted with early ideas' });
    // As the in-app Data use & privacy says: staff see totals, and nothing else without the founder's approval.
    expect(trust).toHaveTextContent('Program staff see totals; more needs consent.');
    expect(trust).not.toHaveTextContent(/aggregates only/);
    expect(trust).toHaveTextContent('Designed to WCAG 2.2 AA');
    // Every in-page link in the footer lands on a section that exists (the hero's media is the route's own).
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    for (const link of within(footer).getAllByRole('link')) {
      const href = link.getAttribute('href') ?? '';
      if (!href.startsWith('#') || href === '#see-a-session') continue;
      expect(document.getElementById(href.slice(1)), href).not.toBeNull();
    }
    expect(within(footer).queryByRole('link', { name: 'Privacy' })).toBeNull();
  });
});
