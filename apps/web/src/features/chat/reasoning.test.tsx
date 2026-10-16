import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeTurn, makeValidator } from '../coach/testing';
import { groundingAdjustments, NarrowedNote, ReasoningDetails, ReasoningDisclosure } from './reasoning';

const turn = makeTurn();
const response = (() => {
  if (!turn.response) throw new Error('fixture has no response');
  return turn.response;
})();

describe('ReasoningDisclosure', () => {
  it('is collapsed, summarises sources and claims, and expands on demand', async () => {
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
    expect(toggle).toHaveTextContent('2 sources · 4 claims');
    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const claims = screen.getByRole('list', { name: 'Claims and their sources' });
    expect(within(claims).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('What would convince you that everyday demand is real?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open the 2 sources' }));
    expect(onShowSources).toHaveBeenCalledOnce();
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
