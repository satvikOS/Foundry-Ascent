import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FollowUps } from './follow-ups';

// A real model's follow-ups run to 15–20 words (LAB-U1).
const QUESTIONS = [
  'How should we word the paid commitment ask so the librarian can say yes without going to the board?',
  'What deposit would show Hartwell is serious without scaring off the bursar this term?',
];

/*
 * Layout in numbers (jsdom lays nothing out): the row is 390 px wide from x = 0 with 16 px of padding, and the chip
 * being looked at is 800 px wide, starting `chipLeft` px from the viewport's left edge.
 */
let chipLeft = 0;
const scrollBy = vi.fn();

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 0, bottom: 32, height: 32, x: left, y: 0 } as DOMRect;
}

beforeEach(() => {
  chipLeft = 0;
  scrollBy.mockReset();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mount(onPick = vi.fn()) {
  render(<FollowUps questions={QUESTIONS} disabled={false} onPick={onPick} />);
  const row = screen.getByRole('list', { name: 'Follow-up questions' });
  row.style.paddingLeft = '16px';
  row.getBoundingClientRect = () => rect(0, 390);
  row.scrollBy = scrollBy;
  for (const chip of screen.getAllByRole('button')) {
    chip.getBoundingClientRect = () => rect(chipLeft, 800);
  }
  return { row, onPick };
}

describe('FollowUps', () => {
  it('shows each whole question on its chip: never cut short, and what is sent is what it says', async () => {
    const { onPick } = mount();
    for (const question of QUESTIONS) {
      const chip = screen.getByRole('button', { name: question });
      expect(chip).toHaveTextContent(question);
      expect(chip.className).not.toMatch(/\b(truncate|text-ellipsis|line-clamp-\d|max-w-)/);
    }
    await userEvent.setup().click(screen.getByRole('button', { name: QUESTIONS[1] }));
    expect(onPick).toHaveBeenCalledWith(QUESTIONS[1]);
  });

  it('a chip reached with Tab that is wider than the row is read from its start, not from its middle', async () => {
    mount();
    // The browser centred the focused 800 px chip on the 390 px row: its first 205 px are left of the row's edge.
    chipLeft = -205;
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: QUESTIONS[1] })).toHaveFocus();
    // Brought back so its first word sits at the row's padding edge (16 px in).
    expect(scrollBy).toHaveBeenCalledWith({ left: -221, behavior: 'instant' });
  });

  it('a chip pressed with a pointer is not moved under it', () => {
    mount();
    chipLeft = -205;
    const chip = screen.getByRole('button', { name: QUESTIONS[1] });
    // A press focuses without :focus-visible (the browser shows no ring for it).
    const matches = chip.matches.bind(chip);
    vi.spyOn(chip, 'matches').mockImplementation((selector: string) =>
      selector === ':focus-visible' ? false : matches(selector),
    );
    act(() => {
      chip.focus();
    });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('a chip reached with Tab whose start already shows is left where it is', async () => {
    mount();
    chipLeft = 16;
    await userEvent.setup().tab();
    expect(screen.getByRole('button', { name: QUESTIONS[0] })).toHaveFocus();
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
