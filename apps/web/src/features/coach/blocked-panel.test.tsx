import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';
import type { TurnStreamError } from '@/lib/api/hooks/turn-stream';

import { BlockedPanel } from './blocked-panel';
import { IDS } from './testing';
import { TurnFailure } from './turn-item';

/** The crisis path's support message as the API sends it (Markdown). */
const CRISIS = [
  'It sounds like you might be going through something really hard right now.',
  '',
  '- If you or anyone else is in immediate danger, call your local emergency number now (911 in the US).',
  '- In the US you can call or text **988** (Suicide & Crisis Lifeline) at any time, day or night.',
].join('\n');

async function renderInRouter(ui: ReactElement) {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  await screen.findByTestId('blocked-panel');
}

describe('BlockedPanel', () => {
  it('shows the crisis support message (as after a reload) with its resources and the drafted request', async () => {
    await renderInRouter(
      <BlockedPanel
        tenant="ain"
        ventureId={IDS.venture}
        supportMessage={CRISIS}
        reason="crisis_support"
        escalationId={IDS.ref}
      />,
    );
    expect(screen.getByRole('heading', { name: 'You deserve support from a person' })).toBeVisible();
    // Markdown, not raw text: list items and the emphasised crisis line.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('988').tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*988\*\*/)).toBeNull();
    const link = screen.getByRole('link', { name: 'View your support request' });
    expect(link.getAttribute('href')).toContain(`id=${IDS.ref}`);
    expect(screen.getByText(/Nothing is shared until you review it/)).toBeVisible();
  });

  it('explains other reasons without blaming the founder and offers a human', async () => {
    const onRequestSupport = vi.fn();
    await renderInRouter(
      <BlockedPanel
        tenant="ain"
        ventureId={IDS.venture}
        supportMessage={null}
        reason="policy"
        escalationId={null}
        onRequestSupport={onRequestSupport}
      />,
    );
    expect(screen.getByRole('heading', { name: 'This answer was held back' })).toBeVisible();
    // The generic privacy wording never says the answer involved another venture.
    expect(screen.queryByText(/other venture/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Request human support' }));
    expect(onRequestSupport).toHaveBeenCalledOnce();
  });

  it('adds emergency guidance for a safety reason that came without a message', async () => {
    await renderInRouter(
      <BlockedPanel
        tenant="ain"
        ventureId={IDS.venture}
        supportMessage={null}
        reason="safety_wellbeing"
        escalationId={null}
      />,
    );
    expect(screen.getByText(/contact your local emergency number/)).toBeVisible();
  });
});

describe('TurnFailure', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const error = (overrides: Partial<TurnStreamError> = {}): TurnStreamError => ({
    code: 'model_unavailable',
    message: 'The coach could not answer right now. Please try again.',
    retryable: true,
    requestId: 'req-42',
    retryAt: undefined,
    ...overrides,
  });

  it('holds "Try again" until the server’s retryAfterSeconds has passed and shows the request id', () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <TurnFailure
        error={error({ retryAt: Date.now() + 5_000 })}
        autoRetryAt={null}
        canRetry
        onRetry={onRetry}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Try again in 5 s/ })).toBeDisabled();
    expect(screen.getByText('req-42')).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('says a still-pending turn is being checked again automatically (no failure, no retry button)', () => {
    renderWithProviders(
      <TurnFailure
        error={error({ code: 'conflict', message: 'This message is still being answered. Please wait.' })}
        autoRetryAt={Date.now() + 5_000}
        canRetry
        onRetry={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Still answering');
    expect(screen.getByTestId('turn-auto-retry')).toHaveTextContent('Checking again in 5 s…');
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('turn-auto-retry')).toHaveTextContent('Checking again in 2 s…');
  });
});
