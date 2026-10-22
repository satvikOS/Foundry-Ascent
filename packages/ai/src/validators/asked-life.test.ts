import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  askedLifeOf,
  finishLifeReply,
  gerundSubject,
  inSingleQuotes,
  lifeClosing,
  lifeRest,
  lifeUnitAfterRemoval,
  onlyLifeTail,
} from './asked-life.js';
import { identityQuestionOf, rewriteIdentity, type IdentityRewriteOptions } from './identity.js';
import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';

/**
 * A made-up life in reply to the founder asking about the coach's own (evals MX-0032: "lowkey, how was your weekend?"
 * got "Weekend was good, thanks for asking."), read only then. The shared cases (evals/tests/fixtures) are checked by
 * the matrix presence check too (evals/tests/test_matrix_checks.py).
 */

const BASE = {
  personaName: "Corin's vEIR",
  eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song', 'Elise Brannigan'],
  personaEirName: 'Corin Halvorsen',
  addressees: ['Maya Chen'],
};

/** A shared fixture of evals/tests/fixtures, parsed (null when the repository lacks it: the tests then fail). */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../../evals/tests/fixtures/${name}`, import.meta.url));
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
}

/** The reply rewrite as validateCoachResponse runs it: answering `founder` (when given), its identity question read. */
function reply(text: string, founder: string, spoken: boolean, withFounder = true) {
  const answers = identityQuestionOf(founder, BASE);
  const options: IdentityRewriteOptions = {
    ...BASE,
    spoken,
    disclaimers: 'reply',
    identityAsked: answers !== null,
    answers,
    ...(withFounder ? { founderText: founder } : {}),
  };
  return rewriteIdentity(text, options);
}

/** A model-like stream: two words (and their spacing) per chunk. */
function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let words = 0;
  for (const part of text.split(/(\s+)/u)) {
    cur += part;
    if (/\S/u.test(part)) words += 1;
    if (words >= 2 && /\s/u.test(part)) {
      out.push(cur);
      cur = '';
      words = 0;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** The sentence gate as a turn streams a reply (typed, or said on a call), with or without the founder's message. */
function stream(text: string, founder: string | null, spoken: boolean): { shown: string; said: string } {
  const options: SentenceGateOptions = {
    ...BASE,
    founderName: 'Maya',
    otherVentureNames: ['BenchTally'],
    otherVentureCanaries: ['ZX-CANARY-4471'],
    keepDropped: true,
    callerContinues: true,
    spoken,
    ...(founder === null ? {} : { founderText: founder }),
  };
  const gate = new SentenceGate(options);
  const units: GateUnit[] = [];
  for (const chunk of chunks(text)) units.push(...gate.push(chunk).units);
  units.push(...gate.end().units);
  return {
    shown: units.map((u) => u.text).join(''),
    said: units
      .map((u) => u.spoken)
      .filter((s) => s !== '')
      .join(' '),
  };
}

interface AskedLifeSuite {
  questions: Record<'past' | 'other' | 'news' | 'more' | 'none', string[]>;
  removed: { asked: string; text: string; rewritten: string }[];
  kept: { asked: string; text: string }[];
}

const suite =
  (
    fixture('identity_cases.json') as { suites: { name: string; asked_life?: AskedLifeSuite }[] } | null
  )?.suites.find((s) => s.asked_life !== undefined)?.asked_life ?? null;

describe('a life of its own told when the founder asks about it (shared with the matrix presence check)', () => {
  it('reads the shared cases (they live in this repository)', () => {
    expect(suite).not.toBeNull();
  });

  it('reads the founder’s question about the coach’s own life the way the grader does', () => {
    for (const [kind, messages] of Object.entries(suite?.questions ?? {})) {
      for (const message of messages) {
        const life = askedLifeOf(message);
        const read = life === null ? 'none' : life.news ? 'news' : life.more ? 'more' : life.asked;
        expect(read, message).toBe(kind);
      }
    }
  });

  it('takes the made-up life out of the reply, typed and spoken, keeping the thanks and turning to the founder', () => {
    for (const { asked, text, rewritten } of suite?.removed ?? []) {
      for (const spoken of [false, true]) {
        const out = reply(text, asked, spoken);
        expect(out.text, `${asked} → ${text}`).toBe(rewritten);
        expect(out.findings, text).toContainEqual({ kind: 'claims_human', rule: 'personal_life' });
        // What is left is no made-up life, and never a bare "You?".
        expect(reply(rewritten, asked, spoken).text, rewritten).toBe(rewritten);
        expect(rewritten).not.toMatch(/(?:^|[.!?]\s+)(?:and\s+)?(?:you|yours)\?$/iu);
      }
    }
  });

  it('streams the same reply as the whole one, shown and said, before any made-up life is shown or said', () => {
    for (const { asked, text, rewritten } of suite?.removed ?? []) {
      expect(stream(text, asked, false).shown, `${asked} → ${text}`).toBe(rewritten);
      const call = stream(text, asked, true);
      expect(call.shown, `${asked} → ${text} (call)`).toBe(rewritten);
      expect(call.said, `${asked} → ${text} (call)`).toBe(rewritten);
    }
  });

  it('leaves every other reply to such a question as written, whole and streamed', () => {
    for (const { asked, text } of suite?.kept ?? []) {
      for (const spoken of [false, true]) {
        expect(reply(text, asked, spoken), `${asked} → ${text}`).toEqual({ text, findings: [] });
        expect(stream(text, asked, spoken).shown, `${asked} → ${text}`).toBe(text);
      }
    }
  });

  it('changes nothing without such a question, and nothing outside the reply', () => {
    for (const { asked, text } of suite?.removed ?? []) {
      for (const founder of ['how did the pilot go?', 'how are you?', 'thanks, talk tomorrow!']) {
        expect(reply(text, founder, false), text).toEqual(reply(text, founder, false, false));
        expect(stream(text, founder, true), text).toEqual(stream(text, null, true));
      }
      // A field (a claim, a next action, a memory) is never read with the founder's message.
      for (const disclaimers of ['field', undefined] as const) {
        const field = { ...BASE, ...(disclaimers === undefined ? {} : { disclaimers }) };
        expect(rewriteIdentity(text, { ...field, founderText: asked }), text).toEqual(
          rewriteIdentity(text, field),
        );
      }
      expect(
        rewriteIdentity(text, { ...BASE, disclaimers: 'reply', founderText: asked, presence: false }),
      ).toEqual(rewriteIdentity(text, { ...BASE, disclaimers: 'reply', presence: false }));
    }
  });
});

interface Regression {
  regression: number;
  founder: string | null;
  reply: string;
  small_talk: boolean;
  g14: boolean;
  rewritten?: string;
  gate?: string;
}

const regressions = (fixture('presence_regressions.json') as { cases: Regression[] } | null)?.cases ?? null;

describe('the founder’s own story, bio, quote and draft stay as main left them (audit B-presence)', () => {
  it('reads every regression the presence work once made (they live in this repository)', () => {
    expect(regressions?.length ?? 0).toBeGreaterThanOrEqual(58);
    expect(new Set(regressions?.map((c) => c.regression)).size).toBe(58);
  });

  it('rewrites each reply with the founder’s message exactly as without it, typed and spoken', () => {
    for (const c of regressions ?? []) {
      if (c.founder === null) continue;
      for (const spoken of [false, true]) {
        const withFounder = reply(c.reply, c.founder, spoken);
        if (c.rewritten === undefined) {
          expect(withFounder, `#${c.regression}: ${c.reply}`).toEqual(
            reply(c.reply, c.founder, spoken, false),
          );
        } else {
          // The founder asked how the coach's weekend was and the reply made one up (evals MX-0032).
          expect(withFounder.text, `#${c.regression}: ${c.reply}`).toBe(
            spoken ? reply(c.rewritten, c.founder, true).text : c.rewritten,
          );
        }
      }
    }
  });

  it('streams each reply with the founder’s message exactly as without it, shown and said', () => {
    for (const c of regressions ?? []) {
      for (const spoken of [false, true]) {
        const streamed = stream(c.reply, c.founder, spoken);
        if (c.rewritten === undefined || c.founder === null) {
          expect(streamed, `#${c.regression}: ${c.reply}`).toEqual(stream(c.reply, null, spoken));
        } else {
          expect(streamed.shown, `#${c.regression}: ${c.reply}`).toBe(c.rewritten);
        }
        // Main's gate output where the regression was the streamed path (its catches after a draft's sign-off stay).
        if (c.gate !== undefined) expect(streamed.shown, `#${c.regression}: ${c.reply}`).toBe(c.gate);
      }
    }
  });
});

