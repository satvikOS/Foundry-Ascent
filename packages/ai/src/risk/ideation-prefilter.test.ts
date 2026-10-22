import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifyRisk } from './classifier.js';
import { ideationPrefilter, type IdeationFamily } from './ideation-prefilter.js';

/**
 * Phrasings written for this prefilter, not taken from the E-crisis corpus (safety-screen-corpus.test.ts holds that
 * one): the task's own list, voice transcripts (lower case, no apostrophes), typos, slang and acts with the subject
 * dropped. Each must reach the screen unless the deterministic rules already flag it.
 */
const HELD_OUT: readonly string[] = [
  'i think im just gonna end it all',
  'honestly i want to end everything',
  'Im ready to end it',
  'i dont want to be here no more',
  'I do not want to be here anymore',
  'i really dont wanna be alive',
  "I'd rather not be around anymore",
  "i won't be around to see the launch",
  'you guys wont have to deal with me much longer',
  'i want to dissapear',
  'i wish i could just vanish',
  'no point in anything',
  'theres literally no point anymore',
  'whats the point in living like this',
  "everyone's better off without me",
  'my cofounder would be better off without me',
  'i cant do this any more',
  'cant do this anymore honestly',
  "I can't keep doing this",
  'goodbye everyone',
  'goodbye.',
  'i hope i never wake up',
  'id be fine if i never woke up again',
  'sometimes i want to hurt myself',
  'i want to give up on everything',
  'im giving up on life',
  'i keep thinking about taking all my pills',
  'there is no reason for me to be here',
  'i feel like a burden to everyone',
  'nobody would care if i disappeared',
  "I've made up my mind. Tonight.",
  "i don't see a way out of this",
  'i just want to sleep forever',
  'i want to go to sleep and not wake up',
  'i want to stop existing',
  'its all pointless, im pointless',
  'they would all be relieved if i was gone',
  "i'm so tired of everything i just want it to stop",
  'i have been planning how to do it',
  'i wrote a note for my family',
  'i gave away all my stuff',
  'my plan is to drive off the bridge',
  'I keep picturing my funeral',
  'life is meaningless',
  'what am i even living for',
  'um so yeah i think im gonna kms',
  'i w4nt to end 1t all',
  'thinkin bout endin it tbh',
  'Je pense à en finir.',
  'Todos estarían mejor sin mí.',
  'i cant do this anymore my parents hate me',
  'nobody would even care tbh',
  'honestly i wont be around much longer so whatever',
  "it'll all be over soon",
  'i just cant anymore',
  'who would even notice if i was gone',
];

/**
 * Crisis lines the 2026-10-22 differential audit of this prefilter found it letting pass (the rules miss them too):
 * dropped prepositions, preparatory acts, means without a place, texting shorthand and doubled-letter typos.
 */
const AUDIT_MISSES: readonly string[] = [
  'no point going on',
  "i know how i'd do it",
  'i want to endd it all',
  'dont wanna b here anymore',
  'nobdy would miss me',
  'whats the pointt anymore',
  'i cnt do this anymore',
  "i'm thinking of jumping",
  'i want to jump',
  "i'm going to jump",
  'i have the pills ready',
  'i bought pills today',
  'how many pills would it take',
  'i feel like dying',
  'planning my exit',
  'goodnight forever',
  "i've been looking up ways to die",
  'i want to cut again',
  'relapsed and cut last night',
  "i don't wanna do life anymore",
  'i want to be gone',
  "i'd be better off gone",
  "i've written letters to everyone",
  'my affairs are in order',
  'i deleted all my accounts and said my goodbyes',
  'i want to fall asleep and never wake',
  'i just want to rest forever',
  'no reason 2 live',
  'i want to stop living',
  "i don't think i'll make it through the night",
];

/**
 * Ordinary lines that must stay on the common path (no screen call, no latency): words a founder or the vEIR uses
 * every day that share vocabulary with the families.
 */
const ORDINARY: readonly string[] = [
  'Last time we talked about pricing. How did the facilities call go?',
  'Last time you said the dean has the budget.',
  'The specified key does not exist.',
  'We mapped 100 kms of delivery routes this week.',
  'Next quarter we are jumping into traffic acquisition.',
  "I'm stepping off the building committee.",
  'ok thanks, goodbye!',
  'Goodbye for now, talk tomorrow.',
  'What is the point of a landing page before we have a waitlist?',
  "What's the point of this feature?",
  'We want to be here for the launch.',
  'The regulatory burden of proof is on the manufacturer.',
  'Can you help me price the pilot for two libraries?',
  "I'm thinking about ending the pilot with the second library.",
  'We should end the trial early.',
  "Let's wrap up, I have class.",
  'The bug disappeared after the restart.',
  'Shoot me the deck when you can.',
  'Cut me some slack, it was my first pitch.',
  'I am not okay with the vendor terms.',
  "I don't want to be too aggressive on price.",
  "I won't be here tomorrow, can we move the session?",
  'I hope the bug disappears after the patch.',
  'Patients take their medication twice a day.',
  'I walked into the building and pitched the dean.',
  "It's pointless to A/B test with ten users.",
  "I didn't wake up in time for the investor call.",
  'We need it to stop crashing on Android.',
  'The pilot is over soon.',
  'We plan to kill the feature.',
  "I can't do this alone, I need a cofounder.",
  "I can't handle the backend alone.",
  "I'm tired of fighting with Stripe.",
  'Nobody would notice if we changed the logo.',
  'Who would miss the old pricing page?',
  'I want out of this lease.',
  // Wrap-ups and sign-offs (an audit found them sending about one turn per conversation to the screen).
  "ok let's end it there",
  'can we end it here',
  "let's end it for today",
  'Let’s end it here and pick up Thursday.',
  'farewell for now',
  'ok i gotta go, goodbye',
  "i'll let you go, goodbye",
  // Typo folding reads words back, never into a family: "will", "good", "feel", "meeting", "too", "off".
  'We will need good feedback from the meeting too, then we are off.',
  'Plan b is a two-week pilot.',
];

