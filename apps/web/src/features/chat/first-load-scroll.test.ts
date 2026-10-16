import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFirstLoadScroll } from './first-load-scroll';

const scrolled = vi.fn();

beforeEach(() => {
  scrolled.mockClear();
  for (const id of ['turn-t1', 'turn-t2', 'digest']) {
    const element = document.createElement('div');
    element.id = id;
    element.scrollIntoView = () => {
      scrolled(id);
    };
    document.body.append(element);
  }
});
afterEach(() => {
  document.body.replaceChildren();
});

interface Props {
  session: { status: 'active' | 'ended' | 'suspended' } | null;
  turns: { id: string }[];
  view?: string;
}

const props = (value: Props): Props => value;

describe('useFirstLoadScroll', () => {
  it('opens a conversation at its latest exchange, once', () => {
    const { rerender } = renderHook(
      (props: Props) => {
        useFirstLoadScroll(props.session, props.turns, props.view);
      },
      {
        initialProps: props({ session: { status: 'active' }, turns: [{ id: 't1' }] }),
      },
    );
    expect(scrolled).toHaveBeenCalledWith('turn-t1');
    rerender({ session: { status: 'active' }, turns: [{ id: 't1' }, { id: 't2' }] });
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it('never jumps when the first answer of a new conversation arrives (scrolled while it streamed)', () => {
    const { rerender } = renderHook(
      (props: Props) => {
        useFirstLoadScroll(props.session, props.turns, props.view);
      },
      {
        initialProps: props({ session: null, turns: [] }),
      },
    );
    // The conversation loads with no turns yet (opened from New chat), then its first answer completes.
    rerender({ session: { status: 'active' }, turns: [] });
    rerender({ session: { status: 'active' }, turns: [{ id: 't1' }] });
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('opens an ended conversation at its summary when asked to', () => {
    renderHook(() => {
      useFirstLoadScroll({ status: 'ended' }, [{ id: 't1' }], 'digest');
    });
    expect(scrolled).toHaveBeenCalledWith('digest');
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});