interface AskedLifeRegression {
  audit: string;
  founder: string;
  reply: string;
  small_talk: boolean;
  g14: boolean;
  rewritten?: string;
}

const askedRegressions =
  (fixture('asked_life_regressions.json') as { cases: AskedLifeRegression[] } | null)?.cases ?? null;

describe('what the asked-life rule once cut stays as main left it, or loses the made-up life as intended (audit diff2-B2)', () => {
  it('reads every regression of the audit (they live in this repository)', () => {
    expect(askedRegressions?.length ?? 0).toBe(38);
  });

  it('rewrites each reply with the founder’s message as main did, or takes out the made-up life, typed and spoken', () => {
    for (const c of askedRegressions ?? []) {
      for (const spoken of [false, true]) {
        const withFounder = reply(c.reply, c.founder, spoken);
        if (c.rewritten === undefined) {
          expect(withFounder, `${c.audit}: ${c.reply}`).toEqual(reply(c.reply, c.founder, spoken, false));
        } else {
          expect(withFounder.text, `${c.audit}: ${c.reply}`).toBe(
            spoken ? reply(c.rewritten, c.founder, true).text : c.rewritten,
          );
          expect(withFounder.findings, c.audit).toContainEqual({
            kind: 'claims_human',
            rule: 'personal_life',
          });
          // What is left tells no made-up life, and never opens or ends on a bare "You?".
          expect(reply(c.rewritten, c.founder, spoken).text, c.audit).toBe(c.rewritten);
          expect(c.rewritten).not.toMatch(/(?:^|[.!?]\s+)(?:and\s+)?(?:you|yours)\?(?:\s|$)/iu);
        }
      }
    }
  });

  it('streams each reply as the whole one reads, shown and said', () => {
    for (const c of askedRegressions ?? []) {
      for (const spoken of [false, true]) {
        const streamed = stream(c.reply, c.founder, spoken);
        if (c.rewritten === undefined) {
          expect(streamed, `${c.audit}: ${c.reply}`).toEqual(stream(c.reply, null, spoken));
        } else {
          expect(streamed.shown, `${c.audit}: ${c.reply}`).toBe(c.rewritten);
          if (spoken) expect(streamed.said, `${c.audit}: ${c.reply}`).toBe(c.rewritten);
        }
      }
    }
  });
});

