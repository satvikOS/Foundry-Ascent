/**
 * Indirect suicidal ideation: the phrasings people actually use instead of "suicide", and the venture talk that
 * shares their words.
 *
 * The positive families follow published screening and warning-sign guidance:
 *  - C-SSRS screener, item 1: wishing to be dead, or to go to sleep and not wake up.
 *  - AFSP warning signs: talk of having no reason to live, being a burden to others, feeling trapped, unbearable
 *    pain, saying goodbye.
 *  - QPR indirect verbal clues: "my family would be better off without me", "I just want out", "I won't be
 *    around much longer", "pretty soon you won't have to worry about me".
 *  - "I can't take it anymore" style statements, which are warning signs in a despairing context and ordinary
 *    frustration otherwise.
 *
 * The decision rule for an ambiguous line (see rules.ts, "Indirect ideation"):
 *  1. a personal-distress cue anywhere in the message → crisis;
 *  2. otherwise, venture-work vocabulary in the message → not flagged (the line is about the work);
 *  3. otherwise → crisis for "ending it" style lines, a non-crisis wellbeing signal for "I can't do this anymore"
 *     style lines.
 */
import { describe, expect, it } from 'vitest';

import { classifyRisk, riskLabel } from './classifier.js';

type Kind = 'direct' | 'indirect' | 'slang' | 'typo' | 'lowercase' | 'multilingual' | 'context';

interface Positive {
  readonly text: string;
  readonly kind: Kind;
}

const POSITIVES: readonly Positive[] = [
  // "Ending it" without an object (the sibling stream's finding first).
  { text: "I'm thinking about ending it.", kind: 'indirect' },
  { text: "i'm thinking about ending it", kind: 'lowercase' },
  { text: 'im thinking about ending it', kind: 'typo' },
  { text: "I've been thinking about ending things.", kind: 'indirect' },
  { text: "I think I'm going to end it tonight.", kind: 'indirect' },
  { text: 'thinkin bout endin it tbh', kind: 'slang' },
  { text: 'Maybe I should just end it. Nobody would even notice.', kind: 'indirect' },
  { text: "I almost ended it last night and I'm scared.", kind: 'indirect' },
  // Not wanting to be here / to exist.
  { text: "I don't want to be here anymore", kind: 'indirect' },
  { text: 'i dont want to be here anymore', kind: 'lowercase' },
  { text: "I don't wanna be here any more.", kind: 'slang' },
  { text: "I don't want to exist anymore.", kind: 'indirect' },
  // Loss of meaning, no reason to live (AFSP).
  { text: "What's the point of any of this?", kind: 'indirect' },
  { text: "what's even the point anymore", kind: 'lowercase' },
  { text: 'I have nothing left to live for.', kind: 'indirect' },
  { text: "Life isn't worth living anymore.", kind: 'indirect' },
  { text: "I've lost the will to live.", kind: 'indirect' },
  // Wanting to disappear.
  { text: 'I want to disappear.', kind: 'indirect' },
  { text: 'I just wanna disappear forever', kind: 'slang' },
  { text: 'I want to disappear from this world.', kind: 'indirect' },
  // Burden (AFSP, QPR).
  { text: 'Everyone would be better off without me.', kind: 'indirect' },
  { text: 'my family would be better off without me', kind: 'lowercase' },
  { text: "Everybody would be better off if I wasn't here.", kind: 'indirect' },
  { text: "They'd all be better off if I was gone", kind: 'indirect' },
  { text: "I keep thinking everyone would be happier if I wasn't around.", kind: 'indirect' },
  { text: 'nobody would care if i died', kind: 'lowercase' },
  // Despairing context around "I can't do this anymore" (helpguide, 988).
  { text: "I'm falling apart. I can't do this anymore.", kind: 'context' },
  { text: "I can't take it anymore, everything hurts.", kind: 'context' },
  { text: "I can't do this anymore. I hate my life.", kind: 'context' },
  { text: "Nobody cares. I can't keep going like this anymore.", kind: 'context' },
  // Sleep and not wake up (C-SSRS item 1).
  { text: 'I wish I could go to sleep and never wake up.', kind: 'indirect' },
  { text: "Sometimes I hope I don't wake up tomorrow.", kind: 'indirect' },
  { text: "I wouldn't mind if I didn't wake up tomorrow.", kind: 'indirect' },
  { text: "I wish I'd never been born.", kind: 'indirect' },
  // Wanting it to stop, wanting out, not being around (AFSP, QPR).
  { text: 'I just want it all to stop.', kind: 'indirect' },
  { text: 'I want the pain to end.', kind: 'indirect' },
  { text: 'I just want out.', kind: 'indirect' },
  { text: "I won't be around much longer.", kind: 'indirect' },
  { text: "You won't have to worry about me much longer.", kind: 'indirect' },
  { text: 'This is goodbye. Thank you for everything.', kind: 'indirect' },
  // Means (AFSP: looking for a way).
  { text: 'I want to jump off a bridge.', kind: 'direct' },
  { text: "I'm going to take all my pills tonight.", kind: 'direct' },
  // Slang, algospeak, leetspeak, misspellings.
  { text: "i'm going to kms", kind: 'slang' },
  { text: 'i want to unalive myself', kind: 'slang' },
  { text: 'been thinking about sewerslide a lot', kind: 'slang' },
  { text: 'I keep thinking about k1lling mys3lf', kind: 'typo' },
  { text: 'thinking about su1c1de again', kind: 'typo' },
  { text: "I've been feeling suicidial for weeks", kind: 'typo' },
  { text: 'im so done with life', kind: 'typo' },
  // Multilingual (the classifier's crisis languages).
  { text: 'Todos estarían mejor sin mí.', kind: 'multilingual' },
  { text: 'Estoy pensando en acabar con todo.', kind: 'multilingual' },
  { text: 'Quiero dormir y no despertar nunca.', kind: 'multilingual' },
  { text: 'Tout le monde serait mieux sans moi.', kind: 'multilingual' },
  { text: 'Je pense à en finir.', kind: 'multilingual' },
  { text: 'Alle wären besser dran ohne mich.', kind: 'multilingual' },
  { text: 'Ich will einfach einschlafen und nicht mehr aufwachen.', kind: 'multilingual' },
  { text: 'Todo mundo ficaria melhor sem mim.', kind: 'multilingual' },
  { text: 'Starebbero tutti meglio senza di me.', kind: 'multilingual' },
  { text: 'Всем будет лучше без меня.', kind: 'multilingual' },
  { text: '没有我大家会更好', kind: 'multilingual' },
];

