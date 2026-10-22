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
 *  1. a personal-distress cue anywhere in the message (a feeling about the speaker, never a business state) →
 *     crisis;
 *  2. otherwise a referent next to the line → not flagged: work in its own sentence, the two before it or the one
 *     after it; a closing for "I'll end it now" / "this is goodbye"; everyday life or laughter for the non-crisis
 *     lines;
 *  3. a personal cue anywhere (the work is said not to be the referent, help-seeking, secrecy, a personal setback)
 *     lifts every veto of rule 2;
 *  4. otherwise → crisis for "ending it" style lines, a non-crisis wellbeing signal for "I can't do this anymore"
 *     style lines and for a farewell with a final thanks.
 * Rows marked "review" were found by an adversarial review of the first version of this rule.
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
  { text: "I'm going to end it now.", kind: 'indirect' },
  { text: "I'm going to end it now. Thank you for everything.", kind: 'indirect' },
  { text: "I'm thinking about ending it. Thanks for listening.", kind: 'indirect' },
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
  // review: "better off without me" followed by anything but a role.
  { text: 'Everyone would be better off without me at this point.', kind: 'indirect' },
  { text: 'Everyone would be better off without me 😔', kind: 'indirect' },
  { text: 'everyone would be better off without me lol', kind: 'lowercase' },
  { text: "they'd all be better off without me being around", kind: 'lowercase' },
  { text: 'my family would be better off without me if im honest', kind: 'typo' },
  { text: 'my kids would be better off without me as their dad', kind: 'lowercase' },
  { text: 'everyone would be better off without me in the picture', kind: 'lowercase' },
  {
    text: 'Everyone would be better off without me at this point, especially my cofounder.',
    kind: 'context',
  },
  { text: 'Everyone would be better off without me on this earth.', kind: 'indirect' },
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
  // review: feelings the first version missed.
  { text: "I just feel like a failure. I can't do this anymore.", kind: 'context' },
  { text: "I feel like such a failure. I can't do this anymore.", kind: 'context' },
  { text: "My parents hate me. I can't do this anymore.", kind: 'context' },
  // review: work words elsewhere in the message, lifted by a personal cue or too far away to be the referent.
  { text: "Sorry this isn't about the startup. I'm thinking about ending it.", kind: 'context' },
  { text: "I'm thinking about ending it tonight. My cofounder doesn't know.", kind: 'context' },
  { text: "I failed my exams. I'm thinking about ending it.", kind: 'context' },
  {
    text: "I'm thinking about ending it. Can you help me find someone to talk to? Not about the app.",
    kind: 'context',
  },
  { text: "Thinking about ending it. Don't tell the program.", kind: 'context' },
  { text: 'what is the point of any of this, my cofounder quit and I failed my class', kind: 'context' },
  {
    text: "I've been working on the startup for two years. Today my partner left me. I don't know anymore. I'm thinking about ending it.",
    kind: 'context',
  },
  // Sleep and not wake up (C-SSRS item 1).
  { text: 'I wish I could go to sleep and never wake up.', kind: 'indirect' },
  { text: "Sometimes I hope I don't wake up tomorrow.", kind: 'indirect' },
  { text: "I wouldn't mind if I didn't wake up tomorrow.", kind: 'indirect' },
  { text: "I wish I'd never been born.", kind: 'indirect' },
  // review: C-SSRS item 1 and euphemisms the first version missed.
  { text: 'Sometimes I think about not waking up.', kind: 'indirect' },
  { text: "I've been having dark thoughts again.", kind: 'indirect' },
  { text: 'I want to disappear into the void.', kind: 'indirect' },
  // Wanting it to stop, wanting out, not being around (AFSP, QPR).
  { text: 'I just want it all to stop.', kind: 'indirect' },
  { text: 'I want the pain to end.', kind: 'indirect' },
  { text: 'I just want out.', kind: 'indirect' },
  { text: "I won't be around much longer.", kind: 'indirect' },
  { text: "You won't have to worry about me much longer.", kind: 'indirect' },
  { text: "Pretty soon you won't have to worry about me.", kind: 'indirect' },
  { text: 'This is goodbye.', kind: 'indirect' },
  // review: voice transcripts are lowercase and not contracted.
  { text: 'what is the point of any of this', kind: 'lowercase' },
  { text: 'um what is even the point anymore', kind: 'lowercase' },
  // Means (AFSP: looking for a way).
  { text: 'I want to jump off a bridge.', kind: 'direct' },
  { text: "I'm going to take all my pills tonight.", kind: 'direct' },
  { text: 'Been thinking about walking into traffic.', kind: 'direct' },
  { text: "I'm going to jump off the roof of my building", kind: 'direct' },
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
  // review: a session or a program ending ("I'll end it now" is how a call ends).
  "Ok I'll end it now, thanks for the help!",
  "okay I'm going to end it now. Thanks!",
  'yeah so i think i am going to end it now thanks so much',
  "Alright, I'll end it now. Talk soon.",
  "Great chat. I think I'll end it today, talk tomorrow.",
  "So this is goodbye! It's been a great three months.",
  "Let's wrap up this call. I'll end it now.",
  "I'll end it here for today, thanks!",
  "I'm ending it today, the vendor missed three deadlines.",
  // review: business states are not personal distress ("distress beats work" needs a feeling about the speaker).
  "I give up. I can't do this anymore, the spreadsheet is a mess.",
  "Nobody cares about our product. I can't do this anymore.",
  "No one understands our pitch. I can't do this anymore.",
  "Our conversion rate hit rock bottom. I can't do this anymore.",
  "I've lost everything in the database migration. I can't do this anymore.",
  "I'm tired of trying to get meetings with VCs. I can't do this anymore.",
  "Tired of fighting with Stripe. I can't take it anymore.",
  "Nothing makes sense in these numbers, I can't do this anymore",
  "I'm drowning in emails. I can't do this anymore.",
  "Nobody cares about our app. What's the point of any of this?",
  // review: traffic, "be around" a person, a role while away, a medication routine, a committee.
  'Next quarter we are jumping into traffic acquisition.',
  'Should we jump into traffic analytics first?',
  "Before jumping into traffic numbers, let's look at retention.",
  "I don't want to be around my cofounder anymore.",
  "I don't want to be around negative investors.",
  "I don't want to be around people who don't believe in the product.",
  'My team would be fine if I was gone for two weeks.',
  'my team would be fine if I disappeared on vacation',
  'In our study, patients will take a handful of pills each morning.',
  'I should take all my meds before the flight.',
  "We'd be better off if I wasn't in the picture and Sam ran sales.",
  "I'm stepping off the building committee.",
  'He would be better off without me as his cofounder.',
  // review: banter and everyday life around "I can't take it anymore".
  "Ugh I can't take it anymore, my roommate's dog barks all night.",
  "lol I can't deal with this anymore",
  "I can't do this anymore 😂",
  // The referent of "it" is the work two sentences back, or the sentence after.
  "Our pilot with the school district is stalling. They haven't responded in three weeks. I'm thinking about ending it.",
  "I'm thinking about ending it. The pilot just isn't converting.",
  'Can you help me find someone to talk to about our pricing? Our pilot is stuck. I am thinking about ending it.',
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
  "I can't keep going like this.",
  // A farewell with a final thanks may be the end of a program (review): a person checks in, the coach answers.
  'This is goodbye. Thank you for everything.',
  'This is my last message. Thanks for everything!',
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

  it('work is the referent only next to the line: its sentence, the two before it, the one after it', () => {
    const ending = "I'm thinking about ending it.";
    const filler = 'I keep going over it.';
    expect(classifyRisk(`The pilot is stuck. ${ending}`).crisis).toBe(false);
    expect(classifyRisk(`The pilot is stuck. ${filler} ${ending}`).crisis).toBe(false);
    expect(classifyRisk(`${ending} The pilot is stuck.`).crisis).toBe(false);
    expect(classifyRisk(`The pilot is stuck. ${filler} ${filler} ${ending}`).crisis).toBe(true);
    expect(classifyRisk(`${ending} ${filler} The pilot is stuck.`).crisis).toBe(true);
  });

  it('a personal cue lifts the referent veto: not about the work, help-seeking, secrecy, a setback', () => {
    const line = "The pilot is stuck. I'm thinking about ending it.";
    expect(classifyRisk(line).crisis).toBe(false);
    expect(classifyRisk(`This isn't about the startup. ${line}`).crisis).toBe(true);
    expect(classifyRisk(`${line} I need someone to talk to.`).crisis).toBe(true);
    expect(classifyRisk(`${line} Please don't tell anyone.`).crisis).toBe(true);
    expect(classifyRisk(`My wife left me. ${line}`).crisis).toBe(true);
    // A lifted veto on a non-crisis line is the wellbeing signal, not the crisis path.
    const overwhelm = classifyRisk("I failed my finals. I can't do this anymore, the deck is a mess.");
    expect(overwhelm.crisis).toBe(false);
    expect(overwhelm.categories).toEqual(['safety_wellbeing']);
  });

  it('a closing makes "I\'ll end it now" a sign-off; "tonight" and distress never are', () => {
    expect(classifyRisk("I'll end it now, thanks for the help!").categories).toEqual([]);
    expect(classifyRisk("I'll end it now.").crisis).toBe(true);
    expect(classifyRisk("I'll end it tonight. Thanks for the help!").crisis).toBe(true);
    expect(classifyRisk("I feel so alone. I'll end it now, thanks for the help!").crisis).toBe(true);
    expect(classifyRisk("I'll end it now. Thanks for the help! Please don't tell anyone.").crisis).toBe(true);
  });

  it('a farewell: a final thanks is a wellbeing signal, a casual closing a sign-off, distress the crisis path', () => {
    expect(classifyRisk('This is goodbye.').crisis).toBe(true);
    const thanks = classifyRisk('This is goodbye. Thank you for everything.');
    expect(thanks.crisis).toBe(false);
    expect(thanks.categories).toEqual(['safety_wellbeing']);
    expect(classifyRisk("This is goodbye. It's been great, talk soon!").categories).toEqual([]);
    expect(classifyRisk('I feel so alone. This is goodbye. Thank you for everything.').crisis).toBe(true);
  });

  it('"be around" a person is conflict, not the crisis path', () => {
    const result = classifyRisk("I don't want to be around him, he keeps yelling at me in meetings.");
    expect(result.crisis).toBe(false);
    expect(result.categories).toContain('conflict_harassment');
    expect(result.categories).not.toContain('safety_wellbeing');
    expect(classifyRisk("I don't want to be around anymore.").crisis).toBe(true);
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
      // Every hit vetoed by a referent next to it: the window is looked up, never rescanned per hit.
      "i'm thinking about ending it. the pilot. ",
      "i'm thinking about ending it the pilot ",
      "i'll end it now, thanks. this is goodbye. thanks for everything. ",
      "i can't do this anymore lol ",
      'nobody cares about our product. ',
      'better off without me on the sales calls ',
      'i feel like such a such a ',
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