describe('where a life is not the coach’s own', () => {
  it('keeps what else a sentence says when it answers the founder, and only that', () => {
    expect(lifeRest("thanks — but I'm really sorry about the accelerator.", false)).toEqual({
      kept: "I'm really sorry about the accelerator.",
    });
    expect(lifeRest('but 10k MRR is huge.', false)).toEqual({ kept: '10k MRR is huge.' });
    expect(lifeRest("thanks — sorry yours hasn't.", false)).toBe('leans');
    expect(lifeRest('hope you had fun too.', false)).toBe('leans');
    expect(lifeRest('thanks for asking!', true)).toBeNull();
    expect(lifeRest('how about you?', true)).toBeNull();
    // Not plainly something else: more of the same life, which goes with its sentence.
    expect(lifeRest('thanks — lots of calls.', false)).toBeNull();
    expect(lifeRest('a week by the sea.', false)).toBeNull();
    // After a thanks, the answer to the founder's own question ("…also, is £4 too much?").
    expect(lifeRest('thanks — £4 is fine.', true)).toEqual({ kept: '£4 is fine.' });
  });

  it('reads a verbless life only as all its sentence says', () => {
    expect(onlyLifeTail(', mostly')).toBe(true);
    expect(onlyLifeTail(', mostly reading and a bit of gardening')).toBe(true);
    expect(onlyLifeTail(' if the weather holds')).toBe(true);
    expect(onlyLifeTail(', thanks for asking! How about you')).toBe(true);
    expect(onlyLifeTail(', reading, whatever recharges you — do that this weekend')).toBe(false);
    expect(onlyLifeTail(', a long lunch, no laptop')).toBe(false);
    expect(onlyLifeTail(' if you can get away')).toBe(false);
  });

  it('reads an "-ing" that is the subject of its clause as advice', () => {
    expect(gerundSubject('Going to the farmers market', ' this weekend is a great idea ')).toBe(true);
    expect(gerundSubject('Going hiking', ' on Sunday beats another sprint')).toBe(true);
    expect(gerundSubject('Heading up to the lake', ' with friends')).toBe(false);
    expect(gerundSubject('Slept in', ' and read')).toBe(false);
  });

  it('reads a line in straight single quotes as one the founder will say', () => {
    const line = "Pick one true detail: 'Good, thanks — went climbing on Saturday.' Then ask about theirs.";
    expect(inSingleQuotes(line, line.indexOf('went'))).toBe(true);
    expect(inSingleQuotes(line, line.indexOf('Then'))).toBe(false);
    const apostrophes = "It's been a quiet one, the kids' party aside — went climbing.";
    expect(inSingleQuotes(apostrophes, apostrophes.indexOf('went'))).toBe(false);
  });
});

