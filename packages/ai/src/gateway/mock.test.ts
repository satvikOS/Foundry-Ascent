import { CoachResponse, DEFAULT_DISCLOSURE, type EvidenceItem, type RiskCategory } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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
import { MOCK_FALLBACK_MODEL_ID, MOCK_MODEL_ID, MockModelGateway } from './mock.js';

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
    expect(a.value.memory_candidates[0]?.content).toContain('How should we price the pilot?');
    expect(a.value.escalation.required).toBe(false);
    expect(a.value.mode).toBe('coach');
    expect(a.value.rehearsal).toBeNull();
  });

  it('varies with the founder text', async () => {
    const gw = new MockModelGateway();
    const a = await gw.generateStructured(turn({ text: 'one' }));
    const b = await gw.generateStructured(turn({ text: 'two' }));
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
