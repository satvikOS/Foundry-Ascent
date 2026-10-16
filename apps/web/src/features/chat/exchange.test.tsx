import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';
import type { TurnStreamError, TurnStreamState } from '@/lib/api/hooks/turn-stream';

import { deriveTurnProgress } from '../coach/progress';
import { IDS, makeTurn } from '../coach/testing';
import { LiveExchange, TurnFailure } from './exchange';
import { VeirAnswer, type VeirAnswerProps } from './veir-answer';

const streaming = (overrides: Partial<TurnStreamState> = {}): TurnStreamState => ({
  status: 'streaming',
  pendingText: 'What should we test first?',
  turnId: IDS.turn,
  ordinal: 1,
  phase: 'reasoning',
  steps: [{ phase: 'reasoning', detail: null, evidenceCount: null, at: 0 }],
  turn: null,
  blocked: null,
  error: null,
  autoRetryAt: null,
  units: [],
  streamedText: '',
  ...overrides,
});

function renderLive(state: TurnStreamState) {
  return renderWithProviders(
    <LiveExchange
      state={state}
      progress={deriveTurnProgress(state)}
      author="Maya Example"
      personaName="Corin"
      tenant="ain"
      ventureId={IDS.venture}
      canRetry
      onRetry={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

function answerProps(overrides: Partial<VeirAnswerProps> = {}): VeirAnswerProps {
  const turn = makeTurn();
  if (!turn.response) throw new Error('fixture has no response');
  return {
    turn,
    response: turn.response,
    personaName: 'Corin',
    latest: true,
    canEdit: true,
    onOpenSource: vi.fn(),
    onShowSources: vi.fn(),
    nextActions: { saved: new Set(), savingIndex: null, onAdd: vi.fn() },
    memory: null,
    escalation: { existing: null },
    ...overrides,
  };
}

describe('LiveExchange', () => {
  it('shows the progress line before any answer text arrives', () => {
    renderLive(streaming());
    const exchange = screen.getByRole('article', { name: 'Current exchange' });
    expect(exchange).toHaveAttribute('aria-busy', 'true');
    expect(within(exchange).getByText('What should we test first?')).toBeVisible();
    expect(within(exchange).getByRole('list', { name: 'Response progress' })).toBeInTheDocument();
    expect(exchange.querySelector('[data-slot="markdown"]')).toBeNull();
  });

  it('renders streamed units as the answer prose, citations as plain keys until the sources arrive', () => {
    renderLive(
      streaming({
        units: [
          { seq: 0, text: 'Talk to the people who feel the pain [E1].' },
          { seq: 1, text: ' Then decide.' },
        ],
        streamedText: 'Talk to the people who feel the pain [E1]. Then decide.',
      }),
    );
    const prose = screen.getByText(/Talk to the people who feel the pain/).closest('[data-slot="markdown"]');
    expect(prose).not.toBeNull();
    expect(prose).toHaveTextContent('Talk to the people who feel the pain E1. Then decide.');
    // The key is not a button yet: the evidence list comes with the stored answer.
    expect(screen.queryByRole('button', { name: /Evidence E1/ })).toBeNull();
  });

  it('lays the stored answer out exactly like the streamed one, so replacing it does not jump', () => {
    const { unmount } = renderLive(
      streaming({ units: [{ seq: 0, text: 'A streamed sentence.' }], streamedText: 'A streamed sentence.' }),
    );
    const streamedClass = screen
      .getByText('A streamed sentence.')
      .closest('[data-slot="markdown"]')?.className;
    unmount();
    renderWithProviders(<VeirAnswer {...answerProps()} />);
    const storedClass = screen
      .getByText(/Your riskiest assumption is repeat use/)
      .closest('[data-slot="markdown"]')?.className;
    expect(streamedClass).toBeTruthy();
    expect(storedClass).toBe(streamedClass);
  });

  it('drops the streamed text and offers to edit when the founder stops the answer', () => {
    renderLive(streaming({ status: 'cancelled', units: [], streamedText: '' }));
    expect(screen.getByText('Stopped')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit and resend' })).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Response progress' })).toBeNull();
  });
});

describe('VeirAnswer', () => {
  it('keeps the reasoning collapsed and opens a cited source from the prose', async () => {
    const props = answerProps();
    renderWithProviders(<VeirAnswer {...props} />);
    const user = userEvent.setup();
    expect(screen.queryByRole('list', { name: 'Claims and their sources' })).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Evidence E1: 14 problem interviews with undergraduates' }),
    );
    expect(props.onOpenSource).toHaveBeenCalledWith('E1');
    await user.click(screen.getByRole('button', { name: /^Sources & reasoning/ }));
    expect(screen.getByRole('list', { name: 'Claims and their sources' })).toBeVisible();
  });

  it('adds a suggested next step to the venture’s actions', async () => {
    const props = answerProps();
    renderWithProviders(<VeirAnswer {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add to actions' }));
    expect(props.nextActions.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'Interview five library staff' }),
      0,
    );
  });

  it('pins copy and rating under the latest answer only', () => {
    const { unmount } = renderWithProviders(<VeirAnswer {...answerProps({ latest: true })} />);
    expect(screen.getByRole('button', { name: 'Copy answer' }).parentElement?.className).not.toContain(
      'opacity-0',
    );
    unmount();
    renderWithProviders(<VeirAnswer {...answerProps({ latest: false })} />);
    expect(screen.getByRole('button', { name: 'Copy answer' }).parentElement?.className).toContain(
      'opacity-0',
    );
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
    message: 'Your vEIR is temporarily unavailable. Try again shortly.',
    retryable: true,
    requestId: 'req-42',
    retryAt: undefined,
    ...overrides,
  });

  it('names the vEIR, holds "Try again" until the server’s wait has passed and shows the request id', () => {
    renderWithProviders(
      <TurnFailure
        error={error({ retryAt: Date.now() + 5_000 })}
        personaName="Corin"
        autoRetryAt={null}
        canRetry
        onRetry={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Corin couldn’t answer')).toBeVisible();
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
        personaName="Corin"
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