describe('reading a made-up life stays linear', () => {
  it('rewrites 1,200 sentences of banter in linear time', () => {
    const text = (count: number): string =>
      Array.from({ length: count }, (_, i) =>
        i % 4 === 0
          ? 'Weekend was good, thanks for asking!'
          : i % 4 === 1
            ? 'Good, thanks! Slept in and read.'
            : i % 4 === 2
              ? 'Mine was a lovely, long, relaxing weekend.'
              : 'Run the pilot with ten libraries.',
      ).join(' ');
    const founder = 'lowkey, how was your weekend?';
    expect(reply(text(1_200), founder, false).text).not.toMatch(/Weekend was good|Slept in/);
    const time = (count: number): number => {
      const input = text(count);
      const started = performance.now();
      for (let i = 0; i < 3; i += 1) reply(input, founder, false);
      return performance.now() - started;
    };
    time(150);
    let small = Infinity;
    let large = Infinity;
    for (let round = 0; round < 3; round += 1) {
      small = Math.min(small, time(150));
      large = Math.min(large, time(1_200));
    }
    expect(large).toBeLessThan(16 * small + 100);
  }, 30_000);

  it('reads a run of bare answers opening the reply in a few rounds, not one round each', () => {
    const founder = 'how was your weekend?';
    const time = (count: number): number => {
      const input = 'Lovely! '.repeat(count).trim();
      const started = performance.now();
      for (let i = 0; i < 3; i += 1) reply(input, founder, false);
      return performance.now() - started;
    };
    time(150);
    let small = Infinity;
    let large = Infinity;
    for (let round = 0; round < 3; round += 1) {
      small = Math.min(small, time(150));
      large = Math.min(large, time(1_200));
    }
    expect(large).toBeLessThan(16 * small + 100);
  }, 30_000);
});

describe('the reply still turns to the founder once its made-up life is out', () => {
  const past = { asked: 'past', news: false, more: false } as const;
  const other = { asked: 'other', news: false, more: false } as const;

  it.each([
    ['', past, 'Thanks for asking! How was yours?'],
    ['Thanks for asking!', past, 'Thanks for asking! How was yours?'],
    ["I'm good, thanks!", other, "I'm good, thanks! How about you?"],
    ['Thanks! You?', past, 'Thanks! How was yours?'],
    ['You?', other, 'Thanks for asking! How about you?'],
    ['How was yours?', past, 'Thanks for asking! How was yours?'],
    ['Did you get a break?', past, 'Thanks for asking! Did you get a break?'],
    [
      "I am — Corin's digital twin. You?",
      past,
      "I am — Corin's digital twin. Thanks for asking! How was yours?",
    ],
    ['Thanks! What did I miss?', past, 'Thanks! What did I miss?'],
    [
      'You? Also, did the survey go out?',
      past,
      'Thanks for asking! How was yours? Also, did the survey go out?',
    ],
    [
      'Thanks! You? Also, did the survey go out?',
      past,
      'Thanks! How was yours? Also, did the survey go out?',
    ],
    ['Now, where are we on pricing?', past, 'Now, where are we on pricing?'],
  ] as const)('finishes %j', (text, life, finished) => {
    expect(finishLifeReply(text, life)).toBe(finished);
  });

  it('drops an "Anyway —" that leaned on the life that opened the reply, and only that one', () => {
    expect(finishLifeReply('Anyway — how did the pilot calls go?', past, true)).toBe(
      'How did the pilot calls go?',
    );
    expect(finishLifeReply('Anyway — how did the pilot calls go?', past, false)).toBe(
      'Anyway — how did the pilot calls go?',
    );
    expect(lifeUnitAfterRemoval('', 'Anyway — how did the pilot calls go?', past)).toBe(
      'How did the pilot calls go?',
    );
    expect(lifeUnitAfterRemoval(' Thanks!', 'Anyway — how did the pilot calls go?', past)).toBe(
      'Anyway — how did the pilot calls go?',
    );
  });

  it('turns back in the stream as the whole reply does', () => {
    expect(lifeUnitAfterRemoval('', 'You?', past)).toBe('Thanks for asking! How was yours?');
    expect(lifeUnitAfterRemoval(' Thanks for asking!', 'You?', past)).toBe('How was yours?');
    expect(lifeUnitAfterRemoval(' Thanks!', 'What did I miss?', past)).toBe('What did I miss?');
    expect(lifeUnitAfterRemoval('', 'Did you get a break?', past)).toBe(
      'Thanks for asking! Did you get a break?',
    );
    expect(lifeUnitAfterRemoval(" I am — Corin's digital twin.", 'You?', past)).toBe(
      'Thanks for asking! How was yours?',
    );
    expect(lifeClosing('', other)).toBe('Thanks for asking! How about you?');
    expect(lifeClosing(' Thanks!', past)).toBe('How was yours?');
    expect(lifeClosing(' Thanks! Shall we start?', past)).toBeNull();
  });

  it('asks after the founder’s own when they told it already', () => {
    expect(finishLifeReply('Thanks!', { asked: 'past', news: true, more: false })).toBe(
      'Thanks! Tell me more about yours.',
    );
  });
});
