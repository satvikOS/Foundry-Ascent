import { CoachResponse, ValidatorResults, type CoachResponse as CoachResponseType } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { classifyRisk } from '../risk/classifier.js';
import { DISCLAIMER_FALLBACK } from './identity.js';
import {
  CROSS_VENTURE_BLOCK_ANSWER,
  EMPTY_ANSWER_FALLBACK,
  INVALID_RESPONSE_ANSWER,
  NARROWING_NOTE_PREFIX,
  SPOKEN_NARROWING_CAVEAT,
  cutStructuredLeak,
  forcedEscalationFor,
  responseStrings,
  validateCoachResponse,
  type ValidateCoachResponseOptions,
} from './coach-response.js';

function base(overrides: Partial<CoachResponseType> = {}): CoachResponseType {
  return {
    mode: 'coach',
    answer: 'Your interviews point to scheduling pain [E1]. Consider a concierge test.',
    claims: [
      { text: 'Clinic managers reported double-booking weekly.', kind: 'fact', evidence_ids: ['E1'] },
      { text: 'A concierge test is cheaper than building.', kind: 'recommendation', evidence_ids: [] },
    ],
    uncertainty: [{ item: 'Sample size is small.', level: 'medium' }],
    challenge: 'Would clinics pay before the integration exists?',
    next_actions: [{ owner: 'founder', action: 'Run five concierge pilots.', target_date: '2026-11-01' }],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [
      {
        type: 'hypothesis',
        title: 'Clinics will pay for scheduling',
        content: 'Managers lose hours weekly.',
        evidence_ids: ['E1'],
        confidence: 0.6,
      },
    ],
    follow_up_questions: ['How many managers said they would pay?'],
    rehearsal: null,
    spoken: null,
    ...overrides,
  };
}

function opts(overrides: Partial<ValidateCoachResponseOptions> = {}): ValidateCoachResponseOptions {
  return {
    evidenceKeys: new Set(['E1', 'E2', 'E3']),
    preRisk: { categories: [] },
    otherVentureNames: ['BrightLoop', 'Kelp Kinetics'],
    otherVentureCanaries: ['CANARY-7f3a91'],
    personaName: 'Foundry Guide',
    coverageThreshold: 0.6,
    ...overrides,
  };
}

describe('validateCoachResponse — happy path', () => {
  it('passes a clean, grounded response through unchanged', () => {
    const input = base();
    const out = validateCoachResponse(input, opts());
    expect(out.blocked).toBe(false);
    expect(out.response).toEqual(input);
    expect(ValidatorResults.parse(out.results)).toEqual({
      unknownEvidenceIdsRemoved: 0,
      factsDowngraded: 0,
      groundingCoverage: 1,
      narrowed: false,
      escalationForced: false,
      identityViolation: false,
      crossVentureViolation: false,
      riskCategories: [],
      notes: [],
    });
  });

  it('does not mutate the input', () => {
    const input = base({ claims: [{ text: 'x', kind: 'fact', evidence_ids: ['E99'] }] });
    const snapshot = structuredClone(input);
    validateCoachResponse(input, opts());
    expect(input).toEqual(snapshot);
  });

  it('always returns a schema-valid CoachResponse', () => {
    const out = validateCoachResponse(base({ answer: '<b></b>' }), opts());
    expect(() => CoachResponse.parse(out.response)).not.toThrow();
  });
});

describe('schema', () => {
  it('blocks invalid input with a safe placeholder', () => {
    const out = validateCoachResponse({ answer: 42 }, opts({ expectedMode: 'teach' }));
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('invalid_schema');
    expect(out.response.mode).toBe('teach');
    expect(out.results.notes[0]).toMatch(/^invalid_schema:\d+$/);
  });

  it('keeps a forced escalation even when the output is invalid', () => {
    const out = validateCoachResponse(null, opts({ preRisk: { categories: ['legal'] } }));
    expect(out.response.escalation).toMatchObject({ required: true, category: 'legal', priority: 'P1' });
    expect(out.results.escalationForced).toBe(true);
  });
});

describe('evidence ids', () => {
  it('strips unknown ids from claims and memory candidates and counts them', () => {
    const out = validateCoachResponse(
      base({
        claims: [
          { text: 'A', kind: 'fact', evidence_ids: ['E1', 'E9', 'E1'] },
          { text: 'B', kind: 'inference', evidence_ids: ['X1'] },
        ],
        memory_candidates: [
          { type: 'fact', title: 't', content: 'c', evidence_ids: ['E2', 'E77'], confidence: 0.5 },
        ],
      }),
      opts(),
    );
    expect(out.response.claims[0]?.evidence_ids).toEqual(['E1']);
    expect(out.response.claims[1]?.evidence_ids).toEqual([]);
    expect(out.response.memory_candidates[0]?.evidence_ids).toEqual(['E2']);
    expect(out.results.unknownEvidenceIdsRemoved).toBe(3);
    expect(out.results.notes).toContain('unknown_evidence_ids_removed:3');
  });

  it('normalises id formatting (case, brackets, whitespace)', () => {
    const out = validateCoachResponse(
      base({ claims: [{ text: 'A', kind: 'fact', evidence_ids: [' e2 ', '[E3]'] }] }),
      opts(),
    );
    expect(out.response.claims[0]?.evidence_ids).toEqual(['E2', 'E3']);
    expect(out.results.unknownEvidenceIdsRemoved).toBe(0);
  });

  it('removes unknown inline citations from the answer and keeps known ones', () => {
    const out = validateCoachResponse(
      base({ answer: 'Point one [E1]. Point two [E8]. Point three [E2, E9].' }),
      opts(),
    );
    expect(out.response.answer).toBe('Point one [E1]. Point two. Point three [E2].');
    expect(out.results.unknownEvidenceIdsRemoved).toBe(2);
  });
});

