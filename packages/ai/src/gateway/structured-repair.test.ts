import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { DISTILL_SCHEMA_NAME, DistillDraft } from '../distill/schema.js';
import type { ConverseFn } from './bedrock-runtime.js';
import { COACH_ANNOTATIONS_SCHEMA_NAME, CoachAnnotations } from './coach-annotations.js';
import { Deadline } from './deadline.js';
import { restoreOptionalNulls, toStrictJsonSchema } from './json-schema.js';
import { MAX_REPAIR_OUTPUT_TOKENS, NovaProvider, SUBMIT_TOOL_NAME } from './nova.js';
import { parseStructuredText, validateStructured, type ProviderRequest } from './provider.js';
import { extractJsonValue, repairStructured } from './structured-repair.js';

/**
 * LAB-M6 / LAB-R7: Nova 2 Lite's structured output failed validation on about 25% of first turn attempts and 50%
 * of first distillation attempts, each costing a second call. Each case below is one failure mode a hand-written
 * tool input shows (structured-repair.ts), on the production schemas: it failed before (`raw`), and now passes
 * as the same value, in one call.
 */

const DRAFT: DistillDraft = {
  title: 'Pricing the two-library pilot',
  digest: {
    summary: 'The founder brought the Hartwell pilot pricing. We settled on a per-library fee.',
    topics: ['pilot pricing', 'facilities budget'],
    commitments: [{ text: 'Call facilities about the budget', due: null }],
    open_questions: ['Who signs the purchase order?'],
  },
  notebook: {
    summary: 'Two libraries are interested; pricing per library.',
    founder_profile: [{ id: null, text: 'Prefers short answers with numbers' }],
    commitments: [{ id: null, text: 'Call facilities about the budget', due: null, status: 'open' }],
    open_questions: [{ id: null, text: 'Who signs the purchase order?' }],
    last_advice: [{ id: null, text: 'Price per library, not per seat' }],
    next_opener: 'Last time you planned to call facilities. How did it go?',
    next_topic: 'the facilities budget call you planned',
  },
  memory_candidates: [
    {
      type: 'decision',
      title: 'Price per library',
      content: 'The founder decided to price the pilot per library.',
      evidence_ids: [],
      confidence: 0.8,
      source: 'founder_stated',
    },
  ],
  lesson_candidates: [],
};

const ANNOTATIONS: CoachAnnotations = {
  mode: 'coach',
  claims: [{ text: 'Two libraries are interested.', kind: 'fact', evidence_ids: ['E1'] }],
  uncertainty: [],
  challenge: null,
  next_actions: [{ owner: 'founder', action: 'Call facilities.', target_date: null }],
  escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
  memory_candidates: [],
  follow_up_questions: [],
  rehearsal: null,
};

const clone = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

interface Case {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly expected: unknown;
  readonly input: unknown;
  readonly repair: string;
}

