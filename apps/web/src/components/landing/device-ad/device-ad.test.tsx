import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import DeviceAd from './device-ad';
import { AD_SESSION, AD_VENTURE } from './fixtures';
import { BEATS } from './script';

/** IntersectionObserver that reports every observed element on screen at once. */
class OnScreen {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
  }
  unobserve = () => undefined;
  disconnect = () => undefined;
}

function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function renderAd() {
  const root = createRootRoute({ component: () => <DeviceAd /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  return renderWithProviders(<RouterProvider router={router} />);
}

function adTime(): number {
  return Number(document.querySelector('[data-slot="device-ad"]')?.getAttribute('data-t'));
}

describe('DeviceAd', () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    fetchMock = stubFetch();
    vi.stubGlobal('IntersectionObserver', OnScreen);
  });
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('under reduced motion shows the final frame, still, from the app’s own components', async () => {
    reducedMotion(true);
    renderAd();
    const ad = await screen.findByText(AD_VENTURE.name, {}, { timeout: 3000 });
    expect(ad).toBeInTheDocument();
    expect(adTime()).toBe(BEATS.end);
    // The laptop: the real sidebar, the stored answer and the decision saved to Knowledge.
    expect(screen.getByText(AD_SESSION.recent[0] ?? '')).toBeInTheDocument();
    expect(screen.getByText(/Saved to Knowledge/)).toBeInTheDocument();
    expect(screen.getAllByText(AD_SESSION.record[0]?.title ?? '').length).toBeGreaterThan(0);
    // The phone: both captions, and the vEIR thinking.
    expect(screen.getByText(AD_SESSION.call.veirLine)).toBeInTheDocument();
    expect(screen.getByText(AD_SESSION.call.studentLine)).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    // The call's own voice sphere (no monogram inside it) and its own conversation timeline, both turns drawn.
    const sphere = document.querySelector('[data-slot="ad-sphere"] .fa-sphere');
    expect(sphere).toHaveAttribute('data-state', 'thinking');
    expect(sphere).toHaveAttribute('data-motion', 'reduced');
    expect(document.querySelector('[data-slot="ad-sphere"] [data-slot="persona-avatar"]')).toBeNull();
    const timeline = document.querySelector('.ad-call [role="group"][aria-label="Conversation timeline"]');
    expect(timeline?.querySelectorAll('[data-turn]')).toHaveLength(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(adTime()).toBe(BEATS.end);
  });

  it('is inert and hidden from assistive technology, and asks the API for nothing', async () => {
    reducedMotion(true);
    renderAd();
    await screen.findByText(AD_VENTURE.name, {}, { timeout: 3000 });
    const root = document.querySelector('[data-slot="device-ad"]');
    expect(root).toHaveAttribute('inert');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plays while on screen and pauses while the page is hidden', async () => {
    reducedMotion(false);
    renderAd();
    await screen.findByText(AD_VENTURE.name, {}, { timeout: 3000 });
    await waitFor(() => {
      expect(adTime()).toBeGreaterThan(0);
    });
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const paused = adTime();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(adTime()).toBe(paused);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
