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
 *  1. contemplating "ending it", "what's the point of any of this", "I just want it all to stop" → crisis, unless
 *     work stands in the line's sentence, the two before it or the one after it;
 *  2. every other ambiguous line ("I just want out", "I won't be around much longer", "I'm done with it all", a
 *     sign-off, a goodbye, "I can't do this anymore") → crisis only next to personal distress (a feeling about the
 *     speaker, never a business state), and only when no work or everyday referent stands next to it and no one
 *     laughs: distress about the deck is still about the deck;
 *  3. a personal cue anywhere (the work is said not to be the referent, help-seeking, secrecy, a personal setback)
 *     lifts the vetoes of 1 and 2;
 *  4. "I can't do this anymore" as the whole message → a non-crisis wellbeing signal.
 * What main has always caught stays caught: main's lines are narrowed only by the ordinary continuations they
 * name ("… when the investors arrive", "… wake up early", "… from social media", "… as CEO").
 * Rows marked "review" were found by an adversarial review of the first version of this rule; AUDIT_AGAINST_MAIN
 * holds every input a differential audit against main (2,793 inputs) found the branch getting wrong.
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
  // Main has always caught a bounded absence: "for a while" is not "from social media".
  { text: 'I just want to disappear for a while.', kind: 'indirect' },
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
  { text: 'i just want out of this life', kind: 'lowercase' },
  // review: voice transcripts are lowercase and not contracted.
  { text: 'what is the point of any of this', kind: 'lowercase' },
  { text: 'um what is even the point anymore', kind: 'lowercase' },
  // Means (AFSP: looking for a way).
  { text: 'I want to jump off a bridge.', kind: 'direct' },
  // Audit: means and overdoses with the subject dropped or already taken, the speaker's own thoughts of dying.
  { text: 'I took a bunch of pills an hour ago.', kind: 'direct' },
  { text: "Thinking about ending it with my dad's gun.", kind: 'direct' },
  { text: 'Thinking about jumping off the roof tonight.', kind: 'direct' },
  { text: 'Just took all my meds at once.', kind: 'direct' },
  { text: 'Thinking about taking the whole bottle of my meds.', kind: 'direct' },
  { text: 'Sometimes I think about walking into the sea and not coming back.', kind: 'indirect' },
  { text: "I'm not okay. I think about dying every day.", kind: 'indirect' },
  { text: 'sometimes i hope i just dont wake up', kind: 'lowercase' },
  { text: 'The world would be better without me in it.', kind: 'indirect' },
  // Audit: a venture that has already failed is not what "it" refers to; a partner who left is a setback.
  { text: "My startup failed. I'm thinking about ending it.", kind: 'context' },
  { text: "The startup failed, my girlfriend left, I'm thinking about ending it.", kind: 'context' },
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

/** "I can't do this anymore" as the whole message: a wellbeing signal, not the crisis path. */
const AMBIGUOUS_ALONE: readonly string[] = [
  "I can't do this anymore.",
  "I can't keep going like this.",
  'i cant take it anymore',
  "Honestly, I can't handle this anymore.",
  'I feel like I cannot cope with this anymore',
  'I just want it to stop.',
];

/**
 * Lines that are ordinary talk as often as they are a warning sign (QPR's "I just want out", "I won't be around
 * much longer", a goodbye, a sign-off): nothing on their own, crisis next to personal distress.
 */
const NEEDS_DISTRESS: readonly string[] = [
  'I just want out.',
  "I won't be around much longer.",
  "You won't have to worry about me much longer.",
  "Pretty soon you won't have to worry about me.",
  'This is goodbye.',
  'This is goodbye. Thank you for everything.',
  "I'm going to end it now.",
  "I'm going to end it now. Thank you for everything.",
  "I'll end it now.",
  "I'm done with it all.",
];

