import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { conversationLabAccess, LAB_MODELS, LAB_MODELS_FILE, parseLabModels } from '../src/lib/lab-models.js';
import { effectiveModels, reasoningAccess } from '../src/lib/models.js';

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
    // Claude Haiku 4.5 (the coach, and a judge) is reached only through its US profile: granted where it routes.
    expect(access.regionalFoundationModels).toEqual([
      {
        modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        regions: ['us-east-1', 'us-east-2', 'us-west-2'],
      },
      // Rerankers: only where the models suite calls them.
      { modelId: 'cohere.rerank-v3-5:0', regions: ['us-east-1'] },
      { modelId: 'amazon.rerank-v1:0', regions: ['us-west-2'] },
    ]);
    expect(access.inferenceProfiles.slice().sort()).toEqual([
      'global.amazon.nova-2-lite-v1:0',
      'global.anthropic.claude-haiku-5-5',
      'global.openai.gpt-6-luna',
      'us.amazon.nova-2-lite-v1:0',
      'us.amazon.nova-premier-v1:0',
      'us.amazon.nova-pro-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-haiku-5-5',
      'us.anthropic.claude-sonnet-4-6',
      'us.cohere.embed-v4:0',
      'us.meta.llama4-maverick-17b-instruct-v1:0',
      'us.openai.gpt-6-luna',
    ]);
  });

  it('never gives a candidate of the models suite to the app', () => {
    const app = effectiveModels(loadConfig().models);
    const granted = [
      ...reasoningAccess(app).inferenceProfiles,
      ...reasoningAccess(app).foundationModels,
    ].join(' ');
    expect(granted).not.toMatch(/openai|cohere|rerank|multimodal|haiku-5/);
    expect(LAB_MODELS.benchmark.reasoning).toEqual([
      'us.openai.gpt-6-luna',
      'global.openai.gpt-6-luna',
      'us.amazon.nova-2-lite-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-haiku-5-5',
      'global.anthropic.claude-haiku-5-5',
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
    // Nova 2 Lite (the coach before 2026-11-06), Claude Sonnet 4.6 and GPT-6 Luna (ADR-0024); production's coach is
    // Claude Haiku 4.5.
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
      ],
    });
    expect(LAB_MODELS.usdPerMillionTokens['anthropic.claude-haiku-5-5']).toEqual({
      input: 0.1375,
      output: 0.55,
    });
    const models = Object.values(effectiveModels(loadConfig().models));
    expect(JSON.stringify(models)).not.toMatch(/haiku-5|openai/);
    const { client: _client, ...without } = raw();
    expect(parseLabModels(without).client).toEqual({ judge: [], coach: [] });
    const { client } = LAB_MODELS;
    expect(() =>
      parseLabModels({ ...raw(), client: { ...client, judge: ['us.anthropic.claude-opus-9-9'] } }),
    ).toThrow(/no price/);
    expect(() =>
      parseLabModels({
        ...raw(),
        client: { ...client, coach: [...client.coach, 'us.amazon.nova-pro-v1:0'] },
      }),
    ).toThrow(/1 to 4 model ids/);
    expect(() => parseLabModels({ ...raw(), client: { ...client, coach: ['openai.gpt-6-luna'] } })).toThrow(
      /Mantle/,
    );
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

  it('follows the app when its models change (Luna enabled: Mantle stays out of the lab grant)', () => {
    const models = loadConfig().models;
    const access = conversationLabAccess(
      effectiveModels({ ...models, luna: { modelId: 'openai.gpt-6-luna', enabled: true } }),
      LAB_MODELS,
    );
    // The bare (Mantle) id adds nothing: without the lab's own Luna profiles, no OpenAI model is granted.
    const { benchmark: _benchmark, live: _live, client: _client, ...own } = raw();
    const appOnly = conversationLabAccess(
      effectiveModels({ ...models, luna: { modelId: 'openai.gpt-6-luna', enabled: true } }),
      parseLabModels(own),
    );
    expect(JSON.stringify(appOnly)).not.toContain('openai');
    expect(access.inferenceProfiles).toContain('us.amazon.nova-2-lite-v1:0');
  });
});