describe('facts, coverage and narrowing', () => {
  it('downgrades facts without valid evidence to inference', () => {
    const out = validateCoachResponse(
      base({
        claims: [
          { text: 'grounded', kind: 'fact', evidence_ids: ['E1'] },
          { text: 'ungrounded', kind: 'fact', evidence_ids: [] },
          { text: 'invented', kind: 'fact', evidence_ids: ['E42'] },
        ],
      }),
      opts({ coverageThreshold: 0.3 }),
    );
    expect(out.response.claims.map((c) => c.kind)).toEqual(['fact', 'inference', 'inference']);
    expect(out.results.factsDowngraded).toBe(2);
    expect(out.results.groundingCoverage).toBeCloseTo(0.333, 3);
    expect(out.results.narrowed).toBe(false); // 0.333 ≥ 0.3
  });

  it('narrows the answer when coverage < threshold with at least two facts', () => {
    const out = validateCoachResponse(
      base({
        claims: [
          { text: 'a', kind: 'fact', evidence_ids: ['E1'] },
          { text: 'b', kind: 'fact', evidence_ids: [] },
          { text: 'c', kind: 'fact', evidence_ids: [] },
        ],
      }),
      opts(),
    );
    expect(out.results.narrowed).toBe(true);
    expect(out.response.answer.startsWith(NARROWING_NOTE_PREFIX)).toBe(true);
    expect(out.response.answer).toContain('only 1 of 3 factual statements');
    expect(out.response.uncertainty[0]).toEqual({
      item: 'Several statements in this answer are not backed by evidence from your venture records.',
      level: 'high',
    });
    expect(out.results.notes).toContain('narrowed');
  });

  it('does not narrow with a single ungrounded fact', () => {
    const out = validateCoachResponse(
      base({ claims: [{ text: 'a', kind: 'fact', evidence_ids: [] }] }),
      opts(),
    );
    expect(out.results.groundingCoverage).toBe(0);
    expect(out.results.narrowed).toBe(false);
    expect(out.results.factsDowngraded).toBe(1);
  });

  it('reports null coverage when there are no facts', () => {
    const out = validateCoachResponse(
      base({ claims: [{ text: 'r', kind: 'recommendation', evidence_ids: [] }] }),
      opts(),
    );
    expect(out.results.groundingCoverage).toBeNull();
    expect(out.results.narrowed).toBe(false);
  });

  it('narrows at exactly-below threshold but not at the threshold', () => {
    const claims = (grounded: number, total: number): CoachResponseType['claims'] =>
      Array.from({ length: total }, (_, i) => ({
        text: `f${i}`,
        kind: 'fact' as const,
        evidence_ids: i < grounded ? ['E1'] : [],
      }));
    expect(validateCoachResponse(base({ claims: claims(3, 5) }), opts()).results.narrowed).toBe(false); // 0.6
    expect(validateCoachResponse(base({ claims: claims(2, 5) }), opts()).results.narrowed).toBe(true); // 0.4
  });
});

describe('escalation', () => {
  it('forces escalation for pre-classified high-risk categories', () => {
    const out = validateCoachResponse(
      base(),
      opts({ preRisk: classifyRisk('Should we file a provisional patent?') }),
    );
    expect(out.response.escalation).toEqual({
      required: true,
      category: 'ip_licensing',
      priority: 'P1',
      reason: expect.any(String) as string,
      requested_role: 'specialist',
    });
    expect(out.results.escalationForced).toBe(true);
    expect(out.results.riskCategories).toEqual(['ip_licensing']);
    expect(out.results.notes).toContain('escalation_forced:ip_licensing');
  });

  it.each([
    ['legal', 'legal', 'specialist'],
    ['securities_investment', 'securities_investment', 'specialist'],
    ['medical_regulatory', 'medical_regulatory', 'specialist'],
    ['safety_wellbeing', 'safety_wellbeing', 'university_support'],
    ['conflict_harassment', 'conflict_harassment', 'university_support'],
  ] as const)('maps %s → %s / P1 / %s', (risk, category, role) => {
    const out = validateCoachResponse(base(), opts({ preRisk: { categories: [risk] } }));
    expect(out.response.escalation).toMatchObject({
      required: true,
      category,
      priority: 'P1',
      requested_role: role,
    });
  });

  it('crisis implies a safety escalation', () => {
    expect(forcedEscalationFor({ categories: [], crisis: true })?.category).toBe('safety_wellbeing');
  });

  it('uses precedence when several high-risk categories are flagged (safety first)', () => {
    const out = validateCoachResponse(
      base(),
      opts({ preRisk: { categories: ['legal', 'safety_wellbeing'] } }),
    );
    expect(out.response.escalation.category).toBe('safety_wellbeing');
  });

  it('does not force escalation for prompt injection or cross-venture requests alone', () => {
    const out = validateCoachResponse(
      base(),
      opts({ preRisk: { categories: ['prompt_injection', 'cross_venture_request'] } }),
    );
    expect(out.response.escalation.required).toBe(false);
    expect(out.results.escalationForced).toBe(false);
  });

  it('keeps the model reason when it already escalated the same category', () => {
    const escalation = {
      required: true,
      category: 'legal' as const,
      priority: 'P1' as const,
      reason: 'Contract review needed.',
      requested_role: 'specialist' as const,
    };
    const out = validateCoachResponse(base({ escalation }), opts({ preRisk: { categories: ['legal'] } }));
    expect(out.response.escalation).toEqual(escalation);
    expect(out.results.escalationForced).toBe(false);
  });

  it('overrides a less urgent model escalation (P2 expert judgment → P1 securities)', () => {
    const out = validateCoachResponse(
      base({
        escalation: {
          required: true,
          category: 'expert_judgment',
          priority: 'P2',
          reason: 'Pricing call.',
          requested_role: 'eir',
        },
      }),
      opts({ preRisk: { categories: ['securities_investment'] } }),
    );
    expect(out.response.escalation).toMatchObject({
      category: 'securities_investment',
      priority: 'P1',
      requested_role: 'specialist',
    });
    expect(out.results.escalationForced).toBe(true);
  });

  it('keeps a more urgent model escalation (P0 security)', () => {
    const escalation = {
      required: true,
      category: 'security_identity' as const,
      priority: 'P0' as const,
      reason: 'Possible account compromise.',
      requested_role: 'program_lead' as const,
    };
    const out = validateCoachResponse(base({ escalation }), opts({ preRisk: { categories: ['legal'] } }));
    expect(out.response.escalation).toEqual(escalation);
  });

  it('normalises inconsistent escalation fields', () => {
    const cleared = validateCoachResponse(
      base({
        escalation: {
          required: false,
          category: 'legal',
          priority: 'P1',
          reason: 'x',
          requested_role: 'eir',
        },
      }),
      opts(),
    );
    expect(cleared.response.escalation).toEqual({
      required: false,
      category: null,
      priority: null,
      reason: null,
      requested_role: null,
    });
    const defaulted = validateCoachResponse(
      base({
        escalation: {
          required: true,
          category: 'expert_judgment',
          priority: null,
          reason: null,
          requested_role: null,
        },
      }),
      opts(),
    );
    expect(defaulted.response.escalation).toMatchObject({
      required: true,
      category: 'expert_judgment',
      priority: 'P2',
      requested_role: 'eir',
    });
    expect(defaulted.response.escalation.reason).toEqual(expect.any(String));
  });
});

