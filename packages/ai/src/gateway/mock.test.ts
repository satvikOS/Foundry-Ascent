import {
  CoachResponse,
  DEFAULT_DISCLOSURE,
  type CoachMode,
  type EvidenceItem,
  type RiskCategory,
} from '@foundry/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildDistillPrompt } from '../distill/prompt.js';
import { sanitizeDistill } from '../distill/sanitize.js';
import { DISTILL_SCHEMA_NAME, DistillDraft } from '../distill/schema.js';
import {
  buildEvidenceBlock,
  buildMessages,
  buildSystemPrompt,
  COACH_RESPONSE_SCHEMA_NAME,
  type PromptRelease,
} from '../prompts/index.js';
import { validateCoachResponse } from '../validators/coach-response.js';
import { ModelOutputInvalidError, ModelRefusalError, ModelUnavailableError } from './errors.js';
import { cosineSimilarity, hashEmbedding } from './hash-embedding.js';
import { lowerFirst, MOCK_FALLBACK_MODEL_ID, MOCK_MODEL_ID, MockModelGateway } from './mock.js';
import { BANK_PROPER_NOUNS } from './mock-content.js';

const RELEASE: PromptRelease = {
  version: 1,
  disclosureText: DEFAULT_DISCLOSURE,
  doctrine: {
    summary: 'Evidence-first venture coaching.',
    frameworks: [],
    evidenceStandard: 'Direct customer evidence.',
    typicalQuestions: [],
    redLines: [],
    escalationTopics: [],
    referralDestinations: [],
    teachingPrinciples: [],
  },
  style: {
    directness: 'balanced',
    warmth: 'warm',
    pace: 'measured',
    vocabulary: [],
    feedbackStructure: 'Observe, ask, suggest.',
    avoid: [],
  },
};

function evidence(key: string): EvidenceItem {
  return {
    key,
    kind: 'memory',
    refId: '00000000-0000-4000-8000-000000000001',
    title: `Item ${key}`,
    excerpt: `Excerpt for ${key}`,
    score: 0.8,
    freshnessAt: null,
    status: 'confirmed',
  };
}

function turn(options: {
  mode?: 'coach' | 'rehearse';
  risk?: RiskCategory[];
  evidence?: EvidenceItem[];
  text?: string;
  counterpart?: string;
}) {
  const system = buildSystemPrompt({
    release: RELEASE,
    mode: options.mode ?? 'coach',
    policy: { riskCategories: options.risk ?? [], groundingThreshold: 0.6 },
    ventureContext: { name: 'Acme', stage: 'discovery', domain: 'software', currentGoal: null },
    rehearsalCounterpart: options.counterpart ?? null,
    today: '2026-10-05',
  });
  const messages = buildMessages([], options.text ?? 'How should we price the pilot?', {
    evidenceBlock: buildEvidenceBlock(options.evidence ?? [evidence('E1'), evidence('E2'), evidence('E3')]),
  });
  return {
    purpose: 'turn' as const,
    system,
    messages,
    schemaName: COACH_RESPONSE_SCHEMA_NAME,
    zodSchema: CoachResponse,
    requestId: 'req-mock',
  };
}

