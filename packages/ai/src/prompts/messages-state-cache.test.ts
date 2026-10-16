import { describe, expect, it, vi } from 'vitest';

import type * as ConversationStateModule from './conversation-state.js';

vi.mock('./conversation-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConversationStateModule>();
  return { ...actual, deriveConversationState: vi.fn(actual.deriveConversationState) };
});

const { deriveConversationState } = await import('./conversation-state.js');
const { buildMessages } = await import('./messages.js');

const HISTORY = [
  { founderText: 'How should we price per library?', answer: 'Start from who holds the budget. Who signs?' },
  { founderText: 'By the way, should we hire a designer?', answer: 'Hire for the bottleneck you have now.' },
  { founderText: 'Ok.', answer: 'Good. Then write down who owns which decision.' },
];

describe('the conversation state of a turn', () => {
  it('is derived once however often the context budget rebuilds the messages (up to 6 × 9 times)', () => {
    const derive = vi.mocked(deriveConversationState);
    derive.mockClear();
    const blocks = new Set<string>();
    for (let evidence = 0; evidence < 6; evidence += 1) {
      for (let turns = 8; turns >= 0; turns -= 1) {
        const messages = buildMessages(HISTORY, 'Where were we?', {
          evidenceBlock: `<evidence>${String(evidence)}</evidence>`,
          maxHistoryTurns: turns,
        });
        const last = messages.at(-1)?.content ?? '';
        blocks.add(last.slice(last.indexOf('<conversation_state>'), last.indexOf('</conversation_state>')));
      }
    }
    expect(derive).toHaveBeenCalledTimes(1);
    // The same observations in every candidate, as when each derived its own.
    expect(blocks.size).toBe(1);
    expect([...blocks][0]).toContain(
      'Parked, left before it was settled: "How should we price per library?"',
    );
  });

  it('is derived again for another message or another history', () => {
    const derive = vi.mocked(deriveConversationState);
    derive.mockClear();
    const history = [...HISTORY];
    buildMessages(history, 'Where were we?');
    buildMessages(history, 'Where were we?');
    expect(derive).toHaveBeenCalledTimes(1);
    buildMessages(history, 'Something else entirely, the grant deadline?');
    buildMessages([...history], 'Something else entirely, the grant deadline?');
    expect(derive).toHaveBeenCalledTimes(3);
    buildMessages(history, 'Where were we?', { conversationState: false });
    expect(derive).toHaveBeenCalledTimes(3);
  });
});
