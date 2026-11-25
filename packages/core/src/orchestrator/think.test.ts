import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { type PathPromptGuidance } from '../path/ai-adapter.js';
import { decide } from '../path/engine.js';
import { PLAYBOOK } from '../path/playbook/index.js';
import { fresh, input } from '../path/testing/inputs.js';
import { JUDGEMENT_PLAYS, asksJudgement, pathTurn } from '../path/turn.js';
import { thinkFor } from './think.js';

const guidanceOf = (message: string, earlierMessages: string[] = []): PathPromptGuidance =>
  pathTurn({ ...input(message, fresh({ playbook: PLAYBOOK })), continuity: {}, earlierMessages }).prompt;
const think = (
  mode: 'off' | 'judgement' | 'typed',
  guidance: PathPromptGuidance | null,
  over: { channel?: 'text' | 'voice'; coaches?: boolean } = {},
) => thinkFor(mode, { channel: 'text', coaches: true, guidance, ...over });

describe('which turns reason before they answer (CORE_THINK)', () => {
  it('is off unless the environment says otherwise, and a typo is an error', () => {
    expect(loadConfig({}).turns.think).toBe('off');
    expect(loadConfig({ CORE_THINK: ' ' }).turns.think).toBe('off');
    expect(loadConfig({ CORE_THINK: 'Judgement' }).turns.think).toBe('judgement');
    expect(loadConfig({ CORE_THINK: 'typed' }).turns.think).toBe('typed');
    expect(() => loadConfig({ CORE_THINK: 'on' })).toThrow('CORE_THINK must be off, judgement, typed');
  });

  it('judgement: news, a judgement asked for, an ask nothing of the program’s answers', () => {
    for (const message of [
      'Twelve people left their email on my page.',
      'A bank just launched the same thing for free.',
      'Is my idea any good?',
      'My friends all love it.',
    ])
      expect(think('judgement', guidanceOf(message)), message).toBe('low');
    const unanswered: PathPromptGuidance = {
      ...guidanceOf('Is my idea any good?'),
      ask: null,
      judgement: false,
    };
    expect(think('judgement', { ...unanswered, kind: 'coaching' })).toBe('low');
    const { lead: _lead, ...open } = unanswered;
    expect(
      think('judgement', { ...open, kind: 'coaching', lead: { text: 'A sum.', voice: 'A sum.' } }),
    ).toBeNull();
  });

  it('judgement: never an ask the program answers, a sum, a recall, small talk or what the server opens with', () => {
    for (const message of [
      'How do I price it?',
      'A box sells for 9 dollars and costs me 4. What do I make on 30 boxes?',
      'What did we decide last time?',
      'Thanks!',
      'Can you get me organized?',
    ])
      expect(think('judgement', guidanceOf(message)), message).toBeNull();
  });

  it('never a call, a turn that does not coach, a turn off the path, or with the switch off', () => {
    const news = guidanceOf('Twelve people left their email on my page.');
    expect(news.kind).toBe('news');
    for (const mode of ['judgement', 'typed'] as const) {
      expect(think(mode, news, { channel: 'voice' })).toBeNull();
      expect(think(mode, news, { coaches: false })).toBeNull();
      expect(think(mode, null)).toBeNull();
      for (const kind of ['recall', 'social', 'rehearsal'] as const)
        expect(think(mode, { ...news, kind })).toBeNull();
    }
    expect(think('off', news)).toBeNull();
    expect(think('typed', guidanceOf('How do I price it?'))).toBe('low');
  });
});

describe('a judgement asked for', () => {
  const of = (message: string): boolean => {
    const decision = decide(input(message, fresh({ playbook: PLAYBOOK })));
    return asksJudgement({ message }, decision);
  };
  it('is known by its play or its words', () => {
    for (const id of JUDGEMENT_PLAYS) expect(PLAYBOOK.plays.map((p) => p.id)).toContain(id);
    for (const message of [
      'Be honest, is my idea any good?',
      'Poke holes in this plan',
      'Is it worth doing this term?',
      'What does that show?',
      'What am I missing?',
    ])
      expect(of(message), message).toBe(true);
    for (const message of [
      'How do I write the message?',
      'What is a customer segment?',
      'Who should I call first?',
    ])
      expect(of(message), message).toBe(false);
  });

  it('news no rule reads falls back to a reading of it, never to the step’s parts', () => {
    const { kind, lead, fallback } = guidanceOf('The landlord doubled the rent for the stand this morning.');
    expect([kind, lead]).toEqual(['news', undefined]);
    expect(fallback?.text).toContain('One thing that happened is a fact to check, and no pattern yet');
    expect(fallback?.text).not.toMatch(/Here is how the step goes|\n1\. /);
    expect(fallback?.voice.split(/\s+/).length).toBeLessThan(50);
  });
});
