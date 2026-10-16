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

  it('keeps an opener without a greeting of its own whole, under a welcome', () => {
    const opener = 'Last time you planned to call facilities about the library budget. How did it go?';
    expect(newChatGreeting({ ...base, opener })).toEqual({ title: 'Welcome back, Maya', line: opener });
    // A line a person wrote for a founder with no conversation yet.
    expect(newChatGreeting({ ...base, opener: 'Corin asked me to check in.', returning: false })).toEqual({
      title: 'Hi, Maya',
      line: 'Corin asked me to check in.',
    });
  });

  it('greets by the time of day only with nothing to pick up, or in a private chat', () => {
    expect(newChatGreeting({ ...base, opener: null })).toEqual({
      title: 'Good evening, Maya',
      line: 'What should we work on for QuietQuad today?',
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
