import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { conversationLabAccess, LAB_MODELS, LAB_MODELS_FILE, parseLabModels } from '../src/lib/lab-models.js';
import {
  effectiveModels,
  foundationModelId,
  reasoningAccess,
  reasoningModelIds,
  type BedrockRuntimeAccess,
} from '../src/lib/models.js';

/** Lab candidates with no inference profile (their Bedrock model cards). */
const OPEN_WEIGHT = [
  'openai.gpt-oss-120b-1:0',
  'openai.gpt-oss-20b-1:0',
  'qwen.qwen3-next-80b-a3b',
  'deepseek.v3.2',
  'mistral.mistral-large-3-675b-instruct',
];

/**
 * The models production's own configuration names (ADR-0025: Mistral Large 3 coaches, Nova 2 Lite behind it and in the
 * background and reading each turn, gpt-oss-120b doing the reading's sums): the only lab candidates the app may hold.
 */
const APP_MODELS = [
  'mistral.mistral-large-3-675b-instruct',
  'amazon.nova-2-lite-v1:0',
  'openai.gpt-oss-120b-1:0',
  'amazon.titan-embed-text-v2:0',
];

/** Every foundation model a grant reaches (profiles mapped to their model). */
const grantedModels = (access: BedrockRuntimeAccess): string[] => [
  ...new Set([
    ...access.foundationModels,
    ...access.globalFoundationModels,
    ...access.regionalFoundationModels.map((m) => m.modelId),
    ...access.inferenceProfiles.map(foundationModelId),
  ]),
];

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(LAB_MODELS_FILE, 'utf8')) as Record<string, unknown>;