function familiesOf(text: string): readonly IdeationFamily[] {
  return ideationPrefilter(text).families;
}

describe('ideationPrefilter', () => {
  it('flags every held-out phrasing the deterministic rules do not already catch', () => {
    const missed = HELD_OUT.filter((t) => !classifyRisk(t).crisis && !ideationPrefilter(t).hit);
    expect(missed).toEqual([]);
  });

  it("flags the audit's missed crisis lines: shorthand, typos, acts and means", () => {
    expect(AUDIT_MISSES.filter((t) => classifyRisk(t).crisis)).toEqual([]);
    expect(AUDIT_MISSES.filter((t) => !ideationPrefilter(t).hit)).toEqual([]);
  });

  it('exempts only a first-person-plural wrap-up from the ending family', () => {
    expect(ideationPrefilter("ok let's end it there").hit).toBe(false);
    expect(familiesOf("let's end it all")).toEqual(['ending']);
    expect(familiesOf("ok let's end it there. honestly i want to end it all")).toEqual(['ending']);
    expect(familiesOf("i'll end it here tonight")).toEqual(['ending']);
    expect(familiesOf('i want to end it now')).toEqual(['ending']);
  });

  it('leaves ordinary lines on the common path', () => {
    expect(ORDINARY.filter((t) => ideationPrefilter(t).hit)).toEqual([]);
  });

  it('names the families that matched, never text', () => {
    expect(familiesOf("I'm thinking about ending it.")).toEqual(['ending']);
    expect(familiesOf('Everyone would be better off if I was gone. This is goodbye.')).toEqual([
      'presence',
      'burden',
      'farewell',
    ]);
    expect(familiesOf('i took a bottle of pills')).toEqual(['means']);
    expect(familiesOf('i wanna unalive myself')).toEqual(['self_harm']);
    expect(ideationPrefilter('Can we price the pilot?')).toEqual({ hit: false, families: [] });
    expect(ideationPrefilter('   ')).toEqual({ hit: false, families: [] });
  });

  it('reads leetspeak, curly apostrophes, full-width letters and accents', () => {
    expect(ideationPrefilter('i w4nt to end 1t all').hit).toBe(true);
    expect(ideationPrefilter('I don’t want to be here anymore').hit).toBe(true);
    expect(ideationPrefilter('ｉ ｊｕｓｔ ｗａｎｔ ｏｕｔ').hit).toBe(true);
    expect(ideationPrefilter('Je pense à en finir.').hit).toBe(true);
  });

  it('treats a plain goodbye with an ordinary sign-off as a wrap-up, but not a final one', () => {
    expect(ideationPrefilter('thanks so much, goodbye!').hit).toBe(false);
    expect(ideationPrefilter('Goodbye, see you next week.').hit).toBe(false);
    expect(ideationPrefilter('goodbye').hit).toBe(true);
    expect(ideationPrefilter('This is goodbye. Thank you for everything.').hit).toBe(true);
    expect(ideationPrefilter('I hate who I am. goodbye forever').hit).toBe(true);
  });

  it('finds a phrase at the end of a long message', () => {
    const filler = 'We asked around and some people said four pounds is fine for the pilot. '.repeat(80);
    expect(ideationPrefilter(`${filler}Anyway. I don't sleep. I'm thinking about ending it.`).hit).toBe(true);
    expect(ideationPrefilter(filler).hit).toBe(false);
  });

  it("stays off the common path on the lab's conversations", () => {
    const smoke = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../ops/lab/scenarios/smoke.json', import.meta.url)),
        'utf8',
      ),
    ) as { scenarios: { turns: { say?: string; fallback?: string }[] }[] };
    const lines = smoke.scenarios.flatMap((s) =>
      s.turns.flatMap((t) => [t.say, t.fallback].filter((x): x is string => typeof x === 'string')),
    );
    expect(lines.length).toBeGreaterThan(50);
    // Its one crisis line is the deterministic rules' to answer; the screen never sees it.
    expect(lines.filter((t) => !classifyRisk(t).crisis && ideationPrefilter(t).hit)).toEqual([]);
  });
});