describe('MockModelGateway.generateStructured', () => {
  it('produces a schema-valid, deterministic CoachResponse derived from the prompt', async () => {
    const gw = new MockModelGateway();
    const a = await gw.generateStructured(turn({}));
    const b = await gw.generateStructured(turn({}));
    expect(CoachResponse.parse(a.value)).toEqual(a.value);
    expect(a.value).toEqual(b.value);
    expect(a.modelId).toBe(MOCK_MODEL_ID);
    expect(a.fallbackUsed).toBe(false);
    expect(a.costUsd).toBe(0);
    expect(a.usage.inputTokens).toBeGreaterThan(0);

    const fact = a.value.claims.find((c) => c.kind === 'fact');
    expect(fact?.evidence_ids).toEqual(['E1', 'E2']);
    expect(a.value.memory_candidates).toHaveLength(1);
    expect(a.value.memory_candidates[0]?.content).not.toContain('How should we price the pilot?');
    expect(a.value.escalation.required).toBe(false);
    expect(a.value.mode).toBe('coach');
    expect(a.value.rehearsal).toBeNull();
  });

  it('varies with the founder text', async () => {
    const gw = new MockModelGateway();
    const a = await gw.generateStructured(turn({ text: 'What should we try first?' }));
    const b = await gw.generateStructured(turn({ text: 'What should we do this week?' }));
    expect(a.value.answer).not.toBe(b.value.answer);
  });

  it('makes no fact claims without evidence', async () => {
    const gw = new MockModelGateway();
    const result = await gw.generateStructured(turn({ evidence: [] }));
    expect(result.value.claims.some((c) => c.kind === 'fact')).toBe(false);
  });

  it.each([
    [['legal'], 'legal', 'P1'],
    [['medical_regulatory', 'ip_licensing'], 'medical_regulatory', 'P1'],
    [['safety_wellbeing'], 'safety_wellbeing', 'P1'],
  ] as const)('escalates when the system prompt flags %j', async (risk, category, priority) => {
    const gw = new MockModelGateway();
    const result = await gw.generateStructured(turn({ risk: [...risk] }));
    expect(result.value.escalation).toMatchObject({ required: true, category, priority });
  });

  it('does not escalate for injection-only flags', async () => {
    const gw = new MockModelGateway();
    const result = await gw.generateStructured(turn({ risk: ['prompt_injection'] }));
    expect(result.value.escalation.required).toBe(false);
  });

  it('fills a rehearsal block in rehearse mode using the named counterpart', async () => {
    const gw = new MockModelGateway();
    const result = await gw.generateStructured(turn({ mode: 'rehearse', counterpart: 'a hospital CFO' }));
    expect(result.value.mode).toBe('rehearse');
    expect(result.value.rehearsal?.counterpart).toBe('a hospital CFO');
    expect(result.value.rehearsal?.scores.length).toBeGreaterThan(0);
  });

  it('passes the deterministic validator without being blocked', async () => {
    const gw = new MockModelGateway();
    const result = await gw.generateStructured(turn({ risk: ['legal'] }));
    const validated = validateCoachResponse(result.value, {
      evidenceKeys: new Set(['E1', 'E2', 'E3']),
      preRisk: { categories: ['legal'] },
      otherVentureNames: ['Other Venture'],
      otherVentureCanaries: ['CANARY-abcdef'],
      personaName: 'Foundry Guide',
      coverageThreshold: 0.6,
      expectedMode: 'coach',
    });
    expect(validated.blocked).toBe(false);
    expect(validated.results.escalationForced).toBe(false);
    expect(validated.results.groundingCoverage).toBe(1);
  });

  it('builds schema-valid values for arbitrary schemas', async () => {
    const Schema = z.object({
      id: z.uuid(),
      at: z.iso.datetime(),
      title: z.string().min(10),
      n: z.number().min(2).max(4),
      count: z.number().int().min(3),
      kind: z.enum(['x', 'y']),
      tags: z.array(z.string()),
      nested: z.object({ ok: z.boolean(), maybe: z.string().nullable() }),
      optional: z.string().optional(),
    });
    const gw = new MockModelGateway();
    const result = await gw.generateStructured({ ...turn({}), schemaName: 'Generic', zodSchema: Schema });
    expect(Schema.parse(result.value)).toEqual(result.value);
  });

  it('uses fixtures by schema name', async () => {
    const gw = new MockModelGateway({ fixtures: { Generic: (ctx) => ({ echo: ctx.founderText }) } });
    const result = await gw.generateStructured({
      ...turn({ text: 'hi there' }),
      schemaName: 'Generic',
      zodSchema: z.object({ echo: z.string() }),
    });
    expect(result.value).toEqual({ echo: 'hi there' });
  });

  it('rejects fixtures that violate the schema', async () => {
    const gw = new MockModelGateway({ fixtures: { Generic: () => ({ echo: 1 }) } });
    await expect(
      gw.generateStructured({
        ...turn({}),
        schemaName: 'Generic',
        zodSchema: z.object({ echo: z.string() }),
      }),
    ).rejects.toBeInstanceOf(ModelOutputInvalidError);
  });

  it('can be scripted to fail or to report a fallback', async () => {
    const gw = new MockModelGateway();
    gw.scriptNext('unavailable', 'timeout', 'refusal', 'invalid_output', 'fallback');
    await expect(gw.generateStructured(turn({}))).rejects.toBeInstanceOf(ModelUnavailableError);
    const timeout = (await gw.generateStructured(turn({})).catch((e: unknown) => e)) as ModelUnavailableError;
    expect(timeout.reason).toBe('timeout');
    expect(timeout.attempts).toHaveLength(1);
    await expect(gw.generateStructured(turn({}))).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(gw.generateStructured(turn({}))).rejects.toBeInstanceOf(ModelOutputInvalidError);
    const fallback = await gw.generateStructured(turn({}));
    expect(fallback.fallbackUsed).toBe(true);
    expect(fallback.modelId).toBe(MOCK_FALLBACK_MODEL_ID);
    expect(fallback.attempts).toHaveLength(2);
    const normal = await gw.generateStructured(turn({}));
    expect(normal.fallbackUsed).toBe(false);
  });

  it('honours an already-aborted signal', async () => {
    const gw = new MockModelGateway();
    const controller = new AbortController();
    controller.abort();
    const error = (await gw
      .generateStructured({ ...turn({}), signal: controller.signal })
      .catch((e: unknown) => e)) as ModelUnavailableError;
    expect(error.reason).toBe('aborted');
  });

  it('records calls (identifiers and counts only)', async () => {
    const gw = new MockModelGateway();
    await gw.generateStructured(turn({}));
    await gw.embed(['a', 'b'], { purpose: 'ingestion', requestId: 'r2' });
    expect(gw.calls).toEqual([
      {
        kind: 'generate',
        purpose: 'turn',
        requestId: 'req-mock',
        schemaName: COACH_RESPONSE_SCHEMA_NAME,
        count: 1,
      },
      { kind: 'embed', purpose: 'ingestion', requestId: 'r2', schemaName: null, count: 2 },
    ]);
  });
});

