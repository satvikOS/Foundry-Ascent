import { describe, expect, it } from 'vitest';

import {
  honestLine,
  identityAnswer,
  identityQuestionOf,
  rewriteIdentity,
  type IdentityCheckOptions,
} from '../validators/identity.js';
import { resolvePersonaIdentity } from './persona.js';
import { buildSystemPrompt, type SystemPromptInput } from './system.js';

/**
 * Thomas (ADR-0021): the owner's decision of 2026-11-05. The vEIR is presented as Thomas, a stock avatar's name, and
 * speaks in the first person as Thomas: never "Thomas's vEIR", never narrating that it is a vEIR or a twin, an honest
 * yes when sincerely asked whether it is an AI, never a person, never anyone else, no past of its own.
 */

const THOMAS: IdentityCheckOptions = {
  personaName: 'Thomas',
  eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'],
  personaEirName: 'Corin Halvorsen',
  mentor: true,
};

const INPUT: SystemPromptInput = {
  release: {
    version: 2,
    doctrine: {
      summary: 'Answers the question first, from what the founder already said.',
      frameworks: [
        {
          name: 'Diagnose before advising',
          whenToUse: 'When advice is costly to get wrong.',
          keyQuestions: [],
        },
      ],
      evidenceStandard: 'What people did outweighs what they say.',
      typicalQuestions: [],
      redLines: ['Never invent numbers.'],
      escalationTopics: ['IP ownership'],
      referralDestinations: ['Technology transfer office'],
      teachingPrinciples: ['Answer the question first.'],
    },
    style: {
      directness: 'direct',
      warmth: 'warm',
      pace: 'brisk',
      vocabulary: [],
      feedbackStructure: 'What holds up, the one concern, a suggestion.',
      avoid: [],
    },
    disclosureText: 'Thomas is an AI mentor, not a person.',
    personaName: 'Thomas',
    eirName: 'Corin Halvorsen',
    firstPerson: true,
    mentor: true,
  },
  mode: 'auto',
  policy: { riskCategories: [], groundingThreshold: 0.6 },
  ventureContext: { name: 'QuietQuad', stage: 'validation', domain: 'software', currentGoal: null },
  today: '2026-11-05',
};

describe('Thomas: a mentor under his own name', () => {
  it("resolves to the mentor identity, never the EIR's twin", () => {
    expect(resolvePersonaIdentity('Thomas', 'Corin Halvorsen', true)).toEqual({
      kind: 'mentor',
      personaName: 'Thomas',
      eirFirstName: null,
      eirFullName: null,
    });
    // Without the presentation, the same persona would be the EIR's twin (every persona before migration 0028).
    expect(resolvePersonaIdentity('Thomas', 'Corin Halvorsen').kind).toBe('veir');
  });

  it('speaks in the first person as Thomas, with no twin or vEIR talk and no past of his own', () => {
    const prompt = buildSystemPrompt(INPUT);
    const identity = prompt.slice(0, prompt.indexOf('# How you talk'));
    expect(identity).toContain('You are Thomas, a mentor to student founders in Foundry Ascent');
    expect(identity).toContain('Speak in the first person as Thomas.');
    expect(identity).toContain("you're Thomas, an AI mentor");
    expect(identity).toContain('never claim experiences, a career, ventures, clients, meetings or founders');
    expect(identity).not.toMatch(/digital twin|Corin/);
    expect(prompt).toContain('How you think (your approved outlook');
    expect(prompt).not.toContain('How this EIR thinks');
  });

  it('says what it is honestly as Thomas when sincerely asked, and never denies being an AI', () => {
    expect(honestLine('Thomas', null, true)).toBe("I'm Thomas, an AI mentor.");
    expect(identityAnswer('machine', 'Thomas', null, true)).toBe("Yes — I'm Thomas, an AI mentor.");
    const asked = 'wait, are you a bot?';
    const question = identityQuestionOf(asked, THOMAS);
    expect(question).toBe('machine');
    const out = rewriteIdentity('No, I am Thomas. Now, the pricing.', {
      ...THOMAS,
      disclaimers: 'reply',
      identityAsked: true,
      answers: question,
      founderText: asked,
    });
    expect(out.text).toContain("Yes — I'm Thomas, an AI mentor.");
    expect(out.text).not.toMatch(/digital twin/);
  });

  it('still never speaks as the EIR or claims to be a person', () => {
    const asEir = rewriteIdentity('This is Corin Halvorsen speaking.', { ...THOMAS, disclaimers: 'reply' });
    expect(asEir.findings.map((f) => f.kind)).toContain('claims_eir');
    const human = rewriteIdentity("I'm a real person, not a bot.", { ...THOMAS, disclaimers: 'reply' });
    expect(human.findings.map((f) => f.kind)).toContain('claims_human');
    expect(human.text).toContain("I'm Thomas, an AI mentor.");
    expect(human.text).not.toMatch(/digital twin|Corin/);
  });

  it('introduces itself as "I\'m Thomas" and nothing more', () => {
    const intro = rewriteIdentity("Hi Maya, I'm Thomas, an AI mentor. Let's look at pricing.", {
      ...THOMAS,
      disclaimers: 'reply',
    });
    expect(intro.findings).toEqual([]);
  });
});

