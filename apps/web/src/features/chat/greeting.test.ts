import { describe, expect, it } from 'vitest';

import { newChatGreeting, splitOpener } from './greeting';

const EVENING = new Date(2026, 9, 16, 19, 0);
const base = {
  firstName: 'Maya',
  ventureName: 'QuietQuad',
  returning: true,
  privateChat: false,
  now: EVENING,
};

describe('New chat’s greeting', () => {
  it('greets with the vEIR’s opener: its greeting as the heading with the name, the rest word for word', () => {
    const opener = 'Welcome back. Last time we were on per-library pricing. How did the facilities call go?';
    const shown = newChatGreeting({ ...base, opener });
    expect(shown).toEqual({
      title: 'Welcome back, Maya',
      line: 'Last time we were on per-library pricing. How did the facilities call go?',
    });
    // The conversation opens with that same line: nothing of it is lost or added but the name.
    expect(`${shown.title.replace(', Maya', '')}. ${shown.line}`).toBe(opener);
    for (const [line, title] of [
      [
        'Good to have you back. Want to pick up where we left off yesterday, or start on something new?',
        'Good to have you back, Maya',
      ],
      [
        'Good to talk again. Last time (about 3 minutes ago, on a call), you asked “Who pays?” Where did you land on it?',
        'Good to talk again, Maya',
      ],
      [
        'Nice to hear from you again. I wanted to come back to the five interviews you planned. How is it going?',
        'Nice to hear from you again, Maya',
      ],
      [
        'Good to have you here. Your last conversation here (yesterday) was about pricing. Want to pick that up, or start somewhere new?',
        'Good to have you here, Maya',
      ],
      ['Hi Maya! How did the interviews go?', 'Hi Maya'],
    ] as const) {
      expect(newChatGreeting({ ...base, opener: line }).title).toBe(title);
    }
  });

  it('keeps an opener without a greeting of its own whole, under a welcome that changes with the line', () => {
    const opener = 'Last time you planned to call facilities about the library budget. How did it go?';
    const shown = newChatGreeting({ ...base, opener });
    expect(shown.line).toBe(opener);
    expect(shown.title).toMatch(/^(?:Welcome back|Good to see you|Hello again|Nice to see you), Maya$/);
    // The same line, the same heading (it never changes in front of them); other lines, other welcomes.
    expect(newChatGreeting({ ...base, opener }).title).toBe(shown.title);
    const titles = new Set(
      [
        'Did the second library answer about the trial?',
        'How did the facilities call go?',
        'Where did the pricing page land with the dean?',
        'Any word from the landlord on the sensors?',
        'The survey went out: how many replies so far?',
        'You were about to book the study room; did it work out?',
      ].map((line) => newChatGreeting({ ...base, opener: line }).title),
    );
    expect(titles.size).toBeGreaterThan(1);
    // Never the welcome the previous line had (review of coaching v3: chosen by the line alone, one in four came back),
    // whatever the lines: a founder's run of new openers never sees the same heading twice in a row.
    const lines = [
      'Did the second library answer about the trial?',
      'How did the facilities call go?',
      'Where did the pricing page land with the dean?',
      'Any word from the landlord on the sensors?',
      'The survey went out: how many replies so far?',
      'You were about to book the study room; did it work out?',
      'Two quotes were due back on Friday. Did either arrive?',
      'Last time the dean wanted numbers. Which ones did you send?',
    ];
    let previousWelcome = null as ReturnType<typeof newChatGreeting>['welcome'] | null;
    let lastTitle = '';
    for (const line of lines) {
      const next = newChatGreeting({ ...base, opener: line, previousWelcome });
      expect(next.title).not.toBe(lastTitle);
      // The same line again (a reload) keeps its heading.
      expect(newChatGreeting({ ...base, opener: line, previousWelcome: next.welcome }).title).toBe(
        next.title,
      );
      lastTitle = next.title;
      previousWelcome = next.welcome ?? null;
    }
    // The heading's welcome is remembered by a hash of the line, never its words.
    expect(JSON.stringify(previousWelcome)).not.toContain('dean');
    // A line a person wrote for a founder with no conversation yet.
    expect(newChatGreeting({ ...base, opener: 'Corin asked me to check in.', returning: false })).toEqual({
      title: 'Hi, Maya',
      line: 'Corin asked me to check in.',
    });
  });

  it('takes the vEIR’s own varied greeting as the heading (coaching v3: model-written openers)', () => {
    for (const [line, title] of [
      ['Hey. The two pilot quotes you were waiting on: did either come back?', 'Hey, Maya'],
      ['Morning! You were about to send the landlord survey; how many replies so far?', 'Morning, Maya'],
      ['Good afternoon. Where did the pricing call with the library land?', 'Good afternoon, Maya'],
    ] as const) {
      expect(newChatGreeting({ ...base, opener: line }).title).toBe(title);
    }
  });

  it('greets by the time of day only with nothing to pick up, or in a private chat', () => {
    expect(newChatGreeting({ ...base, opener: null })).toEqual({
      title: 'Good evening, Maya',
      line: 'What should we work on today?',
    });
    expect(
      newChatGreeting({ ...base, opener: 'Welcome back. Last time we were on pricing.', privateChat: true }),
    ).toEqual({ title: 'Good evening, Maya', line: 'What’s on your mind?' });
  });

  it('takes only a short greeting sentence as the heading', () => {
    expect(splitOpener('Welcome back. Yesterday, we were on pricing.')).toEqual({
      greeting: 'Welcome back.',
      rest: 'Yesterday, we were on pricing.',
    });
    expect(splitOpener('Last time we were on pricing. How did it go?').greeting).toBeNull();
    expect(
      splitOpener('Hello and thanks again for walking me through the whole pilot plan. What next?').greeting,
    ).toBeNull();
    expect(splitOpener('Welcome back.').greeting).toBeNull();
  });
});
