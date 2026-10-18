import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeEvidence, makeResponse, makeTurn, makeValidator } from '../coach/testing';
import {
  citedSourceKeys,
  groundingAdjustments,
  NarrowedNote,
  ReasoningDetails,
  ReasoningDisclosure,
} from './reasoning';

const turn = makeTurn();
const response = (() => {
  if (!turn.response) throw new Error('fixture has no response');
  return turn.response;
})();

describe('ReasoningDisclosure', () => {
  it('is collapsed, says how many sources it cites (never a count of claims), and expands on demand', async () => {
    const onShowSources = vi.fn();
    render(
      <ReasoningDisclosure
        response={response}
        evidence={turn.evidence}
        validator={turn.validator}
        onOpenSource={vi.fn()}
        onShowSources={onShowSources}
      />,
    );
    const toggle = screen.getByRole('button', { name: /^Sources & reasoning/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(/2 sources$/);
    expect(toggle).not.toHaveTextContent(/claim/);
    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const claims = screen.getByRole('list', { name: 'Claims and their sources' });
    expect(within(claims).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('What would convince you that everyday demand is real?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open sources' }));
    expect(onShowSources).toHaveBeenCalledOnce();
  });
});

describe('a Sources link only where the answer cites something', () => {
  const retrieved = Array.from({ length: 6 }, (_, n) => makeEvidence({ key: `E${n + 1}` }));
  const social = makeResponse({
    answer: 'Hi Maya, good to see you.',
    claims: [],
    uncertainty: [],
    challenge: null,
  });

  it('shows nothing under a social reply that cites nothing, whatever retrieval found for its turn', () => {
    const { container } = render(
      <ReasoningDisclosure
        response={social}
        evidence={retrieved}
        validator={null}
        onOpenSource={vi.fn()}
        onShowSources={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /source/i })).toBeNull();
  });

  it('shows how many sources an answer without reasoning cites, and opens them', async () => {
    const onShowSources = vi.fn();
    render(
      <ReasoningDisclosure
        response={{ ...social, answer: 'Six of eight checked two buildings first [E2].' }}
        evidence={retrieved}
        validator={null}
        onOpenSource={vi.fn()}
        onShowSources={onShowSources}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: '1 source cited' }));
    expect(onShowSources).toHaveBeenCalledOnce();
  });

  it('keeps the reasoning of an answer that cites nothing, without an Open sources link', async () => {
    render(
      <ReasoningDisclosure
        response={{
          ...social,
          answer: 'My guess: they pay for time saved.',
          uncertainty: [{ item: 'Who pays.', level: 'medium' }],
        }}
        evidence={retrieved}
        validator={null}
        onOpenSource={vi.fn()}
        onShowSources={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: /^Sources & reasoning/ }));
    expect(screen.getByText('Who pays.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open sources' })).toBeNull();
  });
});

describe('citedSourceKeys', () => {
  it('counts what the answer cites, not everything that was retrieved', () => {
    const retrieved = Array.from({ length: 17 }, (_, n) => makeEvidence({ key: `E${n + 1}` }));
    const answer = makeResponse({
      answer: 'Past behaviour is hard to fake [E1]. Frequency matters [E2][E1].',
      claims: [
        { text: 'Nine of fourteen walk between buildings.', kind: 'fact', evidence_ids: ['E2', 'E9'] },
      ],
    });
    expect(citedSourceKeys(answer, retrieved)).toEqual(['E2', 'E9', 'E1']);
    // A key that names nothing retrieved is not a source.
    expect(citedSourceKeys(makeResponse({ answer: 'See [E40].', claims: [] }), retrieved)).toEqual([]);
  });

  it('summarises the cited sources under the answer', () => {
    const retrieved = Array.from({ length: 17 }, (_, n) => makeEvidence({ key: `E${n + 1}` }));
    render(
      <ReasoningDisclosure
        response={makeResponse({ answer: 'Hard to fake [E1].' })}
        evidence={retrieved}
        validator={null}
        onOpenSource={vi.fn()}
        onShowSources={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Sources & reasoning/ })).toHaveTextContent(/2 sources$/);
  });
});

describe('ReasoningDetails', () => {
  it('renders read-only (no open handler) with plain citation keys', () => {
    render(<ReasoningDetails response={response} evidence={turn.evidence} validator={null} />);
    expect(screen.getByRole('list', { name: 'Claims and their sources' })).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('grounding notes', () => {
  it('counts what the checks changed, without content', () => {
    expect(groundingAdjustments(null)).toEqual([]);
    expect(groundingAdjustments(makeValidator({ factsDowngraded: 1 }))).toEqual([
      'Relabelled 1 unsupported fact as an inference.',
    ]);
    expect(groundingAdjustments(makeValidator({ factsDowngraded: 2, unknownEvidenceIdsRemoved: 1 }))).toEqual(
      ['Relabelled 2 unsupported facts as inferences.', 'Removed citations to unknown sources.'],
    );
  });

  it('marks a narrowed answer with its grounding', () => {
    const { unmount } = render(<NarrowedNote validator={makeValidator()} />);
    expect(screen.queryByTestId('narrowed-banner')).toBeNull();
    unmount();
    render(<NarrowedNote validator={makeValidator({ narrowed: true, groundingCoverage: 0.42 })} />);
    expect(screen.getByTestId('narrowed-banner')).toHaveTextContent(
      'Limited to what your evidence supports. Grounding 42%.',
    );
  });
});
