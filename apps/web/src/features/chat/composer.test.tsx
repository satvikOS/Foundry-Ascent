import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { LiveAnnouncer } from '@/components/a11y/live-announcer';
import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { Composer, MAX_TURN_CHARS, type ComposerMode } from './composer';
import { initialTurnProgress, turnProgressReducer } from '../coach/progress';
import { TurnProgressList } from '../coach/turn-progress';

const DISCLOSURE = 'Foundry Guide is an AI coach. It is not a person.';

function Harness({
  initialText = '',
  initialMode = 'diagnose',
  streaming = false,
  disabledReason = null,
  onSend,
  onStop = () => undefined,
}: {
  initialText?: string;
  initialMode?: ComposerMode;
  streaming?: boolean;
  disabledReason?: string | null;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  const [counterpart, setCounterpart] = useState('');
  return (
    <Composer
      value={text}
      onChange={setText}
      personaName="Foundry Guide"
      disclosure={DISCLOSURE}
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
    renderWithProviders(<Harness onSend={onSend} />);
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
    renderWithProviders(<Harness onSend={onSend} />);
    await user.type(screen.getByRole('textbox', { name: 'Message Foundry Guide' }), '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('shows the character count only near the limit', () => {
    const { unmount } = renderWithProviders(<Harness onSend={vi.fn()} initialText="short question" />);
    expect(screen.queryByText(`/${MAX_TURN_CHARS.toLocaleString()}`, { exact: false })).toBeNull();
    unmount();
    renderWithProviders(
      <Harness onSend={vi.fn()} initialText={'x'.repeat(Math.ceil(MAX_TURN_CHARS * 0.95))} />,
    );
    expect(screen.getByText(new RegExp(`/${MAX_TURN_CHARS.toLocaleString()}$`))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });

  it('blocks messages over the limit', () => {
    const onSend = vi.fn<(text: string) => void>();
    renderWithProviders(<Harness onSend={onSend} initialText={'x'.repeat(MAX_TURN_CHARS + 1)} />);
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
    renderWithProviders(<Harness onSend={vi.fn()} onStop={onStop} streaming initialText="next question" />);
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
    renderWithProviders(<Harness onSend={vi.fn()} initialMode="rehearse" />);
    expect(screen.getByLabelText('Rehearsing with')).toBeInTheDocument();
  });

  it('always offers Auto first, so the vEIR can pick the approach', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onSend={vi.fn()} initialMode="auto" />);
    const mode = screen.getByRole('combobox', { name: 'Mode for the next message' });
    expect(mode).toHaveTextContent('Auto');
    await user.click(mode);
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options[0]).toBe('Auto');
    expect(options).toContain('Rehearse');
  });

  it('explains why it is disabled and always carries one AI disclosure line', () => {
    renderWithProviders(<Harness onSend={vi.fn()} disabledReason="AI is paused" />);
    const input = screen.getByRole('textbox', { name: 'Message Foundry Guide' });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'AI is paused');
    const notes = screen.getAllByRole('note', { name: 'AI disclosure' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(DISCLOSURE);
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
      // One quiet line: only the step in progress is shown; the others stay for screen readers.
      expect(items.filter((li) => li.className.includes('sr-only'))).toHaveLength(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.getByTestId('live-polite')).toHaveTextContent('Retrieving evidence: 3 sources found.');
    } finally {
      vi.useRealTimers();
    }
  });
});