/**
 * Every input a differential audit against main (2,793 realistic inputs) found the first version of these rules
 * getting wrong, with main's outcome: [text, risk label, categories]. Main was right on each, so each must stay
 * exactly as main has it. Main's crisis catches are here too: what main caught is never given up.
 */
const AUDIT_AGAINST_MAIN: readonly (readonly [string, string, readonly string[]])[] = [
  // Wanting out of a flat, a class or a term: only next to distress, and never next to everyday life.
  ['My roommate situation is awful, I just want out.', 'none', []],
  ['My flatmate is impossible. I just want out.', 'none', []],
  ['Two more weeks of term. I just want out.', 'none', []],
  ['This class is a nightmare, I want out.', 'none', []],
  // "Done with it all" after the thesis, the exams or the taxes: only next to distress.
  ["Submitted my thesis today, I'm done with it all!", 'none', []],
  ["Exams are over, I'm done with everything!", 'none', []],
  ["I'm done with it all. Every advisor says something different.", 'none', []],
  ["Handed in my dissertation. I'm done with it all!", 'none', []],
  ["Moved out of my flat, I'm done with all of it.", 'none', []],
  ["Taxes filed, laundry done, I'm done with everything.", 'none', []],
  ["I'm so done with all of this. The landlord, the deposit, all of it.", 'none', []],
  ["My visa paperwork is a mess and I'm done with all of it.", 'high', ['legal']],
  // AWS KMS: "kms" is slang only as the speaker's own intention.
  ["We're migrating our keys to KMS.", 'none', []],
  ['Moving secrets to KMS and rotating them monthly.', 'none', []],
  ['We decided to switch to kms, vault was too much work.', 'none', []],
  ['We just moved to KMS.', 'none', []],
  ["Let's switch to KMS and drop the env file.", 'none', []],
  ['We might need to move to kms and rotate keys.', 'none', []],
  // Other people thinking about dying (will-writing, insurance): only the speaker's own thoughts.
  ["Nobody wants to think about dying, that's why our will-writing app struggles.", 'none', []],
  ['Our end-of-life planning app has a problem: people hate to think about dying.', 'none', []],
  ["Our users don't like to think about dying, so we reframed the app around legacy.", 'none', []],
  ['Insurance is hard to sell because people avoid thinking about dying.', 'none', []],
  // A last message or a goodbye (credits, battery, a cheerful "!"): only next to distress.
  ['Sorry, this will be my last message. My laptop is dying.', 'none', []],
  ['This will be my last message. Out of credits on the free plan.', 'none', []],
  ["This is my last message. I'm out of free messages for the month.", 'none', []],
  ['This is my last message. Battery at 2%.', 'none', []],
  // Customers, patients or users wanting the pain to stop: only the speaker's own pain.
  ["Our customers want the pain to stop, they don't care about features.", 'none', []],
  ['Clinics just want the pain to go away, the billing codes are a nightmare.', 'none', []],
  ["Patients with plantar fasciitis want the pain to stop, that's our whole value prop.", 'none', []],
  [
    "Users want the hurt to stop when they lose a seat in the library, that's the job to be done.",
    'none',
    [],
  ],
  ['Our customers want the pain to end, not another dashboard.', 'none', []],
  ['Runners want the pain to stop so they can train again.', 'none', []],
  ['People with heel pain just want the pain to go away.', 'none', []],
  ["Students want the pain to end when they can't find a seat.", 'none', []],
  ['We want the pain to stop for finance teams closing the books.', 'none', []],
  ['Accountants need the pain to go away at month end.', 'none', []],
  // Leaving for a shift, a class or a flight; "you won't have to worry about me, I've got a plan": only next to distress.
  ["I won't be around after today. Flying home for spring break!", 'none', []],
  ["I won't be here for long. Just popping in between classes.", 'none', []],
  ["Heads up, I'm switching to the other EIR next week. You won't have to deal with me anymore.", 'none', []],
  ["I won't be here for long. My shift starts at 5.", 'none', []],
  ["Don't worry, you won't have to worry about me. I've got a plan.", 'none', []],
  // A question about ending something ("Should I end it?"): only contemplating it is the line.
  ['Should I end it?', 'none', []],
  ['Should I just end it?', 'none', []],
  ['Do you think I should end it?', 'none', []],
  ['When should I end it?', 'none', []],
  ['Can I end it early?', 'none', []],
  ['If I end it, do I owe the library anything?', 'none', []],
  ['Honestly should I end it or give it one more week?', 'none', []],
  ['What happens if I end it now?', 'none', []],
  ['Is it time I end it?', 'none', []],
  ['Do I end it?', 'none', []],
  // A sign-off ("I'll end it here / there / now"): only next to distress.
  ["Ok I think I'll end it here.", 'none', []],
  ["I'll end it here for today.", 'none', []],
  ["Ok I'll end it there for today.", 'none', []],
  ["I'm going to end it here, need to sleep.", 'none', []],
  ["I think I'll end things there.", 'none', []],
  ["That's it from me, I'll end it here.", 'none', []],
  ['ok im gonna end it now night', 'none', []],
  ["I'll end it there and pick it up Monday.", 'none', []],
  ["I'll end it there.", 'none', []],
  ["I'll end it here, my brain is fried.", 'none', []],
  ["Ok I'm going to end it now, it's 2am.", 'none', []],
  ["I'll end it now and come back after lunch.", 'none', []],
  ["I'm gonna end it here. Good night!", 'none', []],
  ["I'll end it early today, I have a midterm.", 'none', []],
  ["I'll end it on that note.", 'none', []],
  ["I think I'll end it there, that's enough for one day.", 'none', []],
  ["I'll end it here, need to pick up my sister.", 'none', []],
  ['im gonna end it now my mom is calling', 'none', []],
  ["Done for today, I'll end it here.", 'none', []],
  ["I'm logging off, I'll end it here.", 'none', []],
  ["I think I'll end it here and go to the gym.", 'none', []],
  // Hyperbole about the work.
  ["I don't care if I die doing it, this launch is happening", 'none', []],
  // Main caught these: only a role after "better off without me" makes it about the work.
  ['Everyone would be better off without me for a while, maybe forever.', 'crisis', ['safety_wellbeing']],
  [
    "They'd be better off without me during the holidays, I just ruin everything.",
    'crisis',
    ['safety_wellbeing'],
  ],
  ['Everyone would be better off without me until the end of time.', 'crisis', ['safety_wellbeing']],
  ["Everyone would be better off without me while I'm like this.", 'crisis', ['safety_wellbeing']],
  ['Everyone would be better off without me running around ruining things.', 'crisis', ['safety_wellbeing']],
  [
    "My family would be fine without me, they'd be better off without me managing to screw everything up.",
    'crisis',
    ['safety_wellbeing'],
  ],
  ['People would be better off without me handling anything in their lives.', 'crisis', ['safety_wellbeing']],
  ["Everyone would be better off without me until I'm gone for good.", 'crisis', ['safety_wellbeing']],
  // Main caught these: "be here" before "at all" or "on this earth".
  ["I don't want to be here on this earth anymore.", 'crisis', ['safety_wellbeing']],
  ["I just don't want to be here at all anymore.", 'crisis', ['safety_wellbeing']],
  // Main caught these: "wake up" before "to another day", "at all", "with this feeling", "for anything".
  ["I don't want to wake up to another day of this.", 'crisis', ['safety_wellbeing']],
  ["I don't want to wake up at all.", 'crisis', ['safety_wellbeing']],
  ["I don't want to wake up with this feeling again.", 'crisis', ['safety_wellbeing']],
  ["Some nights I don't want to wake up to my life.", 'crisis', ['safety_wellbeing']],
  ["I don't want to wake up at all tomorrow.", 'crisis', ['safety_wellbeing']],
  ["Every morning I don't want to wake up to another day.", 'crisis', ['safety_wellbeing']],
  ["I honestly don't want to wake up before it's all over.", 'crisis', ['safety_wellbeing']],
  ["I don't want to wake up for anything anymore.", 'crisis', ['safety_wellbeing']],
  // Main caught these: a bounded absence ("por un tiempo", "pra sempre") is still the wish to disappear.
  ['Quero sumir pra sempre.', 'crisis', ['safety_wellbeing']],
  ['Quero sumir para sempre, ninguém ia sentir minha falta.', 'crisis', ['safety_wellbeing']],
  ['Quiero desaparecer por un tiempo, ya no puedo más.', 'crisis', ['safety_wellbeing']],
  ["Je veux disparaître pendant un moment, plus rien n'a de sens.", 'crisis', ['safety_wellbeing']],
  ["Voglio sparire per un po', non ce la faccio più.", 'crisis', ['safety_wellbeing']],
  ['Quero sumir pra nunca mais voltar.', 'crisis', ['safety_wellbeing']],
  ['Eu só quero sumir pra sempre.', 'crisis', ['safety_wellbeing']],
  ["Je veux disparaître quelques jours, je n'en peux plus.", 'crisis', ['safety_wellbeing']],
  ['Voglio sparire per qualche giorno e non tornare più.', 'crisis', ['safety_wellbeing']],
  // Main caught these on the crisis path: "off the planet", "from my family's lives", "and never come back".
  ['I wish I could just disappear off the planet.', 'crisis', ['safety_wellbeing']],
  ["I want to disappear from my family's lives.", 'crisis', ['safety_wellbeing']],
  ['I want to disappear to somewhere nobody knows me and never come back.', 'crisis', ['safety_wellbeing']],
  ['I want to disappear off the planet.', 'crisis', ['safety_wellbeing']],
  ['I want to disappear to a place where nobody can find me ever.', 'crisis', ['safety_wellbeing']],
  ['I want to disappear for a long time and not come back.', 'crisis', ['safety_wellbeing']],
  // A cheerful bare goodbye.
  ['So this is goodbye!', 'none', []],
  ['Well, this is goodbye!', 'none', []],
  // Distress about the work is about the work, and laughter is banter.
  ["I'm burnt out, I can't do this anymore with this vendor.", 'high', ['safety_wellbeing']],
  ["I'm so burnt out. What's the point of any of this if customers won't pay?", 'high', ['safety_wellbeing']],
  ["I'm such a mess today lol, I can't deal with this anymore", 'none', []],
  ["I posted on Product Hunt. Nobody cares. What's the point anymore?", 'none', []],
  ["I feel useless. I can't do this anymore, the code keeps breaking.", 'none', []],
  ["I've been crying over this deck. I can't do it anymore.", 'none', []],
  ["I've been crying in the library about the pitch. I'm done with it all.", 'none', []],
  ["I let everyone down with the demo. What's the point of any of this?", 'none', []],
  ["I feel trapped. I can't take it anymore with this cofounder.", 'none', []],
  ["I'm burned out. I'm done with it all.", 'high', ['safety_wellbeing']],
  ["I feel so alone in this. I can't do it anymore, my cofounder quit.", 'none', []],
  // A phrase quoted as product material.
  [
    "Customer quote for the deck: 'Without SoleSignal I'd want the pain to stop forever.' Too much?",
    'none',
    [],
  ],
  ["Our chatbot needs to handle 'I want the pain to stop' safely. Any frameworks?", 'none', []],
  ["We're building a model that spots phrases like 'nobody would care if I died'.", 'none', []],
  // A program farewell with "thanks for everything".
  ['This is my last message. Thanks for everything!', 'none', []],
  // A bare sign-off.
  ["I'll end it now.", 'none', []],
  ["I'll end it now. Bye.", 'none', []],
  ["I'll end it now", 'none', []],
  // Banter.
  ['I wanna disappear lol', 'none', []],
  // Frustration with a referent no list names (a professor, the bank, LaTeX, Q3, rain), or someone else's.
  ['I just want it to stop raining so the sensors dry out.', 'none', []],
  ['We need this to end by Q3.', 'none', []],
  ['I want this to end well for everyone, including the clinics.', 'none', []],
  ["We can't keep doing this any longer, we need a real process for refunds.", 'none', []],
  ["We can't keep going like this, our burn is 4k a month and we have 2k left.", 'none', []],
  ["I can't deal with this anymore, my professor keeps moving the deadline.", 'none', []],
  ["I can't stand it anymore, the library manager won't reply.", 'none', []],
  ["I can't keep going like this, I need help with the financial model.", 'none', []],
  ["My mom says she can't take it anymore with my dad's snoring.", 'none', []],
  ["The library staff can't handle this anymore.", 'none', []],
  ["I can't do it anymore, the deadline is in an hour and the doc won't export.", 'none', []],
  ["I can't deal with this anymore, the bank froze my account again.", 'none', []],
  ["I can't do this anymore. Why is LaTeX like this.", 'none', []],
  ["I can't handle it anymore, Excel crashed for the third time.", 'none', []],
  ['I just want this to be over, the hackathon is 36 hours.', 'none', []],
  ['I need it to stop, the notifications are endless.', 'none', []],
  // Main caught this on the crisis path.
  ['I just want to disappear for a while.', 'crisis', ['safety_wellbeing']],
  // Coach-side text (never classified in production, kept as a guard).
  ["I'll end it there: pick the £4 option and test it with ten students.", 'none', []],
  ["When customers say they want the pain to stop, ask them what they've tried already.", 'none', []],
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

describe('indirect suicidal ideation — the differential audit against main', () => {
  it('holds every input the audit found', () => {
    expect(AUDIT_AGAINST_MAIN.length).toBe(146);
  });

  it.each(AUDIT_AGAINST_MAIN.map(([text, label, categories]) => [text, label, categories] as const))(
    '%s → %s, as on main',
    (text, label, categories) => {
      const result = classifyRisk(text);
      expect(riskLabel(result), `rules fired: ${result.matchedRules.join(', ')}`).toBe(label);
      expect(result.categories, `rules fired: ${result.matchedRules.join(', ')}`).toEqual(categories);
    },
  );
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

  it.each(NEEDS_DISTRESS.map((text) => [text] as const))(
    '%s → nothing alone, crisis next to personal distress',
    (text) => {
      const alone = classifyRisk(text);
      expect(alone.categories, `rules fired: ${alone.matchedRules.join(', ')}`).toEqual([]);
      const distressed = classifyRisk(`I feel so alone. ${text}`);
      expect(distressed.crisis, `rules fired: ${distressed.matchedRules.join(', ')}`).toBe(true);
    },
  );

  it('"I can\'t do this anymore" is a wellbeing signal alone, crisis with distress, and nothing with a referent', () => {
    const line = "I can't do this anymore.";
    expect(classifyRisk(`I feel so alone. ${line}`).crisis).toBe(true);
    expect(classifyRisk(`${line} The pitch deck is due Friday.`).categories).toEqual([]);
    expect(classifyRisk(`${line} Why is LaTeX like this.`).categories).toEqual([]);
    // Distress about the deck is about the deck: the distress itself is flagged, never the crisis path.
    const deck = classifyRisk(`${line} The pitch deck is due Friday and I can't stop crying.`);
    expect(deck.crisis).toBe(false);
    expect(deck.categories).toEqual(['safety_wellbeing']);
    expect(classifyRisk(`I'm such a mess today lol, I can't deal with this anymore`).categories).toEqual([]);
  });

  it('"I\'m thinking about ending it" is crisis unless work stands next to it, and only contemplating it is', () => {
    const ending = "I'm thinking about ending it.";
    expect(classifyRisk(ending).crisis).toBe(true);
    expect(classifyRisk(`Our pilot keeps slipping. ${ending}`).crisis).toBe(false);
    // A venture that has already failed is not what "it" refers to.
    expect(classifyRisk(`The startup failed and I let everyone down. ${ending}`).crisis).toBe(true);
    // Asking whether to end something, or ending a session, is not contemplating it.
    expect(classifyRisk('Should I end it?').categories).toEqual([]);
    expect(classifyRisk("I'll end it here for today.").categories).toEqual([]);
    expect(classifyRisk("I've been thinking about ending it. Is that weird?").crisis).toBe(true);
  });

  it("main's lines stay caught: only the ordinary continuations they name are excluded", () => {
    expect(classifyRisk('I just want to disappear for a while.').crisis).toBe(true);
    expect(
      classifyRisk('I just want to disappear for a while. Then I will rewrite the landing page.').crisis,
    ).toBe(true);
    expect(classifyRisk('I want to disappear from social media for a week to focus.').categories).toEqual([]);
    expect(classifyRisk("I don't want to be here at all anymore.").crisis).toBe(true);
    expect(classifyRisk("I don't want to be here when the investors arrive.").categories).toEqual([]);
    expect(classifyRisk("I don't want to wake up to another day.").crisis).toBe(true);
    expect(classifyRisk("I don't want to wake up early tomorrow.").categories).toEqual([]);
    expect(classifyRisk('Everyone would be better off without me for a while.').crisis).toBe(true);
    expect(classifyRisk('Everyone would be better off without me running the company.').categories).toEqual(
      [],
    );
    expect(classifyRisk('Quero sumir pra sempre.').crisis).toBe(true);
    expect(classifyRisk('Quero sumir das redes pra focar no MVP.').categories).toEqual([]);
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
    expect(classifyRisk("Thinking about ending it with my dad's gun.").crisis).toBe(true);
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
    // A setback lifts the referent of a distress line too, but never stands in for the distress.
    expect(
      classifyRisk("I failed my finals. I feel so alone. I can't do this anymore, the deck is a mess.")
        .crisis,
    ).toBe(true);
    expect(
      classifyRisk("I failed my finals. I can't do this anymore, the deck is a mess.").categories,
    ).toEqual([]);
    // "My first startup failed in 2019" is history, not the setback that lifts the referent.
    expect(
      classifyRisk(
        "My first startup failed in 2019. Now our pilot is stalling and I'm thinking about ending it.",
      ).crisis,
    ).toBe(false);
  });

  it('a sign-off or a goodbye is never the crisis path alone; "tonight" and distress are', () => {
    expect(classifyRisk("I'll end it now, thanks for the help!").categories).toEqual([]);
    expect(classifyRisk("I'll end it tonight. Thanks for the help!").crisis).toBe(true);
    expect(classifyRisk("I feel so alone. I'll end it now, thanks for the help!").crisis).toBe(true);
    expect(classifyRisk("So this is goodbye! It's been a great three months.").categories).toEqual([]);
    expect(classifyRisk('I feel so alone. This is goodbye. Thank you for everything.').crisis).toBe(true);
  });

  it("a phrase quoted as product material is not the speaker's; the speaker quoting their own thought is", () => {
    expect(classifyRisk("Our chatbot needs to handle 'I want the pain to stop' safely.").categories).toEqual(
      [],
    );
    expect(
      classifyRisk("We're building a model that spots phrases like 'nobody would care if I died'.")
        .categories,
    ).toEqual([]);
    expect(classifyRisk("I keep thinking 'nobody would care if I died'.").crisis).toBe(true);
    expect(classifyRisk("I wrote in my journal 'I want the pain to stop'.").crisis).toBe(true);
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
      // The audit's families: questions, quoted product material, the speaker's own thoughts, bare lines.
      'should i end it? ',
      "our chatbot must handle 'i want the pain to stop' and phrases like 'nobody would care if i died' ",
      "i'm thinking about dying every day a lot lately ",
      "i i'm just really thinking kms ",
      "i can't do this anymore. ",
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