describe('conversation lab models (ops/lab/models.json, shared with the lab harness)', () => {
  it('plays the founder with Nova Pro and judges with Nova Premier, each with a fallback', () => {
    expect(LAB_MODELS.simulator).toEqual(['us.amazon.nova-pro-v1:0', 'us.amazon.nova-2-lite-v1:0']);
    expect(LAB_MODELS.judge).toEqual(['us.amazon.nova-premier-v1:0', 'us.amazon.nova-pro-v1:0']);
  });

  it('prices every listed model (the lab meters its own calls with these)', () => {
    expect(LAB_MODELS.usdPerMillionTokens['amazon.nova-premier-v1:0']).toEqual({ input: 2.5, output: 12.5 });
    expect(LAB_MODELS.usdPerMillionTokens['amazon.nova-pro-v1:0']).toEqual({ input: 0.8, output: 3.2 });
  });

  it('refuses a missing price, a Mantle model, a malformed id and an empty list', () => {
    const base = raw();
    const prices = base.usdPerMillionTokens as Record<string, unknown>;
    const withoutPremier = Object.fromEntries(
      Object.entries(prices).filter(([id]) => id !== 'amazon.nova-premier-v1:0'),
    );
    expect(() => parseLabModels({ ...base, usdPerMillionTokens: withoutPremier })).toThrow(
      /no price for amazon.nova-premier-v1:0/,
    );
    expect(() => parseLabModels({ ...base, judge: ['openai.gpt-6-luna'] })).toThrow(/Mantle/);
    expect(() => parseLabModels({ ...base, judge: ['arn:aws:bedrock:*'] })).toThrow(/not a Bedrock model id/);
    expect(() => parseLabModels({ ...base, simulator: [] })).toThrow(/1 to 3 model ids/);
    expect(() =>
      parseLabModels({
        ...base,
        usdPerMillionTokens: { ...prices, 'amazon.nova-pro-v1:0': { input: 0, output: 1 } },
      }),
    ).toThrow(/positive input/);
  });

  it("grants the app's effective models plus the lab's own, each once", () => {
    const access = conversationLabAccess(effectiveModels(loadConfig().models), LAB_MODELS);
    expect(access.foundationModels.slice().sort()).toEqual([
      'amazon.nova-2-lite-v1:0',
      'amazon.nova-2-multimodal-embeddings-v1:0',
      'amazon.nova-lite-v1:0',
      'amazon.nova-micro-v1:0',
      'amazon.nova-premier-v1:0',
      'amazon.nova-pro-v1:0',
      'amazon.titan-embed-text-v2:0',
      // Claude Haiku 5.5 behind its US and global profiles (the models suite, and the client suite's A/B coach).
      'anthropic.claude-haiku-5-5',
      'anthropic.claude-sonnet-4-6',
      'cohere.embed-v4:0',
      'meta.llama4-maverick-17b-instruct-v1:0',
      // Behind its global profile (the models suite) too, so in every region and region-less.
      'openai.gpt-6-luna',
    ]);
    expect(access.globalFoundationModels.slice().sort()).toEqual([
      'amazon.nova-2-lite-v1:0',
      'anthropic.claude-haiku-5-5',
      'openai.gpt-6-luna',
    ]);
    expect(access.regionalFoundationModels).toEqual([
      // The app's own in-region models (the coach, Mistral Large 3; the sums' gpt-oss-120b): in the lab's region
      // alone, once, though the lab lists both as candidates too.
      { modelId: 'mistral.mistral-large-3-675b-instruct', regions: ['us-east-1'] },
      { modelId: 'openai.gpt-oss-120b-1:0', regions: ['us-east-1'] },
      // Claude Haiku 4.5 (a judge) is reached only through its US profile: granted where it routes.
      {
        modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        regions: ['us-east-1', 'us-east-2', 'us-west-2'],
      },
      // The other candidates with no profile: served in the lab's region, granted there alone.
      ...OPEN_WEIGHT.filter((id) => !APP_MODELS.includes(id)).map((modelId) => ({
        modelId,
        regions: ['us-east-1'],
      })),
      // Rerankers: only where the models suite calls them.
      { modelId: 'cohere.rerank-v3-5:0', regions: ['us-east-1'] },
      { modelId: 'amazon.rerank-v1:0', regions: ['us-west-2'] },
    ]);
    expect(access.inferenceProfiles.slice().sort()).toEqual([
      'global.amazon.nova-2-lite-v1:0',
      'global.anthropic.claude-haiku-5-5',
      'global.openai.gpt-6-luna',
      'us.amazon.nova-2-lite-v1:0',
      'us.amazon.nova-lite-v1:0',
      'us.amazon.nova-micro-v1:0',
      'us.amazon.nova-premier-v1:0',
      'us.amazon.nova-pro-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-haiku-5-5',
      'us.anthropic.claude-sonnet-4-6',
      'us.cohere.embed-v4:0',
      'us.meta.llama4-maverick-17b-instruct-v1:0',
      'us.openai.gpt-6-luna',
    ]);
    // No profile exists for a model served in region (its model card): none is granted.
    for (const id of OPEN_WEIGHT) expect(access.inferenceProfiles).not.toContain(`us.${id}`);
  });

  it('never gives the app a candidate of the models suite its configuration does not name', () => {
    const app = effectiveModels(loadConfig().models);
    // What the app holds is exactly what production.json names: no lab candidate rides along.
    expect(grantedModels(reasoningAccess(app)).sort()).toEqual(
      reasoningModelIds(app)
        .map(foundationModelId)
        .filter((id, i, all) => all.indexOf(id) === i)
        .sort(),
    );
    expect(grantedModels(reasoningAccess(app)).sort()).toEqual(
      APP_MODELS.filter((id) => !id.includes('titan')).sort(),
    );
    const candidates = [
      ...LAB_MODELS.benchmark.reasoning,
      ...LAB_MODELS.benchmark.embeddings,
      ...LAB_MODELS.benchmark.rerankers.map((r) => r.id),
    ].map(foundationModelId);
    const granted = grantedModels(reasoningAccess(app));
    for (const id of candidates.filter((c) => !APP_MODELS.includes(c))) expect(granted).not.toContain(id);
    expect(granted.join(' ')).not.toMatch(/luna|gpt-oss-20b|cohere|rerank|multimodal|haiku|qwen|deepseek/);
    expect(LAB_MODELS.benchmark.reasoning).toEqual([
      'us.openai.gpt-6-luna',
      'global.openai.gpt-6-luna',
      'us.amazon.nova-2-lite-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-haiku-5-5',
      'global.anthropic.claude-haiku-5-5',
      ...OPEN_WEIGHT,
    ]);
    expect(LAB_MODELS.benchmark.embeddings).toContain('us.cohere.embed-v4:0');
    const { benchmark: _benchmark, ...without } = raw();
    expect(parseLabModels(without).benchmark).toEqual({ reasoning: [], embeddings: [], rerankers: [] });
  });

  it('refuses a benchmark candidate that is a Mantle model, malformed, repeated or outside the US', () => {
    const benchmark = raw().benchmark as Record<string, unknown>;
    const parse = (change: Record<string, unknown>): unknown =>
      parseLabModels({ ...raw(), benchmark: { ...benchmark, ...change } });
    expect(() => parse({ reasoning: [{ id: 'openai.gpt-6-luna' }] })).toThrow(/Mantle/);
    expect(() => parse({ embeddings: [{ id: '*' }] })).toThrow(/not a Bedrock model id/);
    expect(() => parse({ embeddings: [] })).toThrow(/1 to 6 candidates/);
    const cohere = { id: 'cohere.rerank-v3-5:0', region: 'us-east-1' };
    expect(() => parse({ rerankers: [cohere, cohere] })).toThrow(/repeats/);
    expect(() => parse({ rerankers: [{ ...cohere, region: '*' }] })).toThrow(/US region/);
  });

  it('grants the A/B coach candidates (live.coach) to the lab only, priced, and never to the app', () => {
    // Nova 2 Lite (the coach from 2026-11-24 to 2026-11-26, ADR-0024), Claude Sonnet 4.6 and GPT-6 Luna; production's
    // coach is Mistral Large 3 (ADR-0025).
    expect(LAB_MODELS.live.coach).toEqual([
      'us.amazon.nova-2-lite-v1:0',
      'us.anthropic.claude-sonnet-4-6',
      'us.openai.gpt-6-luna',
    ]);
    expect(LAB_MODELS.usdPerMillionTokens['openai.gpt-6-luna']).toEqual({ input: 0.1375, output: 0.55 });
    expect(LAB_MODELS.usdPerMillionTokens['anthropic.claude-sonnet-4-6']).toEqual({
      input: 3.3,
      output: 16.5,
    });
    // Production's models are untouched: the coach candidates are no effective app model.
    expect(Object.values(effectiveModels(loadConfig().models))).not.toContain(
      'us.anthropic.claude-sonnet-4-6',
    );
    const { coach: _coach, ...live } = LAB_MODELS.live;
    expect(parseLabModels({ ...raw(), live }).live.coach).toEqual([]);
    expect(() =>
      parseLabModels({ ...raw(), live: { ...live, coach: ['us.anthropic.claude-opus-9-9'] } }),
    ).toThrow(/no price/);
  });

  it("grants the client suite's judge and A/B coaches (client.judge, client.coach) to the lab only, priced", () => {
    expect(LAB_MODELS.client).toEqual({
      judge: [
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.amazon.nova-pro-v1:0',
        'us.meta.llama4-maverick-17b-instruct-v1:0',
      ],
      coach: [
        'us.amazon.nova-2-lite-v1:0',
        'us.anthropic.claude-haiku-5-5',
        'global.anthropic.claude-haiku-5-5',
        'us.openai.gpt-6-luna',
        ...OPEN_WEIGHT,
      ],
    });
    expect(LAB_MODELS.usdPerMillionTokens['anthropic.claude-haiku-5-5']).toEqual({
      input: 0.1375,
      output: 0.55,
    });
    // Of the A/B coaches, the app runs exactly those its configuration names (Mistral Large 3 coaches, Nova 2 Lite
    // behind it, gpt-oss-120b sums), and no other.
    const app = reasoningModelIds(effectiveModels(loadConfig().models));
    expect(LAB_MODELS.client.coach.filter((id) => app.includes(id))).toEqual([
      'us.amazon.nova-2-lite-v1:0',
      'openai.gpt-oss-120b-1:0',
      'mistral.mistral-large-3-675b-instruct',
    ]);
    const granted = grantedModels(reasoningAccess(effectiveModels(loadConfig().models)));
    for (const id of LAB_MODELS.client.coach.map(foundationModelId).filter((c) => !APP_MODELS.includes(c)))
      expect(granted).not.toContain(id);
    expect(granted.join(' ')).not.toMatch(/haiku-5|luna|gpt-oss-20b|qwen|deepseek/);
    const { client: _client, ...without } = raw();
    expect(parseLabModels(without).client).toEqual({ judge: [], coach: [] });
    const { client } = LAB_MODELS;
    expect(() =>
      parseLabModels({ ...raw(), client: { ...client, judge: ['us.anthropic.claude-opus-9-9'] } }),
    ).toThrow(/no price/);
    expect(() =>
      parseLabModels({
        ...raw(),
        client: { ...client, coach: [...client.coach, 'us.amazon.nova-pro-v1:0', 'us.amazon.nova-pro-v1:0'] },
      }),
    ).toThrow(/1 to 10 model ids/);
    for (const id of ['openai.gpt-6-luna', 'openai.gpt-oss-120b'])
      expect(() => parseLabModels({ ...raw(), client: { ...client, coach: [id] } })).toThrow(/Mantle/);
    expect(() => parseLabModels({ ...raw(), client: [] })).toThrow(/must be an object/);
  });

  it("lists the live evaluation's simulator and judge from other model families first, Nova as fallback", () => {
    expect(LAB_MODELS.live.simulator).toEqual([
      'us.meta.llama4-maverick-17b-instruct-v1:0',
      'us.amazon.nova-pro-v1:0',
    ]);
    expect(LAB_MODELS.live.judge).toEqual([
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.meta.llama4-maverick-17b-instruct-v1:0',
      'us.amazon.nova-premier-v1:0',
    ]);
    expect(() =>
      parseLabModels({ ...raw(), live: { simulator: [], judge: ['us.amazon.nova-pro-v1:0'] } }),
    ).toThrow(/1 to 3 model ids/);
  });

  it('grants the understand suite’s candidates to the lab only, priced, and to the app only those it reads with', () => {
    expect(LAB_MODELS.understand).toEqual([
      'us.amazon.nova-2-lite-v1:0',
      'openai.gpt-oss-120b-1:0',
      'openai.gpt-oss-20b-1:0',
      'qwen.qwen3-next-80b-a3b',
      'us.amazon.nova-micro-v1:0',
      'us.amazon.nova-lite-v1:0',
    ]);
    const { understand: _understand, ...without } = raw();
    expect(parseLabModels(without).understand).toEqual([]);
    expect(() => parseLabModels({ ...raw(), understand: [{ id: 'openai.gpt-6-luna' }] })).toThrow(/Mantle/);
    expect(() => parseLabModels({ ...raw(), understand: [{ id: 'us.acme.model-v1:0' }] })).toThrow(
      /no price/,
    );
    // The app reads each turn with Nova 2 Lite and sums with gpt-oss-120b (models.understand); no other candidate.
    const granted = grantedModels(reasoningAccess(effectiveModels(loadConfig().models)));
    expect(LAB_MODELS.understand.map(foundationModelId).filter((id) => granted.includes(id))).toEqual([
      'amazon.nova-2-lite-v1:0',
      'openai.gpt-oss-120b-1:0',
    ]);
    expect(granted.join(' ')).not.toMatch(/gpt-oss-20b|qwen|nova-micro|nova-lite-v1/);
  });

  it('follows the app when its models change (Luna enabled: Mantle stays out of the lab grant)', () => {
    const models = loadConfig().models;
    const access = conversationLabAccess(
      effectiveModels({ ...models, luna: { modelId: 'openai.gpt-6-luna', enabled: true } }),
      LAB_MODELS,
    );
    // The bare (Mantle) id adds nothing: without the lab's own Luna profiles, no Luna model is granted; the configured
    // primary goes behind Luna and stays granted, in region as before, and the sums keep gpt-oss-120b.
    const { benchmark: _benchmark, live: _live, client: _client, understand: _understand, ...own } = raw();
    const appOnly = conversationLabAccess(
      effectiveModels({ ...models, luna: { modelId: 'openai.gpt-6-luna', enabled: true } }),
      parseLabModels(own),
    );
    expect(JSON.stringify(appOnly)).not.toContain('luna');
    expect(grantedModels(appOnly).filter((id) => id.startsWith('openai.'))).toEqual([
      'openai.gpt-oss-120b-1:0',
    ]);
    expect(appOnly.regionalFoundationModels).toEqual(
      expect.arrayContaining([
        { modelId: 'mistral.mistral-large-3-675b-instruct', regions: ['us-east-1'] },
        { modelId: 'openai.gpt-oss-120b-1:0', regions: ['us-east-1'] },
      ]),
    );
    expect(access.inferenceProfiles).toContain('us.amazon.nova-2-lite-v1:0');
  });
});