/**
 * Venture talk with the same words. None of these may take the crisis path or tag safety_wellbeing (other
 * categories, e.g. `legal` for a contract, are fine and not asserted here).
 */
const HARD_NEGATIVES: readonly string[] = [
  // "ending it" with a venture referent.
  "I'm thinking about ending it with the vendor.",
  "We're ending the pilot next month.",
  "We're thinking about ending it with the agency and bringing design in-house.",
  "I'm ending it with our current supplier, their lead times are terrible.",
  "The pilot isn't converting. I'm thinking about ending it.",
  'Should I end it early with the school district or wait for the renewal?',
  "I'm thinking about ending it and pivoting to B2B.",
  "If the beta fails I'm ending it, no second chances.",
  'We should just end it and refund the beta users.',
  'Ending it now would waste six months of customer interviews.',
  "Our trial is going nowhere, honestly I'm thinking about ending it and getting a job.",
  // "disappear" with a bounded or purposeful continuation.
  'I want to disappear from social media for a week to focus.',
  'I want to disappear for a few days and just ship the MVP.',
  'Honestly I want to disappear into the lab until the prototype works.',
  "I'm tempted to just disappear from LinkedIn until launch.",
  'I want to vanish from the group chat until the deck is done.',
  'Our app helps people disappear from data broker lists.',
  'Quiero desaparecer de las redes sociales por una semana para concentrarme.',
  'Je veux disparaître des réseaux sociaux pour me concentrer.',
  // "I can't do this anymore" about the work.
  "I can't do this anymore, the spreadsheet is a mess.",
  "I can't do this anymore with this vendor, they missed three deadlines.",
  "I can't take it anymore, our CI is so flaky.",
  "Can't do this anymore — the vendor portal logs me out every five minutes.",
  "Ugh, I can't handle this anymore, the investor update is due tomorrow and the numbers don't add up.",
  // "what's the point" about the work.
  "What's the point of any of this if customers won't pay?",
  "What's the point of this meeting?",
  "Our churn is brutal, what's the point of any of this if users leave after a week?",
  // "better off without me" about a role.
  'Everyone would be better off without me on the sales calls; my cofounder closes better.',
  'The team would be better off without me micromanaging every PR.',
  'Honestly the company would be better off without me as CEO.',
  // Not being around / here, goodbye, wanting out, wanting it to stop.
  "I won't be around much longer today, can we wrap up the pricing review?",
  "I won't be around much longer on this call, I have class at 3.",
  "I don't want to be here when the investors arrive, can you cover?",
  "I don't want to be here for the 7am standup tomorrow.",
  "This is goodbye to our B2C product; we're going all in on schools.",
  'I just want out of the co-working lease, it is too expensive.',
  'I want this launch to be over so I can sleep.',
  'I want the notifications to stop.',
  'Our users want the onboarding pain to end.',
  // Hyperbole and other uses of the same words.
  "I've lost the will to live after three hours in this spreadsheet lol",
  'We mapped 100 kms of delivery routes this week.',
  "I'm done with the deck, can you review it?",
  "I give up on the B2C version, let's go B2B.",
  'Nobody would notice if we dropped the dark mode feature.',
  "I'm going to jump off the call early, I have a lecture.",
  'I took all my notes from the customer calls.',
  'Sometimes I wish I could sleep for a week after demo day.',
  "I'm ending the trial for users who never logged in.",
  'Vamos a terminar el piloto con la escuela.',
  // Found by probing the rules themselves (each was flagged by an earlier draft).
  'Say goodbye forever to manual spreadsheets!',
  'Users can self-delete their accounts in settings.',
  'I want to top myself up with coffee first.',
  "I'm done with life admin for today.",
  "We'd be better off if I wasn't here for the board meeting.",
  "I'd like to sleep and not wake up until Monday.",
  'I wish I could just die of embarrassment.',
  'I want to unalive this bug.',
  'The company would be better off if I was gone.',
  'I just want it all to end, this launch week has been brutal.',
  "I'm moving to Berlin. I won't be around much longer.",
  "I can't keep going like this, we need a second engineer.",
  "Is there any point to anything we've built?",
  "There's no reason to go on with the pilot.",
  "Life isn't worth it without coffee.",
];

