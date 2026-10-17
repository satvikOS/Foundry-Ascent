import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { conversationLabAccess, LAB_MODELS, LAB_MODELS_FILE, parseLabModels } from '../src/lib/lab-models.js';
import { effectiveModels } from '../src/lib/models.js';

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
      'amazon.nova-premier-v1:0',
      'amazon.nova-pro-v1:0',
      'amazon.titan-embed-text-v2:0',
    ]);
    expect(access.globalFoundationModels).toEqual(['amazon.nova-2-lite-v1:0']);
    expect(access.inferenceProfiles.slice().sort()).toEqual([
      'global.amazon.nova-2-lite-v1:0',
      'us.amazon.nova-2-lite-v1:0',
      'us.amazon.nova-premier-v1:0',
      'us.amazon.nova-pro-v1:0',
    ]);
  });

  it('follows the app when its models change (Luna enabled: Mantle stays out of the lab grant)', () => {
    const models = loadConfig().models;
    const access = conversationLabAccess(
      effectiveModels({ ...models, luna: { modelId: 'openai.gpt-6-luna', enabled: true } }),
      LAB_MODELS,
    );
    expect(access.foundationModels).not.toContain('openai.gpt-6-luna');
    expect(access.inferenceProfiles).toContain('us.amazon.nova-2-lite-v1:0');
  });
});