const CASES: readonly Case[] = [
  {
    name: 'a nullable field left out (strict schemas list every property as required)',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: (() => {
      const v = clone(ANNOTATIONS);
      delete v.challenge;
      delete v.rehearsal;
      return v;
    })(),
    repair: 'missing_null:challenge',
  },
  {
    name: 'nested nullable fields left out',
    schema: DistillDraft,
    expected: DRAFT,
    input: (() => {
      const v = clone(DRAFT);
      const digest = v.digest as { commitments: Record<string, unknown>[] };
      delete digest.commitments[0]?.due;
      return v;
    })(),
    repair: 'missing_null:digest.commitments[0].due',
  },
  {
    name: 'the string "null" for a nullable field',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: {
      ...clone(ANNOTATIONS),
      escalation: { ...ANNOTATIONS.escalation, category: 'null', priority: 'NULL' },
    },
    repair: 'null_string:escalation.category',
  },
  {
    name: 'an object written as a JSON string',
    schema: DistillDraft,
    expected: DRAFT,
    input: { ...clone(DRAFT), digest: JSON.stringify(DRAFT.digest) },
    repair: 'json_string:digest',
  },
  {
    name: 'a list written as a JSON string',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: { ...clone(ANNOTATIONS), claims: JSON.stringify(ANNOTATIONS.claims) },
    repair: 'json_string:claims',
  },
  {
    name: 'the whole input as one JSON string',
    schema: DistillDraft,
    expected: DRAFT,
    input: JSON.stringify(DRAFT),
    repair: 'json_string:(root)',
  },
  {
    name: 'the object wrapped in its schema name',
    schema: DistillDraft,
    expected: DRAFT,
    input: { [DISTILL_SCHEMA_NAME]: clone(DRAFT) },
    repair: 'wrapper:(root)',
  },
  {
    name: 'the object inside an echo of the schema',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: { type: 'object', properties: clone(ANNOTATIONS) },
    repair: 'wrapper:(root)',
  },
  {
    name: 'a number written as a string',
    schema: DistillDraft,
    expected: DRAFT,
    input: (() => {
      const v = clone(DRAFT);
      (v.memory_candidates as Record<string, unknown>[])[0] = {
        ...(v.memory_candidates as Record<string, unknown>[])[0],
        confidence: '0.8',
      };
      return v;
    })(),
    repair: 'number_string:memory_candidates[0].confidence',
  },
  {
    name: 'a boolean written as a string',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: { ...clone(ANNOTATIONS), escalation: { ...ANNOTATIONS.escalation, required: 'false' } },
    repair: 'boolean_string:escalation.required',
  },
  {
    name: 'an enum value in another case or spelling',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: { ...clone(ANNOTATIONS), mode: 'Coach' },
    repair: 'enum_case:mode',
  },
  {
    name: 'null for a list',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: { ...clone(ANNOTATIONS), uncertainty: null },
    repair: 'null_array:uncertainty',
  },
  {
    name: 'one object where a list of them is expected',
    schema: CoachAnnotations,
    expected: ANNOTATIONS,
    input: { ...clone(ANNOTATIONS), next_actions: ANNOTATIONS.next_actions[0] },
    repair: 'single_item:next_actions',
  },
];

function strictParse(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(restoreOptionalNulls(value, toStrictJsonSchema(schema))).success;
}

describe('repairStructured: each failure mode of hand-written structured output', () => {
  it.each(CASES)('$name', ({ schema, expected, input, repair }) => {
    // It was a schema failure before: the model would have been asked again.
    expect(strictParse(schema, input)).toBe(false);
    const outcome = validateStructured(input, schema, toStrictJsonSchema(schema));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(expected);
    expect(outcome.repairs).toContain(repair);
    // Codes only: field names and indices, never what the model wrote.
    for (const code of outcome.repairs) expect(code).not.toMatch(/Hartwell|facilities|library|\s/);
  });

  it('changes nothing that is already valid', () => {
    for (const [schema, value] of [
      [DistillDraft, DRAFT],
      [CoachAnnotations, ANNOTATIONS],
    ] as const) {
      const strict = toStrictJsonSchema(schema);
      const input = clone(value);
      expect(repairStructured(input, strict)).toEqual({ value: input, repairs: [] });
    }
  });

  it('never weakens validation: what no repair can make valid still fails', () => {
    const strict = toStrictJsonSchema(CoachAnnotations);
    for (const input of [
      { ...clone(ANNOTATIONS), mode: 'mentor' },
      { ...clone(ANNOTATIONS), claims: [{ text: 'x', kind: 'maybe', evidence_ids: [] }] },
      (() => {
        const v = clone(ANNOTATIONS);
        delete v.claims;
        return v;
      })(),
      { ...clone(ANNOTATIONS), escalation: { ...ANNOTATIONS.escalation, required: 'perhaps' } },
      'not json at all',
    ]) {
      expect(validateStructured(input, CoachAnnotations, strict).ok).toBe(false);
    }
  });
});

describe('extractJsonValue: the object written as text', () => {
  const json = JSON.stringify(ANNOTATIONS);
  it.each([
    ['alone', json],
    ['in a code fence', `\`\`\`json\n${json}\n\`\`\``],
    ['after prose', `Here is the object you asked for:\n${json}\nLet me know.`],
    ['after reasoning', `<thinking>The founder said hi. I need a mode.</thinking>\n${json}`],
  ])('%s', (_name, text) => {
    expect(extractJsonValue(text)).toEqual(ANNOTATIONS);
    const outcome = parseStructuredText(text, CoachAnnotations, toStrictJsonSchema(CoachAnnotations), false);
    expect(outcome.ok).toBe(true);
  });

  it('finds nothing in prose without an object', () => {
    expect(extractJsonValue('Here you go')).toBeUndefined();
    expect(extractJsonValue('Use {braces} sparingly')).toBeUndefined();
  });
});