describe('mock conversation realism', () => {
  const veirRelease: PromptRelease = {
    ...RELEASE,
    personaName: "Corin's vEIR",
    eirName: 'Corin Halvorsen',
    doctrine: { ...RELEASE.doctrine, summary: 'Customer evidence before building. Talk to buyers early.' },
    style: { ...RELEASE.style, directness: 'direct' },
  };
  const continuity = {
    founderFirstName: 'Maya',
    notebook: {
      summary: 'Maya is testing exam-week demand.',
      founderProfile: [],
      commitments: [
        {
          id: 'cm-1',
          text: 'Interview five library staff',
          due: '2026-10-10',
          status: 'open' as const,
          sourceSessionId: null,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      openQuestions: [],
      lastAdvice: [],
      nextOpener: null,
      updatedAt: '2026-10-08T00:00:00.000Z',
    },
  };

  function veirTurn(options: {
    text: string;
    mode?: CoachMode;
    channel?: 'text' | 'voice';
    history?: { founderText: string; answer: string }[];
    withNotes?: boolean;
    evidence?: EvidenceItem[];
  }) {
    const system = buildSystemPrompt({
      release: veirRelease,
      mode: options.mode ?? 'coach',
      policy: { riskCategories: [], groundingThreshold: 0.6 },
      ventureContext: { name: 'Acme', stage: 'discovery', domain: 'software', currentGoal: null },
      today: '2026-10-16',
      channel: options.channel ?? 'text',
      continuity,
    });
    const messages = buildMessages(options.history ?? [], options.text, {
      evidenceBlock: buildEvidenceBlock(options.evidence ?? [evidence('E1'), evidence('E2')]),
      continuity: options.withNotes === false ? null : continuity,
      today: '2026-10-16',
    });
    return { ...turn({}), system, messages };
  }

  const validate = (value: unknown, channel: 'text' | 'voice' = 'text') =>
    validateCoachResponse(value, {
      evidenceKeys: new Set(['E1', 'E2']),
      preRisk: { categories: [] },
      otherVentureNames: ['Other Venture'],
      otherVentureCanaries: ['CANARY-abcdef'],
      personaName: "Corin's vEIR",
      eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'],
      coverageThreshold: 0.6,
      channel,
    });

  it('talks like the persona: the founder’s name, the EIR in the third person, cited evidence, one closing question', async () => {
    const gw = new MockModelGateway();
    const { value } = await gw.generateStructured(
      veirTurn({ text: 'How should we price the library pilot?' }),
    );
    expect(value.answer).not.toMatch(/mock/i);
    expect(value.answer).toContain('Maya');
    expect(value.answer).toContain("Corin's approach comes down to this: customer evidence before building.");
    expect(value.answer).toMatch(/\[E1\]/);
    expect(value.answer).not.toMatch(/^#/m);
    const paragraphs = value.answer.split('\n\n');
    expect(paragraphs.at(-1)?.trim().endsWith('?')).toBe(true);
    expect(value.answer.match(/\?/g)).toHaveLength(1);
    // Typed turns have nothing to say aloud (the strict schema's null arrives as an absent field).
    expect(value.spoken ?? null).toBeNull();

    const checked = validate(value);
    expect(checked.blocked).toBe(false);
    expect(checked.results.identityViolation).toBe(false);
    expect(checked.response.answer).toBe(value.answer);
  });

  it('says a doctrine that already names the approach only once', async () => {
    // The matrix recording: "Ruth's approach comes down to this: Ruth's approach: research and hardware…".
    const named: PromptRelease = {
      ...veirRelease,
      doctrine: { ...veirRelease.doctrine, summary: "Corin's approach: customer evidence before building." },
    };
    const system = buildSystemPrompt({
      release: named,
      mode: 'coach',
      policy: { riskCategories: [], groundingThreshold: 0.6 },
      ventureContext: { name: 'Acme', stage: 'discovery', domain: 'software', currentGoal: null },
      today: '2026-10-16',
      continuity,
    });
    const base = veirTurn({ text: 'How should we price the library pilot?' });
    const { value } = await new MockModelGateway().generateStructured({ ...base, system });
    expect(value.answer).toContain("Corin's approach comes down to this: customer evidence before building.");
    expect(value.answer).not.toMatch(/approach comes down to this: Corin's approach/i);
  });

  it('never presents the notebook’s older lines as "last time" (production recited a seeded notebook)', async () => {
    const gw = new MockModelGateway();
    const first = await gw.generateStructured(veirTurn({ text: 'Where should we focus this week?' }));
    expect(first.value.answer).not.toMatch(/last time/i);
    expect(first.value.answer).not.toContain('interview five library staff');
    const later = await gw.generateStructured(
      veirTurn({
        text: 'Where should we focus this week?',
        history: [{ founderText: 'Hi', answer: 'Hello Maya.' }],
      }),
    );
    expect(later.value.answer).not.toContain('Last time you planned');
  });

  it('proposes a realistic memory candidate, never the founder’s question quoted back', async () => {
    const gw = new MockModelGateway();
    const { value } = await gw.generateStructured(
      veirTurn({ text: 'How should we price the library pilot?' }),
    );
    const [memory] = value.memory_candidates;
    expect(memory?.title).toBe('Pricing still to be tested with real buyers');
    expect(memory?.title).not.toMatch(/[0-9a-f]{8}/);
    expect(memory?.content).toBe('Willingness to pay has not been tested with a paid commitment yet.');
    expect(memory?.content).not.toMatch(/asked|library pilot/i);
  });

  it('varies by topic and mode, deterministically', async () => {
    const gw = new MockModelGateway();
    const answers = new Set<string>();
    for (const text of [
      'How should we price it?',
      'Should we raise a seed round now?',
      'How do we design the pilot?',
      'What should I ask in customer interviews?',
      'How should my co-founder and I split roles?',
    ]) {
      for (const mode of ['diagnose', 'coach', 'teach'] as const) {
        const a = await gw.generateStructured(veirTurn({ text, mode }));
        const b = await gw.generateStructured(veirTurn({ text, mode }));
        expect(a.value).toEqual(b.value);
        expect(validate(a.value).blocked).toBe(false);
        answers.add(a.value.answer);
      }
    }
    expect(answers.size).toBe(15);
  });

  it('gives a short, plain spoken reply on a call', async () => {
    const gw = new MockModelGateway();
    const { value } = await gw.generateStructured(
      veirTurn({ text: 'How should we price the library pilot?', channel: 'voice' }),
    );
    expect(value.spoken).toBeTruthy();
    expect((value.spoken ?? '').split(/\s+/).length).toBeLessThanOrEqual(70);
    expect(value.spoken).not.toMatch(/\[E\d+\]|\*|#|\n/);
    // The first reply of a conversation says hello first, by name.
    expect(value.spoken).toMatch(
      /^(?:Hi Maya|Hello Maya|Welcome back, Maya|Hey Maya|Good to have you back, Maya)/,
    );
    const checked = validate(value, 'voice');
    expect(checked.blocked).toBe(false);
    expect(checked.response.spoken).toBe(value.spoken);
  });

  it('chooses a mode within the allowed modes in auto mode', async () => {
    const gw = new MockModelGateway();
    const auto = (text: string, allowedModes: CoachMode[]) => {
      const request = veirTurn({ text });
      return gw.generateStructured({
        ...request,
        system: buildSystemPrompt({
          release: veirRelease,
          mode: 'auto',
          allowedModes,
          policy: { riskCategories: [], groundingThreshold: 0.6 },
          ventureContext: { name: 'Acme', stage: 'discovery', domain: 'software', currentGoal: null },
          today: '2026-10-16',
        }),
      });
    };
    const all: CoachMode[] = ['diagnose', 'challenge', 'coach', 'teach', 'route'];
    expect((await auto('What is a riskiest assumption?', all)).value.mode).toBe('teach');
    expect((await auto('Should we launch in two libraries or one?', all)).value.mode).toBe('coach');
    expect((await auto('Poke holes in our pricing plan.', all)).value.mode).toBe('challenge');
    expect((await auto('Are there resources for hardware founders?', all)).value.mode).toBe('route');
    expect((await auto('Our usage dropped last week.', all)).value.mode).toBe('diagnose');
    expect((await auto('What is a riskiest assumption?', ['coach'])).value.mode).toBe('coach');
  });

  it('recommends resources by title in route mode', async () => {
    const gw = new MockModelGateway();
    const resource: EvidenceItem = {
      ...evidence('E2'),
      kind: 'resource',
      title: 'Customer discovery clinic',
    };
    const { value } = await gw.generateStructured(
      veirTurn({
        text: 'Is there a program resource for this?',
        mode: 'route',
        evidence: [evidence('E1'), resource],
      }),
    );
    expect(value.answer).toContain('Customer discovery clinic [E2] looks like the best fit');
    expect(value.challenge).toBeNull();
  });

  it('continues a sentence without lower-casing "I", acronyms or names', async () => {
    const gw = new MockModelGateway();
    const answers: string[] = [];
    // Later turns open with the persona's lead-in now and then, after the founder's name on every other seed.
    for (let n = 0; n < 60; n += 1) {
      const { value } = await gw.generateStructured(
        veirTurn({
          text: `What should we try next with the library, take ${String(n)}?`,
          history: [{ founderText: 'Hi', answer: 'Hello Maya.' }],
        }),
      );
      answers.push(value.answer);
    }
    expect(answers.some((answer) => answer.startsWith("Maya, I'll be direct."))).toBe(true);
    expect(answers.some((answer) => answer.startsWith('Maya, straight answer first.'))).toBe(true);
    for (const answer of answers) {
      expect(answer).not.toMatch(/(?:^|[\s,])i(?:['’](?:m|ll|d|ve))?\b/u);
    }
  });
});

describe('lowerFirst', () => {
  it('lower-cases an ordinary first word so it continues a sentence', () => {
    expect(lowerFirst("Here's my honest read.")).toBe("here's my honest read.");
    expect(lowerFirst('Customer evidence before building.')).toBe('customer evidence before building.');
    expect(lowerFirst('')).toBe('');
  });

  it('keeps the pronoun "I" and its contractions', () => {
    for (const text of [
      'I think so.',
      "I'm sure.",
      "I'll be direct.",
      "I'd start there.",
      "I've seen this.",
    ]) {
      expect(lowerFirst(text)).toBe(text);
    }
    expect(lowerFirst('I’ll be direct.')).toBe('I’ll be direct.');
    // Only the pronoun: a word that merely starts with I is lowered.
    expect(lowerFirst('Interview five library staff')).toBe('interview five library staff');
    expect(lowerFirst('Its price matters')).toBe('its price matters');
  });

  it('keeps acronyms (second letter upper-case)', () => {
    expect(lowerFirst('MVP scope first')).toBe('MVP scope first');
    expect(lowerFirst('FDA clearance comes later')).toBe('FDA clearance comes later');
    expect(lowerFirst('A narrower first claim')).toBe('a narrower first claim');
  });

  it('keeps proper nouns: the bank’s and the names it is given, possessives included', () => {
    for (const noun of BANK_PROPER_NOUNS) expect(lowerFirst(`${noun} helps`)).toBe(`${noun} helps`);
    expect(lowerFirst('Maya plans the pilot', ['Maya'])).toBe('Maya plans the pilot');
    expect(lowerFirst("Corin's approach is simple", ['Corin'])).toBe("Corin's approach is simple");
    expect(lowerFirst('Quiet Labs pays first', ['Quiet Labs'])).toBe('Quiet Labs pays first');
    expect(lowerFirst('Customer evidence first', ['Maya', 'Acme'])).toBe('customer evidence first');
  });
});

describe('MockModelGateway distillation and recap', () => {
  const RecapDraft = z.object({
    diagnosis: z.object({
      stage: z.string(),
      immediate_constraint: z.string(),
      riskiest_assumption: z.string(),
    }),
    evidence: z.array(z.object({ evidence_key: z.string(), title: z.string(), note: z.string() })),
    challenge: z.string(),
    next_actions: z.array(
      z.object({ owner: z.string(), action: z.string(), target_date: z.string().nullable() }),
    ),
    escalation: CoachResponse.shape.escalation,
    memory_candidates: CoachResponse.shape.memory_candidates,
  });

  function distillRequest(turns: { founderText: string; answer: string }[]) {
    const prompt = buildDistillPrompt({
      personaName: "Corin's vEIR",
      eirName: 'Corin Halvorsen',
      founderFirstName: 'Maya',
      venture: { name: 'Acme', stage: 'discovery', domain: 'software', currentGoal: null },
      turns,
      evidence: [evidence('E1')],
      previousNotebook: {
        summary: 'Earlier summary.',
        founderProfile: [
          {
            id: 'fp-old',
            text: 'Prefers short answers',
            sourceSessionId: null,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        commitments: [
          {
            id: 'cm-old',
            text: 'Interview five library staff',
            due: '2026-10-10',
            status: 'open',
            sourceSessionId: null,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        openQuestions: [],
        lastAdvice: [],
        nextOpener: null,
        updatedAt: '2026-10-08T00:00:00.000Z',
      },
      today: '2026-10-16',
    });
    return {
      purpose: 'distill' as const,
      ...prompt,
      schemaName: DISTILL_SCHEMA_NAME,
      zodSchema: DistillDraft,
      requestId: 'req-distill',
    };
  }

  it('writes a deterministic distillation that carries the previous notebook forward', async () => {
    const gw = new MockModelGateway();
    const turns = [
      { founderText: 'How should we price the library pilot?', answer: 'Ask for a deposit.' },
      { founderText: "OK. We'll ask three libraries for a deposit next week.", answer: 'Good plan.' },
    ];
    const a = await gw.generateStructured(distillRequest(turns));
    const b = await gw.generateStructured(distillRequest(turns));
    expect(a.value).toEqual(b.value);
    const draft = a.value;
    expect(draft.title).toBe('Pricing and willingness to pay');
    expect(draft.digest.summary).toContain('Maya came in to talk about pricing.');
    expect(draft.digest.commitments).toEqual([
      { text: 'Ask three libraries for a deposit next week', due: '2026-10-23' },
    ]);
    expect(draft.notebook.founder_profile.map((e) => e.id)).toContain('fp-old');
    expect(draft.notebook.commitments.map((c) => c.id)).toEqual(['cm-old', null]);
    expect(draft.notebook.next_opener).toBe(
      'Last time you planned to ask three libraries for a deposit next week. How did it go?',
    );
    expect(draft.lesson_candidates).toHaveLength(1);

    const clean = sanitizeDistill(draft, {
      sessionId: '00000000-0000-4000-8000-000000000009',
      now: '2026-10-16T10:00:00.000Z',
      personaName: "Corin's vEIR",
      eirNames: ['Corin Halvorsen'],
      previousNotebook: {
        summary: 'Earlier summary.',
        founderProfile: [
          {
            id: 'fp-old',
            text: 'Prefers short answers',
            sourceSessionId: null,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        commitments: [
          {
            id: 'cm-old',
            text: 'Interview five library staff',
            due: '2026-10-10',
            status: 'open',
            sourceSessionId: null,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        openQuestions: [],
        lastAdvice: [],
        nextOpener: null,
      },
      evidenceKeys: ['E1'],
      otherVentureNames: ['BenchTally'],
      otherVentureCanaries: ['CANARY::benchtally::R4T8Z1HC'],
      lessons: { ventureNames: ['Acme'], personNames: ['Maya Okafor-Lindqvist'], canaries: [] },
    });
    expect(clean).not.toBeNull();
    expect(clean?.lessonCandidates).toHaveLength(1);
    expect(clean?.stats.lessonCandidatesDropped).toBe(0);
    expect(clean?.notebookDelta.commitments.map((c) => c.id)[0]).toBe('cm-old');
  });

  it('remembers one thing at a time: a memory’s title and content say the same thing', async () => {
    const gw = new MockModelGateway();
    // The founder states a plan: the memory is that plan, titled by it (never the topic's title over it, which
    // read in Knowledge as "Pricing still to be tested with real buyers" / "Maya plans to call facilities…").
    const planned = await gw.generateStructured(
      distillRequest([
        { founderText: 'How should we price per library?', answer: 'Ask who holds the budget.' },
        {
          founderText:
            "Facilities holds the budget, I think. I'll call facilities about the library budget tomorrow.",
          answer: 'Good.',
        },
      ]),
    );
    expect(planned.value.memory_candidates).toEqual([
      {
        type: 'action',
        title: 'Call facilities about the library budget',
        content: 'Maya plans to call facilities about the library budget tomorrow.',
        evidence_ids: [],
        confidence: 0.6,
        source: 'founder_stated',
      },
    ]);
    // No plan: the topic's own note, under the topic's own title.
    const topic = await gw.generateStructured(
      distillRequest([
        { founderText: 'How should we price per library?', answer: 'Ask who holds the budget.' },
      ]),
    );
    expect(topic.value.memory_candidates).toMatchObject([
      {
        type: 'hypothesis',
        title: 'Pricing still to be tested with real buyers',
        content: 'Willingness to pay has not been tested with a paid commitment yet.',
      },
    ]);
  });

  it('proposes no lesson after a single exchange', async () => {
    const gw = new MockModelGateway();
    const { value } = await gw.generateStructured(
      distillRequest([{ founderText: 'Quick question about hiring', answer: 'Sure.' }]),
    );
    expect(value.lesson_candidates).toEqual([]);
    expect(value.title).toBe('Team roles and ownership');
  });

  it('writes a realistic recap, and falls back to a schema sample when the recap shape changes', async () => {
    const gw = new MockModelGateway();
    const recap = await gw.generateStructured({
      ...turn({ text: 'How should we design the pilot?' }),
      purpose: 'recap',
      messages: [
        {
          role: 'user',
          content:
            '<venture_context>\n<stage>validation</stage>\n</venture_context>\n\n' +
            buildEvidenceBlock([evidence('E1')]) +
            '\n\n<session_transcript>\n<turn n="1">\n<founder>How should we design the pilot?</founder>\n<coach>Small.</coach>\n</turn>\n</session_transcript>\nToday: 2026-10-16',
        },
      ],
      schemaName: 'SessionRecapDraft',
      zodSchema: RecapDraft,
    });
    expect(recap.value.diagnosis.stage).toBe('Validation');
    expect(recap.value.challenge).toBe('What result from the pilot would convince you that you were wrong?');
    expect(recap.value.evidence).toEqual([
      { evidence_key: 'E1', title: 'Item E1', note: 'The most relevant record for this conversation.' },
    ]);
    expect(recap.value.next_actions[0]?.target_date).toBe('2026-10-23');
    expect(recap.value.memory_candidates).toHaveLength(1);

    const Different = z.object({ summary: z.string().min(5) });
    const sampled = await gw.generateStructured({
      ...turn({}),
      schemaName: 'SessionRecapDraft',
      zodSchema: Different,
    });
    expect(Different.parse(sampled.value)).toEqual(sampled.value);
  });
});

describe('MockModelGateway.embed', () => {
  it('returns deterministic, unit-length, 1024-d vectors', async () => {
    const gw = new MockModelGateway();
    const { vectors, modelId, usage } = await gw.embed(
      ['customer interviews about pricing', 'customer interviews about pricing'],
      { purpose: 'turn' },
    );
    expect(modelId).toBe('mock-embeddings');
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1024);
    expect(vectors[0]).toEqual(vectors[1]);
    const norm = Math.sqrt((vectors[0] ?? []).reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  it('gives related texts higher similarity than unrelated ones', () => {
    const query = hashEmbedding('How should we price our clinic scheduling pilot?');
    const related = hashEmbedding('Pricing experiment for the clinic scheduling pilot');
    const unrelated = hashEmbedding('Battery thermal runaway test results for the drone');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated) + 0.2);
  });

  it('handles text without letters and rejects empty input', async () => {
    const gw = new MockModelGateway();
    const { vectors } = await gw.embed(['!!!'], { purpose: 'turn' });
    expect(Math.sqrt((vectors[0] ?? []).reduce((acc, v) => acc + v * v, 0))).toBeCloseTo(1, 10);
    await expect(gw.embed([''], { purpose: 'turn' })).rejects.toThrow(TypeError);
  });
});