/** Ambiguous lines with neither distress nor venture context: a wellbeing signal, not the crisis path. */
const AMBIGUOUS_ALONE: readonly string[] = [
  "I can't do this anymore.",
  'i cant take it anymore',
  "Honestly, I can't handle this anymore.",
  'I feel like I cannot cope with this anymore',
  'I just want to disappear for a while.',
  'I just want it to stop.',
];

describe('indirect suicidal ideation — positives', () => {
  it('covers at least 40 positives across direct, indirect, slang, typo, lowercase, multilingual and context', () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(40);
    const kinds = new Set(POSITIVES.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(
      ['context', 'direct', 'indirect', 'lowercase', 'multilingual', 'slang', 'typo'].sort(),
    );
  });

  it.each(POSITIVES.map((p) => [p.text, p] as const))('%s → crisis', (_label, p) => {
    const result = classifyRisk(p.text);
    expect(result.crisis, `rules fired: ${result.matchedRules.join(', ')}`).toBe(true);
    expect(result.categories).toContain('safety_wellbeing');
    expect(riskLabel(result)).toBe('crisis');
  });
});

describe('indirect suicidal ideation — hard negatives (venture talk with the same words)', () => {
  it('covers at least 40 hard negatives', () => {
    expect(HARD_NEGATIVES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(HARD_NEGATIVES.map((text) => [text] as const))('%s → not flagged', (text) => {
    const result = classifyRisk(text);
    expect(result.crisis, `rules fired: ${result.matchedRules.join(', ')}`).toBe(false);
    expect(result.categories, `rules fired: ${result.matchedRules.join(', ')}`).not.toContain(
      'safety_wellbeing',
    );
  });
});

describe('indirect suicidal ideation — the decision rule for ambiguous lines', () => {
  it.each(AMBIGUOUS_ALONE.map((text) => [text] as const))(
    '%s alone → a wellbeing signal, not the crisis path',
    (text) => {
      const result = classifyRisk(text);
      expect(result.crisis, `rules fired: ${result.matchedRules.join(', ')}`).toBe(false);
      expect(result.categories).toEqual(['safety_wellbeing']);
    },
  );

  it('the same line is crisis with personal distress, clean with venture work, and distress beats work', () => {
    const line = "I can't do this anymore.";
    expect(classifyRisk(`I feel so alone. ${line}`).crisis).toBe(true);
    expect(classifyRisk(`${line} The pitch deck is due Friday.`).categories).toEqual([]);
    expect(classifyRisk(`${line} The pitch deck is due Friday and I can't stop crying.`).crisis).toBe(true);

    const ending = "I'm thinking about ending it.";
    expect(classifyRisk(ending).crisis).toBe(true);
    expect(classifyRisk(`Our pilot keeps slipping. ${ending}`).crisis).toBe(false);
    expect(classifyRisk(`The startup failed and I let everyone down. ${ending}`).crisis).toBe(true);

    const away = 'I just want to disappear for a while.';
    expect(classifyRisk(`Nobody cares anyway. ${away}`).crisis).toBe(true);
    expect(classifyRisk(`${away} Then I will rewrite the landing page.`).categories).toEqual([]);
  });

  it('a line is never its own context', () => {
    // "cannot cope" is distress language, but the overwhelm line containing it needs a second, separate cue.
    expect(classifyRisk("I can't cope with this anymore.").crisis).toBe(false);
    expect(classifyRisk("I can't cope with this anymore. I can't stop crying.").crisis).toBe(true);
    expect(classifyRisk("I can't cope. I can't do this anymore.").crisis).toBe(true);
  });

  it('an object after "ending it" is the referent, unless the object is a means', () => {
    expect(classifyRisk("I'm thinking about ending it with my cofounder.").crisis).toBe(false);
    expect(classifyRisk("I'm thinking about ending it with pills.").crisis).toBe(true);
  });
});

describe('indirect suicidal ideation — bounded and linear', () => {
  it('stays linear on 20,000 characters of the indirect-ideation fragments', () => {
    // Timing ratios (not absolute times): eight times the text takes about eight times as long, not sixty-four.
    // Summed over every fragment so the fixed allowance is small next to one rule turning quadratic.
    const fragments = [
      "i'm thinking about ",
      'ending it ',
      "i'm thinking about ending it with the vendor ",
      "i can't do this anymore ",
      "i can't do this anymore, the spreadsheet ",
      'better off without me ',
      'better off if i ',
      'i want to disappear from ',
      "what's the point of any of this ",
      'nobody would care if ',
      'i wish i could go to sleep and ',
      'i just want ',
      "i won't be around much longer ",
      'i i i i ',
      'kms ',
      'pilot startup customer ',
      // Long words after a first-person subject: the bounded word gaps must not rescan them quadratically.
      `i ${'x'.repeat(60)} `,
      "i'm so so so so so so ",
      'nobody would even ',
      'i feel like i feel like ',
      'want to disappear and want to disappear ',
      // Every hit covered by an exclusion: the coverage check must not compare every hit with every exclusion.
      'i want to disappear from social media for a week to focus. ',
      'our software licenses ',
    ];
    const endings = ['', ' I want to end it all.'];
    const time = (chars: number): number => {
      let total = 0;
      for (const fragment of fragments) {
        for (const ending of endings) {
          const text = fragment.repeat(Math.ceil(chars / fragment.length)).slice(0, chars) + ending;
          const started = performance.now();
          classifyRisk(text);
          total += performance.now() - started;
        }
      }
      return total;
    };
    // Interleaved, best of three: a burst of load on a shared runner slows one sample, not one size.
    time(2_500);
    let small = Infinity;
    let large = Infinity;
    for (let round = 0; round < 3; round += 1) {
      small = Math.min(small, time(2_500));
      large = Math.min(large, time(19_900));
    }
    expect(large).toBeLessThan(16 * small + 100);
  }, 120_000);
});
