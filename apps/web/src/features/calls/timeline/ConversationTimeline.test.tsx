import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { clockLabel, ConversationTimeline, turnLabel } from './ConversationTimeline';
import { pastTimeline, TimelineRecorder } from './timeline-model';

const NAMES = { veir: 'Corin · vEIR', student: 'You' };

function recorded() {
  const recorder = new TimelineRecorder();
  for (let i = 0; i < 120; i++) recorder.step({ veir: 0.1, student: null });
  for (let i = 0; i < 9; i++) recorder.step({ veir: null, student: null });
  for (let i = 0; i < 260; i++) recorder.step({ veir: null, student: 0.05 });
  return recorder;
}

describe('ConversationTimeline', () => {
  it('names each turn by speaker and time, with roving focus across turns', async () => {
    const recorder = recorded();
    const onSelect = vi.fn();
    render(
      <TooltipProvider>
        <ConversationTimeline source={recorder} names={NAMES} onSelectTurn={onSelect} />
      </TooltipProvider>,
    );
    const group = screen.getByRole('group', { name: 'Conversation timeline' });
    expect(group).toBeInTheDocument();
    const veir = screen.getByRole('button', { name: 'Corin · vEIR, 0:00 to 0:12, 12 seconds' });
    const you = screen.getByRole('button', { name: 'You, from 0:13, speaking now' });
    // One tab stop: the latest turn.
    expect(you).toHaveAttribute('tabindex', '0');
    expect(veir).toHaveAttribute('tabindex', '-1');
    you.focus();
    await userEvent.keyboard('{Home}');
    expect(veir).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(you).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ speaker: 'student' }));
  });

  it('re-renders its buttons when a turn opens or closes, not for every bin', () => {
    const recorder = new TimelineRecorder();
    render(
      <TooltipProvider>
        <ConversationTimeline source={recorder} names={NAMES} />
      </TooltipProvider>,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    act(() => {
      recorder.step({ veir: 0.2, student: null });
    });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    act(() => {
      for (let i = 0; i < 9; i++) recorder.step({ veir: null, student: null });
    });
    expect(screen.getByRole('button', { name: /^Corin · vEIR, 0:00 to 0:00/ })).toBeInTheDocument();
  });

  it('shows a past session’s turns without invented amplitude, and a legend on request', () => {
    render(
      <TooltipProvider>
        <ConversationTimeline
          source={pastTimeline([{ speaker: 'veir', startMs: 0, endMs: 65_000 }])}
          names={NAMES}
          legend
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole('button', { name: 'Corin · vEIR, 0:00 to 1:05, 1 minute 5 seconds' }),
    ).toBeVisible();
    expect(screen.getByRole('list', { name: 'Timeline legend' })).toHaveTextContent('YouCorin · vEIR');
  });

  it('formats clock times and labels', () => {
    expect(clockLabel(65_400)).toBe('1:05');
    expect(
      turnLabel({ id: 'a', speaker: 'student', startMs: 54_000, endMs: 80_000, bins: [], text: '' }, NAMES),
    ).toBe('You, 0:54 to 1:20, 26 seconds');
  });
});
