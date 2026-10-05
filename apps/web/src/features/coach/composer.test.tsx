import type { CoachMode } from '@foundry/contracts';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { LiveAnnouncer } from '@/components/a11y/live-announcer';

import { Composer, MAX_TURN_CHARS } from './composer';
import { initialTurnProgress, turnProgressReducer } from './progress';
import { TurnProgressList } from './turn-progress';

function Harness({
  initialText = '',
  initialMode = 'diagnose',
  streaming = false,
  disabledReason = null,
  onSend,
  onStop = () => undefined,
}: {
  initialText?: string;
  initialMode?: CoachMode;
  streaming?: boolean;
  disabledReason?: string | null;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState<CoachMode>(initialMode);
  const [counterpart, setCounterpart] = useState('');
  return (
    <Composer
      value={text}
      onChange={setText}
      mode={mode}
      onModeChange={setMode}
      counterpart={counterpart}
      onCounterpartChange={setCounterpart}
      streaming={streaming}
      disabledReason={disabledReason}
      onSend={() => {
        onSend(text);
      }}
      onStop={onStop}
    />
  );
}

describe('Composer', () => {
  it('sends on Enter and adds a new line on Shift+Enter', async () => {
    const onSend = vi.fn<(text: string) => void>();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    const input = screen.getByRole('textbox', { name: 'Message Foundry Guide' });
    await user.type(input, 'First line{Shift>}{Enter}{/Shift}second line');
    expect(input).toHaveValue('First line\nsecond line');
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('First line\nsecond line');
  });

  it('does not send empty messages', async () => {
    const onSend = vi.fn<(text: string) => void>();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    await user.type(screen.getByRole('textbox', { name: 'Message Foundry Guide' }), '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('shows a character count and blocks messages over the limit', () => {
    const onSend = vi.fn<(text: string) => void>();
    render(<Harness onSend={onSend} initialText={'x'.repeat(MAX_TURN_CHARS + 1)} />);
    expect(screen.getByText(/characters — too long to send/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Foundry Guide' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('offers Stop while streaming and stops on Escape', async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={vi.fn()} onStop={onStop} streaming initialText="next question" />);
    const input = screen.getByRole('textbox', { name: 'Message Foundry Guide' });
    input.focus();
    await user.keyboard('{Enter}');
    expect(onStop).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onStop).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it('asks for the rehearsal counterpart in rehearse mode', () => {
    render(<Harness onSend={vi.fn()} initialMode="rehearse" />);
    expect(screen.getByLabelText('Rehearsing with')).toBeInTheDocument();
  });

  it('explains why it is disabled and always shows the AI reminder', () => {
    render(<Harness onSend={vi.fn()} disabledReason="Coaching is paused by an administrator." />);
    const input = screen.getByRole('textbox', { name: 'Message Foundry Guide' });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Coaching is paused by an administrator.');
    expect(screen.getByText(/Foundry Guide is an AI coach, not a person/)).toBeInTheDocument();
  });
});

describe('TurnProgressList', () => {
  it('renders the four steps with a text status and announces step changes', async () => {
    vi.useFakeTimers();
    try {
      const running = [
        { event: 'local.start' as const },
        { event: 'turn.status' as const, phase: 'retrieving' as const, detail: null, evidenceCount: 3 },
      ].reduce(turnProgressReducer, initialTurnProgress());
      render(
        <>
          <LiveAnnouncer />
          <TurnProgressList progress={running} />
        </>,
      );
      const list = screen.getByRole('list', { name: 'Response progress' });
      const items = within(list).getAllByRole('listitem');
      expect(items.map((li) => li.textContent)).toEqual([
        'Understanding — done',
        'Retrieving evidence (3) — in progress',
        'Reasoning — not started',
        'Checking grounding & policy — not started',
      ]);
      expect(items[1]).toHaveAttribute('aria-current', 'step');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.getByTestId('live-polite')).toHaveTextContent('Retrieving evidence: 3 sources found.');
    } finally {
      vi.useRealTimers();
    }
  });
});