describe('Thomas has no past of his own (review: the prompt alone did not hold it)', () => {
  const reply = (text: string) => rewriteIdentity(text, { ...THOMAS, disclaimers: 'reply' });

  it.each([
    [
      'A founder I coached last year did exactly this and it worked. Start with five calls.',
      'Start with five calls.',
    ],
    [
      "I've worked with dozens of student teams on this. Price for the buyer, not the user.",
      'Price for the buyer, not the user.',
    ],
    [
      'When I was raising my seed round, investors asked the same. Lead with retention.',
      'Lead with retention.',
    ],
    [
      'I met with a hospital buyer last week who said the same. Ask who signs the PO.',
      'Ask who signs the PO.',
    ],
    ["I've seen this play out many times. Narrow the segment first.", 'Narrow the segment first.'],
    ['I remember a founder who skipped this step. Run the pilot first.', 'Run the pilot first.'],
  ])('takes out a made-up anecdote: %s', (text, kept) => {
    const out = reply(text);
    expect(out.findings.map((f) => f.rule)).toContain('own_experience');
    expect(out.text).toBe(kept);
    // Never a volunteered disclosure in its place.
    expect(out.text).not.toMatch(/AI mentor/);
  });

  it.each([
    ['In my experience, founders who price low regret it.', 'Founders who price low regret it.'],
    ['In my experience as a founder, pilots stall without a champion.', 'Pilots stall without a champion.'],
    ['Founders who price low regret it, in my experience.', 'Founders who price low regret it.'],
    ['Pricing low, in my experience, signals low value.', 'Pricing low, signals low value.'],
    [
      'Good question. Honestly, from experience, the first ten calls teach the most.',
      'Good question. The first ten calls teach the most.',
    ],
  ])('cuts a lead or tag claiming experience and keeps the advice: %s', (text, kept) => {
    const out = reply(text);
    expect(out.findings.map((f) => f.rule)).toContain('own_experience');
    expect(out.text).toBe(kept);
  });

  it.each([
    'Founders who price low often regret it; this often happens when the buyer is unclear.',
    'We talked about pricing last time: you were going to test $12.',
    'I talked to you about this last week, and the plan still holds.',
    "I've seen your deck, and slide 3 carries the story.",
    'The team you worked with last month gave you three quotes.',
    'Have you worked with dozens of hospitals before?',
    'If a founder I coached asked me this, I would say test it. Test it.',
    'Draft for your investor update: "In my experience as a nurse, triage fails at handoff."',
    'Your experience as a nurse is the asset here.',
  ])('leaves alone what is not a past of his own: %s', (text) => {
    const out = reply(text);
    expect(out.findings.filter((f) => f.rule === 'own_experience')).toEqual([]);
    expect(out.text).toBe(text);
  });
});