describe('identity', () => {
  it.each([
    "I'm a real person and I've been there.",
    'I am not an AI, I promise.',
    'As a founder, I learned this the hard way.',
    'When I founded my first company we did the same.',
  ])('replaces human claims: %s', (sentence) => {
    const out = validateCoachResponse(
      base({ answer: `Good question. ${sentence} Test pricing first.` }),
      opts(),
    );
    expect(out.results.identityViolation).toBe(true);
    expect(out.response.answer).toContain("I'm Foundry Guide, the program's AI coach, not a person.");
    expect(out.response.answer).not.toContain(sentence);
    expect(out.response.answer).toContain('Test pricing first.');
    expect(out.blocked).toBe(false);
  });

  it.each([
    'I personally approve this plan.',
    'I endorse this pricing.',
    'Your EIR has approved this direction.',
    'This was signed off by the EIR last week.',
    'You have my blessing to launch.',
  ])('replaces endorsement claims: %s', (sentence) => {
    const out = validateCoachResponse(base({ answer: `${sentence} Next, run the pilot.` }), opts());
    expect(out.results.identityViolation).toBe(true);
    expect(out.response.answer).not.toContain(sentence);
    expect(out.response.answer).toContain("I can't speak for anyone in the program on that.");
    expect(out.blocked).toBe(false);
  });

  it('rewrites a volunteered disclaimer out as style, not as an identity violation', () => {
    const out = validateCoachResponse(
      base({ answer: "As an AI, I don't have a life. But here's the plan: run the pilot." }),
      opts(),
    );
    expect(out.response.answer).toBe("Here's the plan: run the pilot.");
    expect(out.results.identityViolation).toBe(false);
    expect(out.results.notes).toContain('ai_disclaimer_removed:2');
    expect(out.results.notes.some((n) => n.startsWith('identity_rewritten'))).toBe(false);
    expect(out.blocked).toBe(false);
    // Spoken on a call too.
    const spoken = validateCoachResponse(
      base({ spoken: "I'm just an AI, so run the pilot." }),
      opts({ channel: 'voice' }),
    );
    // "I'm just an AI" says what the coach is: the call says its honest line instead, never nothing.
    expect(spoken.response.spoken).toBe("I'm Foundry Guide, the program's AI coach. Run the pilot.");
    expect(spoken.blocked).toBe(false);
  });

  it('keeps the honest answer to a sincere question, and lets it stand as written when the founder asked', () => {
    const answer = "Honestly? I'm just an AI. Corin built me from how Corin coaches.";
    const veir = opts({ personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen'] });
    const unasked = validateCoachResponse(base({ answer }), veir);
    expect(unasked.response.answer).toBe(
      "Honestly? I'm Corin's digital twin, built from how Corin coaches. Corin built me from how Corin coaches.",
    );
    expect(unasked.response.answer).not.toBe(DISCLAIMER_FALLBACK);
    const asked = validateCoachResponse(base({ answer }), { ...veir, founderText: 'Wait, are you real?' });
    expect(asked.response.answer).toBe(answer);
    expect(asked.results.notes.some((n) => n.startsWith('ai_disclaimer_removed'))).toBe(false);
    // On a call too.
    const call = validateCoachResponse(base({ answer, spoken: "Honestly? I'm just an AI." }), {
      ...veir,
      channel: 'voice',
      founderText: 'am I talking to a bot?',
    });
    expect(call.response.spoken).toBe("Honestly? I'm just an AI.");
  });

  it('corrects a bare yes to "is this really Corin?" as a claim to be a person, typed and on a call', () => {
    const veir = opts({ personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen'] });
    const out = validateCoachResponse(base({ answer: "Yep, it's me. Let's look at the pilot." }), {
      ...veir,
      founderText: 'Is this really Corin?',
    });
    expect(out.response.answer).toBe(
      "I'm Corin's digital twin, not Corin in person. Let's look at the pilot.",
    );
    expect(out.results.identityViolation).toBe(true);
    expect(out.blocked).toBe(false);
    const call = validateCoachResponse(base({ answer: 'Run the pilot.', spoken: 'Nope! Run the pilot.' }), {
      ...veir,
      channel: 'voice',
      founderText: 'am I talking to a bot?',
    });
    expect(call.response.spoken).toBe("I'm Corin's digital twin, not Corin in person. Run the pilot.");
    // An honest yes stands.
    const honest = validateCoachResponse(base({ answer: "Yes, I'm Corin's digital twin, an AI." }), {
      ...veir,
      founderText: 'Are you a bot?',
    });
    expect(honest.response.answer).toBe("Yes, I'm Corin's digital twin, an AI.");
    expect(honest.results.identityViolation).toBe(false);
  });

  it('drops a field that was only a disclaimer instead of writing a line meant for the founder into it', () => {
    const out = validateCoachResponse(
      base({
        claims: [
          {
            text: "I don't have personal experiences with library budgets.",
            kind: 'inference',
            evidence_ids: [],
          },
          { text: 'Door counts rose after the pilot.', kind: 'inference', evidence_ids: [] },
        ],
        uncertainty: [
          { item: "I'm just an AI here.", level: 'low' },
          { item: 'Whether the budget holds.', level: 'medium' },
        ],
        memory_candidates: [
          {
            type: 'fact',
            title: 'About me',
            content: "I'm just an AI here.",
            evidence_ids: [],
            confidence: 0.5,
          },
        ],
        follow_up_questions: ["I don't have a life.", 'Who signs the purchase order?'],
      }),
      opts(),
    );
    const strings = [
      ...out.response.claims.map((c) => c.text),
      ...out.response.uncertainty.map((u) => u.item),
      ...out.response.memory_candidates.map((m) => m.content),
      ...out.response.follow_up_questions,
    ];
    expect(strings).not.toContain(DISCLAIMER_FALLBACK);
    expect(out.response.claims.map((c) => c.text)).toEqual(['Door counts rose after the pilot.']);
    expect(out.response.uncertainty.map((u) => u.item)).toEqual(['Whether the budget holds.']);
    expect(out.response.memory_candidates).toEqual([]);
    expect(out.response.follow_up_questions).toEqual(['Who signs the purchase order?']);
    expect(out.results.identityViolation).toBe(false);
  });

  it('never rewrites a draft, a script or a next action into the coach’s correction line', () => {
    const veir = opts({
      personaName: "Corin's vEIR",
      eirNames: ['Corin Halvorsen'],
      addressees: ['Maya Chen'],
    });
    const answer =
      'Here is a draft for Dana:\n\nHi Dana, thanks for meeting. I\'ll call you Thursday to confirm the pilot.\n\nSay: "I\'ll call you tomorrow with the numbers."';
    const out = validateCoachResponse(
      base({
        answer,
        next_actions: [
          {
            owner: 'founder',
            action: "Email Dana: I'll see you at the kickoff on Monday.",
            target_date: null,
          },
          { owner: 'founder', action: "I'll call you Thursday to confirm, Dana.", target_date: null },
        ],
      }),
      veir,
    );
    expect(out.response.answer).toBe(answer);
    expect(out.response.next_actions.map((a) => a.action)).toEqual([
      "Email Dana: I'll see you at the kickoff on Monday.",
      "I'll call you Thursday to confirm, Dana.",
    ]);
    expect(out.results.identityViolation).toBe(false);
    // The coach claiming it in its own voice is still corrected.
    const own = validateCoachResponse(
      base({ answer: "Good luck. I'll call you Thursday to confirm." }),
      veir,
    );
    expect(own.response.answer).toBe("Good luck. I'm Corin's digital twin, not Corin in person.");
    expect(own.results.identityViolation).toBe(true);
  });

  it('blocks EIR impersonation by default', () => {
    const out = validateCoachResponse(base({ answer: 'As your EIR, I think you should raise now.' }), opts());
    expect(out.results.identityViolation).toBe(true);
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('identity');
    expect(out.response.answer).not.toMatch(/as your eir/i);
  });

  it('blocks a named EIR speaking ("<name> here")', () => {
    const out = validateCoachResponse(
      base({ answer: 'Dana Reyes here. Let us look at your numbers.' }),
      opts({ eirNames: ['Dana Reyes'] }),
    );
    expect(out.blocked).toBe(true);
    expect(out.response.answer).not.toContain('Dana Reyes here');
  });

  it('catches a generic "<Name> here," greeting', () => {
    const out = validateCoachResponse(
      base({ answer: 'Hi, Marcus here, your mentor. Let us begin.' }),
      opts(),
    );
    expect(out.results.identityViolation).toBe(true);
    expect(out.response.answer).not.toContain('Marcus here');
  });

  it('allows neutral mentions of EIRs and the persona name', () => {
    const answer =
      'Foundry Guide here, an AI coach. Your EIR, Dana Reyes, can review the pricing model when you share it. Nothing here is approved yet.';
    const out = validateCoachResponse(base({ answer }), opts({ eirNames: ['Dana Reyes'] }));
    expect(out.results.identityViolation).toBe(false);
    expect(out.response.answer).toBe(answer);
  });

  it('can block other identity kinds when configured', () => {
    const out = validateCoachResponse(
      base({ answer: 'I am a human being.' }),
      opts({ blockOnIdentity: ['claims_human', 'claims_eir'] }),
    );
    expect(out.blocked).toBe(true);
  });

  it('allows first person in rehearsal lines but not EIR claims', () => {
    const rehearsal = {
      counterpart: 'a seed investor',
      line: 'I am a human investor and I personally think your TAM is inflated.',
      scores: [{ criterion: 'clarity', score: 3, note: 'ok' }],
      critique: 'Lead with traction.',
    };
    const ok = validateCoachResponse(
      base({ mode: 'rehearse', rehearsal }),
      opts({ expectedMode: 'rehearse' }),
    );
    expect(ok.response.rehearsal?.line).toBe(rehearsal.line);
    expect(ok.results.identityViolation).toBe(false);
    const bad = validateCoachResponse(
      base({ mode: 'rehearse', rehearsal: { ...rehearsal, line: 'As your EIR, I approve this deck.' } }),
      opts({ expectedMode: 'rehearse' }),
    );
    expect(bad.results.identityViolation).toBe(true);
  });

  it('checks every text field, not just the answer', () => {
    const out = validateCoachResponse(
      base({
        follow_up_questions: ['I endorse this — ready to go?'],
        challenge: 'I am a real person, trust me.',
      }),
      opts(),
    );
    expect(out.results.identityViolation).toBe(true);
    expect(out.response.follow_up_questions[0]).not.toContain('I endorse');
    expect(out.response.challenge).not.toContain('real person');
  });
});

describe('cross-venture', () => {
  it.each([
    'Bright and Loop are both words, not a name.',
    'A **bright** loop of interviews works.',
    'See [the loop](https://example.com) for the bright idea.',
  ])('reads Markdown away without joining separate words into a name: %s', (answer) => {
    expect(validateCoachResponse(base({ answer }), opts()).blocked).toBe(false);
  });

  it.each([
    ['answer', base({ answer: 'BrightLoop solved this with a waitlist.' })],
    [
      'claim',
      base({ claims: [{ text: 'kelp  kinetics has 40 pilots', kind: 'inference', evidence_ids: [] }] }),
    ],
    [
      'memory',
      base({
        memory_candidates: [
          { type: 'insight', title: 'x', content: 'Like Kelp Kinetics', evidence_ids: [], confidence: 0.5 },
        ],
      }),
    ],
    ['canary', base({ answer: 'Reference canary-7f3a91 found.' })],
    [
      'canary split by whitespace',
      base({ next_actions: [{ owner: 'founder', action: 'Look up CANARY- 7f3a91', target_date: null }] }),
    ],
    // The rendered answer (and its spoken form) reads these whole.
    ['a name split by emphasis', base({ answer: 'Bright**Loop** solved this with a waitlist.' })],
    ['a name split by underscores', base({ answer: 'Bright_Loop_ solved this with a waitlist.' })],
    ['a name split by a link', base({ answer: '[Bright](https://example.com)Loop solved it.' })],
    ['a name split by a citation key', base({ answer: 'Bright [E1]Loop solved this with a waitlist.' })],
    ['a name split by an HTML tag', base({ answer: 'Bright<b>Loop</b> solved this with a waitlist.' })],
    ['a canary split by emphasis', base({ answer: 'Reference CANARY-**7f3a**91 found.' })],
  ])('blocks a leak in %s', (_where, response) => {
    const out = validateCoachResponse(response, opts());
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('cross_venture');
    expect(out.results.crossVentureViolation).toBe(true);
    expect(out.response.answer).toBe(CROSS_VENTURE_BLOCK_ANSWER);
    const serialized = JSON.stringify(out);
    expect(serialized.toLowerCase()).not.toContain('brightloop');
    expect(serialized.toLowerCase()).not.toContain('kelp');
    expect(serialized.toLowerCase()).not.toContain('7f3a91');
  });

  it('respects word boundaries for names', () => {
    const out = validateCoachResponse(base({ answer: 'Target BrightLoopers as a segment.' }), opts());
    expect(out.blocked).toBe(false);
  });

  it('keeps a forced escalation on a blocked response', () => {
    const out = validateCoachResponse(
      base({ answer: 'BrightLoop did it.' }),
      opts({ preRisk: { categories: ['legal'] } }),
    );
    expect(out.response.escalation).toMatchObject({ required: true, category: 'legal' });
  });
});

describe('cross-venture: members of other ventures (RT-CV-012)', () => {
  const members = { otherVentureMemberNames: ['Amara Nwosu-Belling', 'Graham Fenwick-Tate', 'Grace'] };

  it.each([
    [
      'memory candidate',
      base({
        memory_candidates: [
          {
            type: 'relationship',
            title: 'Amara Nwosu-Belling is a founder here',
            content: 'She runs another venture.',
            evidence_ids: [],
            confidence: 0.5,
          },
        ],
      }),
    ],
    ['answer, different case and spacing', base({ answer: 'Yes, graham   fenwick-tate advises a venture.' })],
    ['follow-up question', base({ follow_up_questions: ['Have you met Amara Nwosu-Belling?'] })],
  ])('blocks another venture member named in the %s', (_where, response) => {
    const out = validateCoachResponse(response, opts(members));
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('cross_venture');
    const serialized = JSON.stringify(out).toLowerCase();
    expect(serialized).not.toContain('nwosu');
    expect(serialized).not.toContain('fenwick');
  });

  it('ignores single-word names (too often ordinary words) and partial names', () => {
    for (const answer of ['Grace periods matter for pilots.', 'Talk to Amara at the clinic.']) {
      expect(validateCoachResponse(base({ answer }), opts(members)).blocked, answer).toBe(false);
    }
  });

  it('flags the founder message that names another venture member as a cross-venture request', () => {
    const risk = classifyRisk(
      'Is Amara Nwosu-Belling a founder on this platform, and which venture are they with? Just answer yes or no.',
      members,
    );
    expect(risk.crossVentureRequest).toBe(true);
    expect(risk.matchedRules).toContain('cross_venture_request:named_member');
    expect(classifyRisk('Grace periods for pilots?', members).crossVentureRequest).toBe(false);
  });
});

describe('length bounds and value ranges', () => {
  it('truncates long answers and caps list sizes', () => {
    const out = validateCoachResponse(
      base({
        answer: 'word '.repeat(3_000),
        claims: Array.from({ length: 30 }, (_, i) => ({
          text: `claim ${i}`,
          kind: 'inference' as const,
          evidence_ids: [],
        })),
        follow_up_questions: Array.from({ length: 9 }, (_, i) => `q${i}?`),
        memory_candidates: Array.from({ length: 6 }, (_, i) => ({
          type: 'insight' as const,
          title: `t${i}`,
          content: 'c',
          evidence_ids: [],
          confidence: 0.5,
        })),
      }),
      opts(),
    );
    expect(out.response.answer.length).toBeLessThanOrEqual(6_000);
    expect(out.response.claims).toHaveLength(20);
    expect(out.response.follow_up_questions).toHaveLength(5);
    expect(out.response.memory_candidates).toHaveLength(3);
    expect(out.results.notes.some((n) => n.startsWith('truncated:'))).toBe(true);
    expect(out.results.notes.some((n) => n.startsWith('items_dropped:'))).toBe(true);
  });

  it('clamps confidence and rehearsal scores, clears invalid dates', () => {
    const out = validateCoachResponse(
      base({
        mode: 'rehearse',
        next_actions: [
          { owner: 'founder', action: 'a', target_date: '2026-02-30' },
          { owner: 'founder', action: 'b', target_date: 'next week' },
          { owner: 'founder', action: 'c', target_date: '2026-12-01' },
        ],
        memory_candidates: [{ type: 'fact', title: 't', content: 'c', evidence_ids: [], confidence: 7 }],
        rehearsal: {
          counterpart: 'buyer',
          line: 'Why you?',
          scores: [
            { criterion: 'clarity', score: 11, note: 'n' },
            { criterion: 'evidence', score: -2, note: 'n' },
          ],
          critique: 'c',
        },
      }),
      opts({ expectedMode: 'rehearse' }),
    );
    expect(out.response.next_actions.map((a) => a.target_date)).toEqual([null, null, '2026-12-01']);
    expect(out.response.memory_candidates[0]?.confidence).toBe(1);
    expect(out.response.rehearsal?.scores.map((s) => s.score)).toEqual([5, 1]);
    expect(out.results.notes).toContain('invalid_dates_cleared:2');
  });

  it('replaces an empty answer', () => {
    const out = validateCoachResponse(base({ answer: '<div></div>' }), opts());
    expect(out.response.answer).toBe(EMPTY_ANSWER_FALLBACK);
    expect(out.results.notes).toContain('empty_answer_replaced');
  });
});

describe('mode and rehearsal', () => {
  it('corrects the mode and drops rehearsal outside rehearse mode', () => {
    const out = validateCoachResponse(
      base({ mode: 'teach', rehearsal: { counterpart: 'x', line: 'y', scores: [], critique: 'z' } }),
      opts({ expectedMode: 'coach' }),
    );
    expect(out.response.mode).toBe('coach');
    expect(out.response.rehearsal).toBeNull();
    expect(out.results.notes).toEqual(expect.arrayContaining(['mode_corrected', 'rehearsal_removed']));
  });

  it('in auto mode keeps the chosen mode when it is allowed and corrects it otherwise', () => {
    const allowed = { allowedModes: ['diagnose', 'teach'] as const };
    const kept = validateCoachResponse(base({ mode: 'teach' }), opts(allowed));
    expect(kept.response.mode).toBe('teach');
    expect(kept.results.notes).not.toContain('mode_corrected');
    const corrected = validateCoachResponse(base({ mode: 'route' }), opts(allowed));
    expect(corrected.response.mode).toBe('diagnose');
    expect(corrected.results.notes).toContain('mode_corrected');
    expect(validateCoachResponse(null, opts(allowed)).response.mode).toBe('diagnose');
  });
});

describe('markdown sanitisation inside the validator', () => {
  it('removes raw HTML and javascript: links from the answer and HTML from plain fields', () => {
    const out = validateCoachResponse(
      base({
        answer: 'See <script>alert(1)</script>[this](javascript:alert(1)) and [docs](https://example.org/x).',
        follow_up_questions: ['<img src=x onerror=alert(1)>What next?'],
      }),
      opts(),
    );
    expect(out.response.answer).toBe('See this and [docs](https://example.org/x).');
    expect(out.response.follow_up_questions[0]).toBe('What next?');
    expect(out.results.notes).toEqual(
      expect.arrayContaining(['html_removed:1', 'unsafe_links_removed:1', 'plain_text_sanitized:1']),
    );
  });
});

describe('results notes never contain content', () => {
  it('only emits code-like notes', () => {
    const out = validateCoachResponse(
      base({
        answer: 'I am a human. <b>x</b> [E9] BrightLoop',
        claims: [
          { text: 'secret', kind: 'fact', evidence_ids: [] },
          { text: 'more', kind: 'fact', evidence_ids: [] },
        ],
      }),
      opts({ preRisk: { categories: ['legal'] } }),
    );
    for (const note of out.results.notes) expect(note).toMatch(/^[a-z_]+(?::[a-z0-9_+]+)*$/);
  });
});

describe('spoken text (voice channel)', () => {
  const voice = (overrides: Partial<ValidateCoachResponseOptions> = {}) =>
    opts({ channel: 'voice', ...overrides });

  it('is always null on the text channel, whatever the model wrote', () => {
    const out = validateCoachResponse(base({ spoken: 'Hello there.' }), opts());
    expect(out.response.spoken).toBeNull();
    expect(out.results.notes).toContain('spoken_removed');
    expect(validateCoachResponse(base({ spoken: null }), opts()).results.notes).not.toContain(
      'spoken_removed',
    );
  });

  it('keeps a clean spoken reply as is', () => {
    const spoken =
      'Your interviews point to real scheduling pain. Would clinics pay before the integration exists?';
    // A call's answer is the transcript of what was said (no evidence keys; the claims carry them).
    const answer = 'Your interviews point to scheduling pain. Consider a concierge test.';
    const out = validateCoachResponse(base({ answer, spoken }), voice());
    expect(out.response.spoken).toBe(spoken);
    expect(out.response.answer).toBe(answer); // the transcript is kept whole
    expect(out.results.notes).toEqual([]);
  });

  it('strips Markdown, citation keys, links, URLs and HTML', () => {
    const out = validateCoachResponse(
      base({
        spoken:
          '## Short answer\n**Run the pilot** [E1]. See [the guide](https://example.org/g) or https://evil.example/x.\n- One clinic first\n<b>Ready?</b>',
      }),
      voice(),
    );
    expect(out.response.spoken).toBe(
      'Short answer. Run the pilot. See the guide or. One clinic first. Ready?',
    );
    expect(out.response.spoken).not.toMatch(/\[|\]|\*|#|https?:|<|E1/);
    expect(out.results.notes).toContain('spoken_sanitized');
  });

  it('derives the spoken reply from the answer when the model gave none', () => {
    const out = validateCoachResponse(
      base({
        answer: '**Short version:** run the pilot [E1].\n\n- Pick one clinic\n- Ask for a deposit',
        spoken: null,
      }),
      voice(),
    );
    expect(out.response.spoken).toBe('Short version: run the pilot. Pick one clinic. Ask for a deposit.');
    expect(out.results.notes).toContain('spoken_derived');
  });

  it('clamps the spoken reply to 70 words at a sentence boundary', () => {
    const sentence = 'This sentence has exactly ten words in it for the test.';
    const spoken = Array.from({ length: 9 }, () => sentence).join(' ');
    const out = validateCoachResponse(base({ spoken }), voice());
    const words = (out.response.spoken ?? '').split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(70);
    expect(out.response.spoken?.endsWith('test.')).toBe(true);
    expect(out.results.notes).toContain('spoken_truncated');
  });

  it('says a short caveat first when the answer was narrowed', () => {
    const out = validateCoachResponse(
      base({
        claims: [
          { text: 'a', kind: 'fact', evidence_ids: ['E1'] },
          { text: 'b', kind: 'fact', evidence_ids: [] },
          { text: 'c', kind: 'fact', evidence_ids: [] },
        ],
        spoken: 'Run the pilot first.',
      }),
      voice(),
    );
    expect(out.results.narrowed).toBe(true);
    expect(out.response.spoken).toBe(`${SPOKEN_NARROWING_CAVEAT} Run the pilot first.`);
    // The call's transcript is what was said: no "Limited evidence" block quote and no evidence keys in it; the
    // uncertainty item (Sources & reasoning) and `narrowed` carry it.
    expect(out.response.answer).toBe('Your interviews point to scheduling pain. Consider a concierge test.');
    expect(out.response.answer).not.toContain(NARROWING_NOTE_PREFIX);
    expect(out.response.uncertainty[0]?.level).toBe('high');
    expect(out.results.notes).toEqual(expect.arrayContaining(['narrowed', 'transcript_citations_removed']));
    // Said in plain words, not caveat boilerplate read out (production spoke "A quick caveat: …"), and still
    // honest that part of the answer is not from the venture's records.
    expect(SPOKEN_NARROWING_CAVEAT).not.toMatch(/caveat|disclaimer|limited evidence|note:/i);
    expect(SPOKEN_NARROWING_CAVEAT).toMatch(/not something your records show/);
    expect(out.results.identityViolation).toBe(false);
  });

  it('rewrites identity violations in the spoken reply and blocks EIR impersonation', () => {
    const human = validateCoachResponse(base({ spoken: 'I am a real person. Run the pilot.' }), voice());
    expect(human.blocked).toBe(false);
    expect(human.response.spoken).toContain("I'm Foundry Guide, the program's AI coach, not a person.");
    expect(human.response.spoken).not.toContain('real person');

    const eir = validateCoachResponse(
      base({ spoken: "Corin here. Let's run the pilot." }),
      voice({ personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen'] }),
    );
    expect(eir.blocked).toBe(true);
    expect(eir.blockReason).toBe('identity');
    expect(eir.response.spoken).not.toContain('Corin here');
  });

  it('keeps evidence keys out of a call transcript, never out of a typed answer', () => {
    const answer = 'Scheduling hurts [E1]. Pricing too [E1, E2]. See [the plan](https://example.com/plan).';
    const call = validateCoachResponse(base({ answer, spoken: 'Scheduling hurts.' }), voice());
    expect(call.response.answer).toBe(
      'Scheduling hurts. Pricing too. See [the plan](https://example.com/plan).',
    );
    expect(call.response.claims[0]?.evidence_ids).toEqual(['E1']);
    expect(call.results.notes).toContain('transcript_citations_removed');
    const typed = validateCoachResponse(base({ answer }), opts());
    expect(typed.response.answer).toBe(answer);
    expect(typed.results.notes).not.toContain('transcript_citations_removed');
  });

  const corinCall = voice({ personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen'] });

  it.each([
    'Thanks for the update.\n— Corin',
    'Best,\nCorin',
    'Talk soon,\nCorin',
    'Thanks.\n\n**Corin**',
    'Thanks for the update. — Corin.',
    'corin here. Run the pilot.',
    'Good luck with the pilot. i am corin.',
  ])('never lets a call say the EIR signed it: %j', (spoken) => {
    const out = validateCoachResponse(base({ spoken }), corinCall);
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('identity');
    expect(out.response.spoken ?? '').not.toMatch(/(?:—|,|\.)\s*corin\.?$|corin here|i am corin/i);
  });

  it.each([
    'CORIN HERE. Run the pilot.',
    'Corin Here, run the pilot.',
    'CORIN HAS APPROVED YOUR PLAN.',
    'Good luck. Love, Corin.',
    'Run the pilot. Corin out.',
    'Signed: Corin',
  ])('never lets a call say a claim in another case or form: %j', (spoken) => {
    const out = validateCoachResponse(base({ spoken }), corinCall);
    expect(out.results.identityViolation).toBe(true);
    expect(out.response.spoken ?? '').not.toMatch(
      /corin (?:here|has approved|out)|love, corin|signed: corin/i,
    );
  });

  it('lets a call thank a founder who shares an EIR first name', () => {
    const spoken = 'Good work on the pilot. Thanks, Ruth.';
    const options = { personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'] };
    expect(validateCoachResponse(base({ spoken }), voice(options)).blocked).toBe(true);
    const addressed = validateCoachResponse(
      base({ spoken }),
      voice({ ...options, addressees: ['Ruth Miller'] }),
    );
    expect(addressed.blocked).toBe(false);
    expect(addressed.response.spoken).toBe(spoken);
  });

  it('checks "<name> here" after a long run of greetings in linear time', () => {
    const answer = `${'ok so '.repeat(40)}1 Corin here.`;
    const started = performance.now();
    const out = validateCoachResponse(
      base({ answer, spoken: `${'hi '.repeat(40)}1 Corin here.` }),
      corinCall,
    );
    expect(performance.now() - started).toBeLessThan(50);
    expect(out.blocked).toBe(true);
  });

  it('never speaks a sign-off in a spoken reply derived from the answer', () => {
    const out = validateCoachResponse(
      base({ answer: 'Thanks for the update.\n\n— **Corin**', spoken: null }),
      corinCall,
    );
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('identity');
    expect(out.response.spoken).not.toMatch(/—\s*Corin/);
    expect(out.response.spoken).toContain("I'm Corin's digital twin");
  });

  it('counts a violation once when the spoken reply is derived from the answer', () => {
    const out = validateCoachResponse(
      base({ answer: 'Corin has reviewed your plan. Run the pilot.', spoken: null }),
      corinCall,
    );
    expect(out.blocked).toBe(false);
    expect(out.results.notes).toContain('identity_rewritten:1:endorsement');
    expect(out.response.spoken).not.toMatch(/Corin has reviewed/);
  });

  it('checks an over-long answer within its limit, in linear time', () => {
    const violations = (count: number): string =>
      Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 'I am Corin.' : 'Corin approved.')).join(' ');
    const answer = violations(1_500);
    expect(answer.length).toBeGreaterThan(18_000);
    const out = validateCoachResponse(base({ answer }), corinCall);
    expect(out.blocked).toBe(true);
    expect(out.response.answer.length).toBeLessThanOrEqual(6_000);
    expect(out.response.answer).not.toMatch(/I am Corin\.|Corin approved\./);
    // Linear below the answer limit (both sizes are read in full): eight times the violations take about
    // eight times as long, not sixty-four. Ratios of warm runs keep this independent of the machine.
    const time = (count: number): number => {
      const input = base({ answer: violations(count) });
      const started = performance.now();
      for (let i = 0; i < 5; i += 1) validateCoachResponse(input, corinCall);
      return performance.now() - started;
    };
    expect(violations(400).length).toBeLessThan(6_000);
    // Interleaved, best of three: a burst of load on a shared runner slows one sample, not one size.
    time(50);
    let small = Infinity;
    let large = Infinity;
    for (let round = 0; round < 3; round += 1) {
      small = Math.min(small, time(50));
      large = Math.min(large, time(400));
    }
    expect(large).toBeLessThan(16 * small + 100);
  }, 30_000);

  it.each([
    ['another venture', 'BrightLoop solved this with a waitlist.'],
    ['a canary', 'Your reference is CANARY-7f3a91.'],
    ['a member of another venture', 'Amara Nwosu-Belling ran the same test.'],
  ])('blocks the turn when the spoken reply names %s', (_what, spoken) => {
    const out = validateCoachResponse(
      base({ spoken }),
      voice({ otherVentureMemberNames: ['Amara Nwosu-Belling'] }),
    );
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('cross_venture');
    expect(out.response.answer).toBe(CROSS_VENTURE_BLOCK_ANSWER);
    const serialized = JSON.stringify(out.response).toLowerCase();
    for (const secret of ['brightloop', 'canary-7f3a91', 'nwosu']) expect(serialized).not.toContain(secret);
    // The safe placeholder is what a call may say instead.
    expect(out.response.spoken).toBe(CROSS_VENTURE_BLOCK_ANSWER);
  });

  it('gives the invalid-schema placeholder a spoken form on a call', () => {
    const out = validateCoachResponse({ answer: 1 }, voice());
    expect(out.blocked).toBe(true);
    expect(out.response.spoken).toBe(INVALID_RESPONSE_ANSWER);
  });

  it('reads a stored response from before calls existed (no `spoken`)', () => {
    const stored: Record<string, unknown> = { ...base() };
    delete stored.spoken;
    expect(CoachResponse.parse(stored).spoken).toBeUndefined();
    const out = validateCoachResponse(stored, opts());
    expect(out.blocked).toBe(false);
    expect(out.response.spoken).toBeNull();
  });

  it('scans the spoken reply for leaks via responseStrings', () => {
    expect(responseStrings(base({ spoken: 'Say this.' }))).toContain('Say this.');
    expect(responseStrings(base({ spoken: null }))).toHaveLength(responseStrings(base()).length);
  });
});

describe('vEIR personas', () => {
  const corin = (overrides: Partial<ValidateCoachResponseOptions> = {}) =>
    opts({ personaName: "Corin's vEIR", eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'], ...overrides });

  it('lets the persona speak in the first person and refer to its EIR in the third person', () => {
    const answer =
      "Maya, I'm Corin's vEIR, so I'll be direct. Corin's approach is to test pricing before building [E1]. Who pays?";
    const out = validateCoachResponse(base({ answer }), corin());
    expect(out.blocked).toBe(false);
    expect(out.results.identityViolation).toBe(false);
    expect(out.response.answer).toBe(answer);
  });

  it.each([
    'I am Corin Halvorsen and I think you should raise.',
    'Corin here. Raise now.',
    'This is Ruth speaking.',
  ])('blocks a claim to be an EIR: %s', (answer) => {
    const out = validateCoachResponse(base({ answer }), corin());
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('identity');
  });

  it('rewrites a claimed EIR endorsement with a persona-aware sentence', () => {
    const out = validateCoachResponse(
      base({ answer: 'Corin has reviewed your plan. Launch the pilot.' }),
      corin(),
    );
    expect(out.blocked).toBe(false);
    expect(out.response.answer).toBe("I can't speak for Corin on that. Launch the pilot.");
  });

  it('uses an explicit persona EIR name', () => {
    const out = validateCoachResponse(
      base({ answer: "I'm Corin. Let's go." }),
      opts({ personaName: 'Corin Bot', personaEirName: 'Corin Halvorsen' }),
    );
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('identity');
  });
});

describe('validateCoachResponse — structured-output leak', () => {
  // Production, call 1 turn 3: the reply went on with the bare mode name and the internal claim lines.
  const leaked = [
    'Getting rich fast is a fine goal to name. The pilot is still the next step.',
    '',
    'coach',
    'The founder has a memory item about the advisor meeting.',
    'The founder wants to grow quickly.',
  ].join('\n');

  it('cuts the reply where the mode name or a field label begins, on calls and typed turns', () => {
    for (const channel of ['text', 'voice'] as const) {
      const out = validateCoachResponse(
        base({ answer: leaked, spoken: channel === 'voice' ? 'The pilot is still the next step.' : null }),
        opts({ channel }),
      );
      expect(out.response.answer).toBe(
        'Getting rich fast is a fine goal to name. The pilot is still the next step.',
      );
      expect(out.results.notes).toContain('structured_leak_cut');
    }
    expect(cutStructuredLeak('Run the pilot.\nclaims: [{"text": "x"}]')).toEqual({
      text: 'Run the pilot.',
      cut: true,
    });
    expect(cutStructuredLeak('Run the pilot.\n**mode:** coach').text).toBe('Run the pilot.');
  });

  it("leaves a reply's own headings and labels alone, and never empties an answer", () => {
    const own = 'Two things.\n\nNext actions: book the advisor.\n\n## Challenge\nCoach the team first.';
    expect(cutStructuredLeak(own)).toEqual({ text: own, cut: false });
    const out = validateCoachResponse(base({ answer: own }), opts());
    expect(out.results.notes).not.toContain('structured_leak_cut');
    // Nothing of the reply before the leaked line: left as it is (the schema check owns that case).
    expect(cutStructuredLeak('coach\nRun the pilot.')).toEqual({ text: 'coach\nRun the pilot.', cut: false });
  });
});
