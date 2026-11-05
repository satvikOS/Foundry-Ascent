import { describe, expect, it } from 'vitest';

import { watchedAudio } from './speech-audio.js';
import { integerWords, numberWords, speechText } from './speech-text.js';
import { speakableText } from './spoken-text.js';

describe('speechText: the words a vendor voice is handed, as they are said', () => {
  it.each([
    ['Raise $1.5M by 2026.', 'Raise one point five million dollars by twenty twenty-six.'],
    ['We grew 25% in Q3, a 10x jump.', 'We grew twenty-five percent in Q3, a ten times jump.'],
    ['Talk to 3-5 clinics, e.g. the 2nd one.', 'Talk to three to five clinics, for example the second one.'],
    [
      'It costs $5.99 or $20k a year.',
      'It costs five dollars and ninety-nine cents or twenty thousand dollars a year.',
    ],
    ['In 2026 we had 2,026 users.', 'In twenty twenty-six we had two thousand twenty-six users.'],
    ['Since 1999, and 2005 before.', 'Since nineteen ninety-nine, and two thousand five before.'],
    [
      'Call 555-123-4567 at 10:30am.',
      'Call five five five, one two three, four five six seven at ten thirty a m.',
    ],
    ['On 2026-11-05 at 9:05 pm.', 'On November fifth, twenty twenty-six at nine oh five p m.'],
    ['About 1/2 of them, and/or 3/7.', 'About one half of them, and or three out of seven.'],
    ['We have 10+ pilots & 0.25 churn.', 'We have ten plus pilots and zero point two five churn.'],
    ['The #1 risk → price.', 'The number one risk to price.'],
    ['Revenue | Cost | Margin', 'Revenue, Cost, Margin'],
    ['It was -5 degrees.', 'It was minus five degrees.'],
    ['Plain words only.', 'Plain words only.'],
    ['Version v2 of the Q3 plan.', 'Version v2 of the Q3 plan.'],
  ])('%s', (input, said) => {
    expect(speechText(input)).toBe(said);
    // Idempotent: written-out words are left alone.
    expect(speechText(said)).toBe(said);
  });

  it('never reads a web or email address aloud: the caption shows it', () => {
    expect(speechText('See https://example.com/docs?a=1. Or www.foo.org.')).toBe(
      'See the link on screen. Or the link on screen.',
    );
    expect(speechText('Email me at a.b@uni.edu today.')).toBe(
      'Email me at the email address on screen today.',
    );
    // A Markdown link reads its words only (speakableText), never its target.
    expect(speechText(speakableText('Read [the guide](https://example.com/guide) first.'))).toBe(
      'Read the guide first.',
    );
  });

  it('never reads Markdown syntax or citation keys (with speakableText before it)', () => {
    const plain = speakableText('## Plan\n- **Talk** to `5` users [E2]\n- Ship by 3/4');
    expect(speechText(plain)).toBe('Plan Talk to five users Ship by three quarters');
  });

  it('writes numbers out', () => {
    expect(integerWords('0')).toBe('zero');
    expect(integerWords('1,000,001')).toBe('one million one');
    expect(integerWords('999999999999999')).toBe(
      'nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine',
    );
    expect(integerWords('12345678901234567')).toBe(
      'one two three four five six seven eight nine zero one two three four five six seven',
    );
    expect(numberWords('3.14')).toBe('three point one four');
  });
});

describe('watchedAudio', () => {
  it('reports a stream that breaks part-way once, and passes the error on', async () => {
    let failures = 0;
    let sent = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new TypeError('terminated'));
        else {
          sent = true;
          controller.enqueue(new Uint8Array([1, 2]));
        }
      },
    });
    const reader = watchedAudio(source, () => (failures += 1)).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    await expect(reader.read()).rejects.toThrow('terminated');
    expect(failures).toBe(1);
  });

  it('a whole stream or a reader that cancels is no failure', async () => {
    let failures = 0;
    const whole = watchedAudio(
      new Response(new Uint8Array([1, 2, 3])).body ?? new ReadableStream(),
      () => (failures += 1),
    );
    expect(new Uint8Array(await new Response(whole).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([0]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reader = watchedAudio(endless, () => (failures += 1)).getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(failures).toBe(0);
  });
});