describe('NovaProvider: one call where a repair round was needed', () => {
  function provider(outputs: ConverseCommandOutput[]): {
    nova: NovaProvider;
    inputs: ConverseCommandInput[];
  } {
    const inputs: ConverseCommandInput[] = [];
    const converse: ConverseFn = (input) => {
      inputs.push(structuredClone(input));
      const next = outputs.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected converse call'));
    };
    return {
      nova: new NovaProvider({ modelId: 'us.amazon.nova-2-lite-v1:0', region: 'us-east-1', converse }),
      inputs,
    };
  }
  const output = (
    content: NonNullable<NonNullable<ConverseCommandOutput['output']>['message']>['content'],
    stopReason: ConverseCommandOutput['stopReason'] = 'tool_use',
  ): ConverseCommandOutput => ({
    $metadata: {},
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1_200 },
    metrics: { latencyMs: 10 },
  });
  const tool = (input: unknown) => ({
    toolUse: { toolUseId: 'tooluse-1', name: SUBMIT_TOOL_NAME, input: input as never },
  });
  function request<T>(schema: z.ZodType<T>, name: string, maxOutputTokens = 2_000): ProviderRequest<T> {
    return {
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'TRANSCRIPT' }],
      schemaName: name,
      zodSchema: schema,
      strict: toStrictJsonSchema(schema),
      maxOutputTokens,
      deadline: new Deadline(5_000),
      requestId: 'req',
    };
  }

  it.each(CASES)('$name', async ({ schema, expected, input }) => {
    const { nova, inputs } = provider([output([tool(input)])]);
    const result = await nova.generate(request(schema, 'X'));
    expect(result.value).toEqual(expected);
    expect(inputs).toHaveLength(1);
    expect(result.rawAttempts.map((a) => a.outcome)).toEqual(['ok']);
    expect(result.rawAttempts[0]?.issues?.length).toBeGreaterThan(0);
  });

  it('takes the object the model wrote as text instead of calling the tool', async () => {
    const { nova, inputs } = provider([
      output(
        [{ text: `<thinking>Plan the notes.</thinking>\n\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\`` }],
        'end_turn',
      ),
    ]);
    const result = await nova.generate(request(DistillDraft, DISTILL_SCHEMA_NAME));
    expect(result.value).toEqual(DRAFT);
    expect(inputs).toHaveLength(1);
    expect(result.rawAttempts[0]?.issues).toContain('text_output:(root)');
  });

  it('gives a repair after a cut-off answer room to finish', async () => {
    const { nova, inputs } = provider([
      output([tool({ title: 'Pricing' })], 'max_tokens'),
      output([tool(clone(DRAFT))]),
    ]);
    const result = await nova.generate(request(DistillDraft, DISTILL_SCHEMA_NAME, 4_096));
    expect(result.value).toEqual(DRAFT);
    expect(inputs.map((i) => i.inferenceConfig?.maxTokens)).toEqual([4_096, 8_192]);
    expect(result.rawAttempts[0]).toMatchObject({ outcome: 'invalid_output' });
    expect(result.rawAttempts[0]?.issues?.[0]).toBe('(root): max_tokens');
    // Never past the ceiling.
    const big = provider([output([tool({})], 'max_tokens'), output([tool(clone(DRAFT))])]);
    await big.nova.generate(request(DistillDraft, DISTILL_SCHEMA_NAME, 12_000));
    expect(big.inputs.map((i) => i.inferenceConfig?.maxTokens)).toEqual([12_000, MAX_REPAIR_OUTPUT_TOKENS]);
  });

  it('reports why an answer failed as codes (for the logs), never what it said', async () => {
    const { nova } = provider([
      output([tool({ ...clone(ANNOTATIONS), mode: 'mentor' })]),
      output([tool({ ...clone(ANNOTATIONS), mode: 'mentor' })]),
    ]);
    await expect(
      nova.generate(request(CoachAnnotations, COACH_ANNOTATIONS_SCHEMA_NAME)),
    ).rejects.toMatchObject({
      rawAttempts: [
        { outcome: 'invalid_output', issues: ['mode: invalid_value'] },
        { outcome: 'invalid_output', issues: ['mode: invalid_value'] },
      ],
    });
  });
});
