import { describe, expect, it } from 'vitest';

import { REPEATED_GREETING_FALLBACK, openerSaidHello, withoutRepeatedGreeting } from './greeting.js';

const MINA = ['Mina', 'Mina Castellane'];

describe('withoutRepeatedGreeting: the first reply after an intro that said hello', () => {
  it('drops a reply that is only a greeting (MX-0005: "Hello Mina, nice to hear from you.")', () => {
    for (const reply of [
      'Hello Mina, nice to hear from you.',
      'Hi Mina!',
      'Hey, good to have you back!',
      'Good to talk again.',
      'Welcome back, Mina.',
      'Hi again, Mina. Glad you stopped by.',
    ]) {
      expect(withoutRepeatedGreeting(reply, MINA), reply).toEqual({ text: '', removed: true });
    }
  });

  it('keeps what follows the greeting, as the start of a sentence', () => {
    expect(withoutRepeatedGreeting('Hi Mina, how did the interviews go?', MINA)).toEqual({
      text: 'How did the interviews go?',
      removed: true,
    });
    expect(withoutRepeatedGreeting('Good to talk again. Five interviews is a solid start.', MINA).text).toBe(
      'Five interviews is a solid start.',
    );
    expect(
      withoutRepeatedGreeting('Hey! Good to see you. So, the pilot: start with two libraries.', MINA).text,
    ).toBe('So, the pilot: start with two libraries.');
  });

  it('leaves a reply that does not open with a greeting unchanged', () => {
    for (const reply of [
      'Good to hear the pilot went well.',
      'Hi-res photos help the listing.',
      'Five interviews is a solid start.',
      'Mina, the most useful interviews ask about last time.',
      'Welcome packs for the libraries could work.',
    ]) {
      expect(withoutRepeatedGreeting(reply, MINA)).toEqual({ text: reply, removed: false });
    }
  });

  it('knows an opening line that said hello (a call’s intro), not a chat opener that welcomes back', () => {
    expect(openerSaidHello('Hi Mina, how did the interviews go?')).toBe(true);
    expect(
      openerSaidHello("Hi Rafi, I'm Corin's vEIR, Corin's digital twin. What would you like to work on?"),
    ).toBe(true);
    expect(
      openerSaidHello('Good to have you back. Last time, we talked about pricing. Want to pick that up?'),
    ).toBe(false);
    expect(openerSaidHello(null)).toBe(false);
    // A model-written opener greets in its own words (the coach hand-off): a hello, so the first reply does not greet
    // again (audit-final review: after a call's model-line intro the guard no longer fired).
    for (const opener of [
      'Good to see you again, Mina. How did the pilot go?',
      'Nice to see you! Did the librarians reply?',
      'Great to hear from you again. What came of the union meeting?',
      'Good to talk again, Mina. Where did pricing land?',
      'Lovely to see you, Mina! How were the interviews?',
      'Good morning, Mina. Ready for the numbers?',
      'Good to see you Mina! How did it go?',
    ]) {
      expect(openerSaidHello(opener, MINA), opener).toBe(true);
    }
    // A welcome is not a hello (pinned above): it still leaves a warm hello back.
    for (const opener of [
      'Welcome back! Where did pricing land?',
      'Good to have you back, Mina. How did it go?',
      "Glad you're back. Shall we look at the pilot?",
      'Good to hear the pilot went well. What next?',
    ]) {
      expect(openerSaidHello(opener, MINA), opener).toBe(false);
    }
    expect(REPEATED_GREETING_FALLBACK).not.toMatch(/\b(?:hi|hello|hey|welcome|good to)\b/i);
  });
});
