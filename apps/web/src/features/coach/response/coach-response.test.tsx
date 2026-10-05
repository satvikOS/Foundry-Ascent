import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { IDS, makeMemory, makeResponse, makeTurn, makeValidator } from '../testing';
import {
  CoachResponseView,
  type CoachResponseViewProps,
  type MemoryCandidateControls,
} from './coach-response';

function renderView(overrides: Partial<CoachResponseViewProps> = {}) {
  const turn = overrides.turn ?? makeTurn();
  const props: CoachResponseViewProps = {
    turn,
    response: overrides.response ?? turn.response ?? makeResponse(),
    onOpenEvidence: vi.fn<(key: string) => void>(),
    ...overrides,
  };
  const ui: ReactElement = (
    <TooltipProvider>
      <CoachResponseView {...props} />
    </TooltipProvider>
  );
  return { ...render(ui), props, user: userEvent.setup() };
}

function firstCandidate() {
  const candidate = makeResponse().memory_candidates[0];
  if (!candidate) throw new Error('fixture has no memory candidate');
  return candidate;
}

function memoryControls(overrides: Partial<MemoryCandidateControls> = {}): MemoryCandidateControls {
  return {
    state: 'ready',
    canEdit: true,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onEdit: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
}

describe('CoachResponseView', () => {
  it('renders the answer with citation chips that open the evidence item', async () => {
    const onOpenEvidence = vi.fn<(key: string) => void>();
    const { user } = renderView({ onOpenEvidence });
    expect(screen.getByText(/Your riskiest assumption is repeat use/)).toBeInTheDocument();
    const answer = screen.getByText(/Your riskiest assumption/).closest('p');
    if (!answer) throw new Error('answer paragraph not rendered');
    const chip = within(answer).getByRole('button', {
      name: 'Evidence E1: 14 problem interviews with undergraduates',
    });
    await user.click(chip);
    expect(onOpenEvidence).toHaveBeenCalledWith('E1');
  });

  it('lists every claim with a kind label (icon + text) and its evidence chips', async () => {
    const onOpenEvidence = vi.fn<(key: string) => void>();
    const { user } = renderView({ onOpenEvidence });
    const claims = screen.getByRole('list', { name: 'Claims and their sources' });
    const items = within(claims).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.querySelector('[data-slot="status-label"]')?.textContent)).toEqual([
      'Fact',
      'Inference',
      'Hypothesis',
      'Recommendation',
    ]);
    // Every badge carries an icon and a border shape, not colour alone.
    for (const item of items) {
      const badge = item.querySelector('[data-slot="status-badge"]');
      expect(badge?.querySelector('svg')).not.toBeNull();
      expect(badge?.getAttribute('data-shape')).toBeTruthy();
    }
    const [, inference, hypothesis] = items;
    if (!inference || !hypothesis) throw new Error('claims not rendered');
    expect(
      within(inference)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['E1', 'E2']);
    await user.click(within(inference).getByRole('button', { name: /Evidence E2/ }));
    expect(onOpenEvidence).toHaveBeenLastCalledWith('E2');
    expect(within(hypothesis).getByText('(no source cited)')).toBeInTheDocument();
  });

  it('marks citations to unknown evidence as unavailable instead of linking them', () => {
    const turn = makeTurn({
      response: makeResponse({
        answer: 'See [E9].',
        claims: [{ text: 'A claim', kind: 'inference', evidence_ids: ['E9'] }],
      }),
    });
    renderView({ turn });
    const missing = document.querySelectorAll('[data-slot="evidence-chip"][data-missing="true"]');
    expect(missing).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Evidence E9/ })).toBeNull();
    expect(screen.getAllByText('(source not available)')).toHaveLength(2);
  });

  it('shows the narrowed banner with grounding coverage when the validator narrowed the answer', () => {
    const turn = makeTurn({
      validator: makeValidator({ narrowed: true, groundingCoverage: 0.42, factsDowngraded: 2 }),
    });
    renderView({ turn });
    const banner = screen.getByTestId('narrowed-banner');
    expect(banner).toHaveTextContent('Answer narrowed to what the evidence supports');
    expect(banner).toHaveTextContent('grounding 42%');
    expect(banner).toHaveTextContent('2 statements were relabelled from fact to inference');
  });

  it('does not show the narrowed banner for a fully grounded answer', () => {
    renderView();
    expect(screen.queryByTestId('narrowed-banner')).toBeNull();
    expect(screen.queryByText(/Grounding checks adjusted/)).toBeNull();
  });

  it('explains downgrades without narrowing', () => {
    renderView({ turn: makeTurn({ validator: makeValidator({ factsDowngraded: 1 }) }) });
    expect(screen.getByText('Grounding checks adjusted this answer')).toBeInTheDocument();
    expect(screen.getByText(/1 statement was relabelled/)).toBeInTheDocument();
  });

  it('renders uncertainty with a text level and the challenge callout', () => {
    renderView();
    expect(screen.getByText('Whether libraries will share occupancy data')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Challenge' })).toHaveTextContent(
      'What would convince you that everyday demand is real?',
    );
  });

  it('sends follow-up questions on click, and not when disabled', async () => {
    const onFollowUp = vi.fn<(q: string) => void>();
    const { user, rerender, props } = renderView({ onFollowUp });
    await user.click(screen.getByRole('button', { name: 'How would you measure repeat use?' }));
    expect(onFollowUp).toHaveBeenCalledWith('How would you measure repeat use?');

    rerender(
      <TooltipProvider>
        <CoachResponseView
          {...props}
          onFollowUp={onFollowUp}
          followUpDisabledReason="Wait for the current answer"
        />
      </TooltipProvider>,
    );
    const chip = screen.getByRole('button', { name: 'How would you measure repeat use?' });
    expect(chip).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves next actions and shows saved ones', async () => {
    const onSave = vi.fn();
    const { user, rerender, props } = renderView({
      nextActions: { saved: new Set(), savingIndex: null, onSave },
    });
    expect(screen.getByText('Interview five library staff')).toBeInTheDocument();
    expect(screen.getByText(/Owner: Maya/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save as action' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'Interview five library staff' }),
      0,
    );

    rerender(
      <TooltipProvider>
        <CoachResponseView {...props} nextActions={{ saved: new Set([0]), savingIndex: null, onSave }} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Save as action' })).toBeNull();
    expect(screen.getByText('Saved as action')).toBeInTheDocument();
  });

  it('lets founders approve, reject or edit memory candidates inline', async () => {
    const controls = memoryControls();
    const memory = makeMemory();
    const { user } = renderView({
      memory: controls,
      candidates: [{ candidate: firstCandidate(), memory }],
    });
    const list = screen.getByRole('list', { name: 'Memory suggestions' });
    await user.click(within(list).getByRole('button', { name: 'Approve' }));
    expect(controls.onApprove).toHaveBeenCalledWith(memory);
    await user.click(within(list).getByRole('button', { name: 'Reject' }));
    expect(controls.onReject).toHaveBeenCalledWith(memory);
    await user.click(within(list).getByRole('button', { name: 'Edit' }));
    expect(controls.onEdit).toHaveBeenCalledWith(memory);
  });

  it('shows the memory status once a candidate is decided, and explains ephemeral sessions', () => {
    const candidate = firstCandidate();
    const { rerender, props } = renderView({
      memory: memoryControls(),
      candidates: [{ candidate, memory: makeMemory({ status: 'confirmed' }) }],
    });
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    rerender(
      <TooltipProvider>
        <CoachResponseView
          {...props}
          memory={memoryControls({ state: 'ephemeral' })}
          candidates={[{ candidate, memory: null }]}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('Not kept (ephemeral session)')).toBeInTheDocument();
  });

  it('suggests human support when the response requires escalation', async () => {
    const onRequest = vi.fn();
    const response = makeResponse({
      escalation: {
        required: true,
        category: 'ip_licensing',
        priority: 'P1',
        reason: 'University IP terms need a specialist.',
        requested_role: 'specialist',
      },
    });
    const { user } = renderView({
      turn: makeTurn({ response, validator: makeValidator({ escalationForced: true }) }),
      response,
      escalation: { existing: null, onRequest },
    });
    const card = screen.getByTestId('escalation-suggestion');
    expect(card).toHaveTextContent('University IP terms need a specialist.');
    expect(card).toHaveTextContent('IP & licensing');
    expect(card).toHaveTextContent('P1 · Urgent');
    expect(card).toHaveTextContent('Flagged automatically');
    await user.click(within(card).getByRole('button', { name: 'Request human support' }));
    expect(onRequest).toHaveBeenCalled();
  });

  it('renders the rehearsal block with the counterpart and rubric scores', () => {
    const response = makeResponse({
      mode: 'rehearse',
      rehearsal: {
        counterpart: 'Seed investor',
        line: 'Why now, and why you?',
        scores: [{ criterion: 'Clarity', score: 4, note: 'Crisp problem statement.' }],
        critique: 'Lead with the exam-week data.',
      },
    });
    renderView({ turn: makeTurn({ response }), response });
    expect(screen.getByText('Why now, and why you?')).toBeInTheDocument();
    expect(screen.getByText(/role played by Foundry Guide/)).toBeInTheDocument();
    const scores = screen.getByRole('list', { name: 'Rubric scores' });
    expect(within(scores).getByText('Clarity')).toBeInTheDocument();
    expect(within(scores).getByText('4 out of 5')).toHaveClass('sr-only');
    expect(screen.getByText('Lead with the exam-week data.')).toBeInTheDocument();
  });

  it('keeps the turn id in element ids so several responses can coexist', () => {
    const response = makeResponse({
      escalation: { required: true, category: 'legal', priority: 'P2', reason: 'x', requested_role: 'eir' },
    });
    renderView({ turn: makeTurn({ id: IDS.memory2, response }), response });
    expect(document.getElementById(`escalation-${IDS.memory2}-title`)).not.toBeNull();
  });
});
