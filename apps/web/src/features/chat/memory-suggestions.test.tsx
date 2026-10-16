import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeMemory, makeResponse } from '../coach/testing';
import {
  MemorySuggestions,
  type CandidateBinding,
  type MemorySuggestionControls,
} from './memory-suggestions';

const candidate = (() => {
  const first = makeResponse().memory_candidates[0];
  if (!first) throw new Error('fixture has no memory candidate');
  return first;
})();

function controls(overrides: Partial<MemorySuggestionControls> = {}): MemorySuggestionControls {
  return {
    loading: false,
    pendingId: null,
    savingTitle: null,
    onKeep: vi.fn(),
    onDismiss: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
}

function renderRows(bindings: CandidateBinding[], overrides: Partial<MemorySuggestionControls> = {}) {
  const props = controls(overrides);
  render(<MemorySuggestions personaName="Corin" bindings={bindings} controls={props} />);
  return { props, user: userEvent.setup() };
}

describe('MemorySuggestions', () => {
  it('asks to keep a proposal in one compact row', async () => {
    const memory = makeMemory({ status: 'proposed' });
    const { props, user } = renderRows([{ candidate, memory }]);
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('Corin would like to remember: Exam weeks drive demand');
    await user.click(screen.getByRole('button', { name: 'Keep: Exam weeks drive demand' }));
    expect(props.onKeep).toHaveBeenCalledWith(memory);
    await user.click(screen.getByRole('button', { name: 'Not now: Exam weeks drive demand' }));
    expect(props.onDismiss).toHaveBeenCalledWith(memory);
  });

  it('shows a kept item as kept and drops a declined one', () => {
    const { unmount } = (() => {
      const result = render(
        <MemorySuggestions
          personaName="Corin"
          bindings={[{ candidate, memory: makeMemory({ status: 'confirmed' }) }]}
          controls={controls()}
        />,
      );
      return result;
    })();
    expect(screen.getByText('Kept')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Keep/ })).toBeNull();
    unmount();
    renderRows([{ candidate, memory: makeMemory({ status: 'rejected' }) }]);
    expect(screen.queryByRole('list', { name: 'Memory suggestions' })).toBeNull();
  });

  it('saves a suggestion that was not stored yet, and hides it on Not now', async () => {
    const { props, user } = renderRows([{ candidate, memory: null }]);
    await user.click(screen.getByRole('button', { name: 'Keep: Exam weeks drive demand' }));
    expect(props.onSave).toHaveBeenCalledWith(candidate);
    await user.click(screen.getByRole('button', { name: 'Not now: Exam weeks drive demand' }));
    expect(screen.queryByRole('list', { name: 'Memory suggestions' })).toBeNull();
  });

  it('waits for the venture’s memory before offering anything', () => {
    renderRows([{ candidate, memory: null }], { loading: true });
    expect(screen.queryByRole('button', { name: /Keep/ })).toBeNull();
  });

  it('hands keyboard focus to "Kept" when Keep succeeds (not to the page)', async () => {
    const memory = makeMemory({ status: 'proposed' });
    const props = controls();
    const { rerender } = render(
      <MemorySuggestions personaName="Corin" bindings={[{ candidate, memory }]} controls={props} />,
    );
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Keep: Exam weeks drive demand' }).focus();
    await user.keyboard('{Enter}');
    expect(props.onKeep).toHaveBeenCalledWith(memory);
    rerender(
      <MemorySuggestions
        personaName="Corin"
        bindings={[{ candidate, memory: { ...memory, status: 'confirmed' } }]}
        controls={props}
      />,
    );
    expect(screen.getByText('Kept').closest('span')).toHaveFocus();
  });

  it('never takes focus for an item that was kept before (a page load)', () => {
    const memory = makeMemory({ status: 'confirmed' });
    render(
      <MemorySuggestions personaName="Corin" bindings={[{ candidate, memory }]} controls={controls()} />,
    );
    expect(screen.getByText('Kept').closest('span')).not.toHaveFocus();
  });
});
