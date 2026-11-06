import { describe, expect, it } from 'vitest';
import { loadConfig, type PlatformConfig } from '../src/config.js';
import {
  effectiveModels,
  embeddingsAccess,
  foundationModelId,
  geoDestinations,
  isInferenceProfile,
  reasoningAccess,
  runtimeAccess,
  usesMantle,
} from '../src/lib/models.js';
import { functionPolicyStatements, resourcesOfType, synthesize } from './helpers.js';

const NOVA_MODELS: PlatformConfig['models'] = {
  primary: 'us.amazon.nova-2-lite-v1:0',
  fallback: 'global.amazon.nova-2-lite-v1:0',
  embeddings: 'amazon.titan-embed-text-v2:0',
  luna: { modelId: 'openai.gpt-6-luna', enabled: false },
};
const LUNA_MODELS: PlatformConfig['models'] = {
  ...NOVA_MODELS,
  luna: { modelId: 'openai.gpt-6-luna', enabled: true },
};

const join = (...parts: unknown[]): unknown => ({ 'Fn::Join': ['', parts] });
const foundationModel = (id: string): unknown =>
  join('arn:', { Ref: 'AWS::Partition' }, `:bedrock:*::foundation-model/${id}`);
const regionalFoundationModel = (id: string, region: string): unknown =>
  join('arn:', { Ref: 'AWS::Partition' }, `:bedrock:${region}::foundation-model/${id}`);
const regionlessFoundationModel = (id: string): unknown =>
  join('arn:', { Ref: 'AWS::Partition' }, `:bedrock:::foundation-model/${id}`);
const profile = (id: string): unknown =>
  join(
    'arn:',
    { Ref: 'AWS::Partition' },
    ':bedrock:us-east-1:',
    { Ref: 'AWS::AccountId' },
    `:inference-profile/${id}`,
  );

describe('model selection', () => {
  it('uses the configured Nova profiles while Luna is disabled', () => {
    expect(effectiveModels(NOVA_MODELS)).toEqual({
      primary: 'us.amazon.nova-2-lite-v1:0',
      fallback: 'global.amazon.nova-2-lite-v1:0',
      embeddings: 'amazon.titan-embed-text-v2:0',
    });
    expect(effectiveModels({ ...NOVA_MODELS, luna: undefined })).toEqual(effectiveModels(NOVA_MODELS));
  });

  it('makes Luna primary with the in-geography Nova profile as fallback once enabled', () => {
    expect(effectiveModels(LUNA_MODELS)).toEqual({
      primary: 'openai.gpt-6-luna',
      fallback: 'us.amazon.nova-2-lite-v1:0',
      embeddings: 'amazon.titan-embed-text-v2:0',
    });
    expect(usesMantle(effectiveModels(LUNA_MODELS))).toBe(true);
    expect(usesMantle(effectiveModels(NOVA_MODELS))).toBe(false);
  });

  it('maps inference profiles to their foundation model', () => {
    expect(isInferenceProfile('global.amazon.nova-2-lite-v1:0')).toBe(true);
    expect(isInferenceProfile('amazon.nova-2-lite-v1:0')).toBe(false);
    expect(foundationModelId('us.amazon.nova-2-lite-v1:0')).toBe('amazon.nova-2-lite-v1:0');
    expect(foundationModelId('openai.gpt-6-luna')).toBe('openai.gpt-6-luna');
  });

  it('grants a bare reasoning model its us. profile for the gateway retry', () => {
    const access = reasoningAccess({
      primary: 'openai.gpt-6-luna',
      fallback: 'amazon.nova-2-lite-v1:0',
      embeddings: 'amazon.titan-embed-text-v2:0',
    });
    expect(access).toEqual({
      foundationModels: ['amazon.nova-2-lite-v1:0'],
      globalFoundationModels: [],
      regionalFoundationModels: [],
      inferenceProfiles: ['us.amazon.nova-2-lite-v1:0'],
    });
    expect(embeddingsAccess(effectiveModels(NOVA_MODELS))).toEqual({
      foundationModels: ['amazon.titan-embed-text-v2:0'],
      globalFoundationModels: [],
      regionalFoundationModels: [],
      inferenceProfiles: [],
    });
  });

  it('adds the region-less foundation-model ARN for global profiles', () => {
    expect(reasoningAccess(effectiveModels(NOVA_MODELS))).toEqual({
      foundationModels: ['amazon.nova-2-lite-v1:0'],
      globalFoundationModels: ['amazon.nova-2-lite-v1:0'],
      regionalFoundationModels: [],
      inferenceProfiles: ['us.amazon.nova-2-lite-v1:0', 'global.amazon.nova-2-lite-v1:0'],
    });
  });

  it('grants a model reached only through a checked US profile in that profile’s destination regions alone', () => {
    const production = effectiveModels(loadConfig().models);
    expect(production).toEqual({
      primary: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      fallback: 'us.amazon.nova-2-lite-v1:0',
      embeddings: 'amazon.titan-embed-text-v2:0',
      background: {
        primary: 'us.amazon.nova-2-lite-v1:0',
        fallback: 'global.amazon.nova-2-lite-v1:0',
        purposes: ['classification', 'eval', 'ingestion', 'seed', 'embedding'],
      },
    });
    expect(reasoningAccess(production)).toEqual({
      // Nova is also reached through its global profile (the background fallback): the widest grant wins.
      foundationModels: ['amazon.nova-2-lite-v1:0'],
      globalFoundationModels: ['amazon.nova-2-lite-v1:0'],
      regionalFoundationModels: [
        {
          modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
          regions: ['us-east-1', 'us-east-2', 'us-west-2'],
        },
      ],
      inferenceProfiles: [
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.amazon.nova-2-lite-v1:0',
        'global.amazon.nova-2-lite-v1:0',
      ],
    });
    // A profile whose destinations were not checked keeps its model granted in every region; so does another source.
    expect(geoDestinations('us.anthropic.claude-sonnet-4-6', 'us-east-1')).toBeNull();
    expect(geoDestinations('us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us-west-2')).toBeNull();
    expect(runtimeAccess(['us.anthropic.claude-sonnet-4-6'], 'us-east-1').foundationModels).toEqual([
      'anthropic.claude-sonnet-4-6',
    ]);
  });

  it('never lets Luna move the background route', () => {
    const models = loadConfig().models;
    const luna = effectiveModels({ ...models, luna: { modelId: 'openai.gpt-6-luna', enabled: true } });
    expect(luna).toMatchObject({
      primary: 'openai.gpt-6-luna',
      fallback: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      background: models.background,
    });
    expect(usesMantle(luna)).toBe(true);
  });
});

describe.each([
  ['Luna disabled (Nova 2 Lite profiles)', NOVA_MODELS, false],
  ['Luna enabled', LUNA_MODELS, true],
])('Bedrock permissions: %s', (_label, models, mantle) => {
  const config: PlatformConfig = { ...loadConfig(), models };
  const { templates } = synthesize({}, config);
  const effective = effectiveModels(models);

  it('passes the effective model ids to every function', () => {
    for (const [, fn] of resourcesOfType(templates.app, 'AWS::Lambda::Function').filter(([, p]) =>
      String(p.FunctionName).startsWith('FoundryAscent-'),
    )) {
      expect((fn.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({
        MODEL_PRIMARY_ID: effective.primary,
        MODEL_FALLBACK_ID: effective.fallback,
        MODEL_EMBEDDINGS_ID: 'amazon.titan-embed-text-v2:0',
        // These configurations have no background route: all three empty.
        MODEL_BACKGROUND_PRIMARY_ID: '',
        MODEL_BACKGROUND_FALLBACK_ID: '',
        MODEL_BACKGROUND_PURPOSES: '',
      });
    }
  });

  it('grants api and worker exactly the Bedrock resources of those models', () => {
    for (const name of ['FoundryAscent-Api', 'FoundryAscent-Worker']) {
      const statements = functionPolicyStatements(templates.app, name);
      const runtime = statements.find((s) => s.Sid === 'BedrockRuntimeModels');
      expect(runtime?.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
      const expected = [
        foundationModel('amazon.titan-embed-text-v2:0'),
        profile('us.amazon.nova-2-lite-v1:0'),
        ...(mantle
          ? // Nova only behind Luna, through its US profile: granted where that profile routes.
            ['us-east-1', 'us-east-2', 'us-west-2'].map((region) =>
              regionalFoundationModel('amazon.nova-2-lite-v1:0', region),
            )
          : [
              foundationModel('amazon.nova-2-lite-v1:0'),
              profile('global.amazon.nova-2-lite-v1:0'),
              regionlessFoundationModel('amazon.nova-2-lite-v1:0'),
            ]),
      ];
      expect(runtime?.Resource).toEqual(expect.arrayContaining(expected));
      expect(runtime?.Resource).toHaveLength(expected.length);
      expect(runtime?.Effect).toBe('Allow');
      const mantleStatement = statements.find((s) => s.Sid === 'BedrockMantleInference');
      if (mantle) {
        expect(mantleStatement).toEqual({
          Sid: 'BedrockMantleInference',
          Effect: 'Allow',
          Action: 'bedrock-mantle:CreateInference',
          Resource: '*',
        });
      } else {
        expect(mantleStatement).toBeUndefined();
      }
    }
  });

  it('lets migrate invoke only the embeddings model', () => {
    const statements = functionPolicyStatements(templates.app, 'FoundryAscent-Migrate');
    expect(statements.find((s) => s.Sid === 'BedrockEmbeddings')).toEqual({
      Sid: 'BedrockEmbeddings',
      Effect: 'Allow',
      Action: 'bedrock:InvokeModel',
      Resource: foundationModel('amazon.titan-embed-text-v2:0'),
    });
  });
});

describe('Bedrock permissions in production (config/production.json)', () => {
  const { templates } = synthesize({});
  const account = '123456789012';
  /** Renders `{ Fn::Join: ['', [...]] }` ARNs with concrete pseudo parameters. */
  const render = (value: unknown): string => {
    if (typeof value === 'string') return value;
    const parts = (value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1];
    return parts
      .map((part) => {
        if (typeof part === 'string') return part;
        const ref = (part as { Ref: string }).Ref;
        return ref === 'AWS::Partition' ? 'aws' : ref === 'AWS::AccountId' ? account : `<${ref}>`;
      })
      .join('');
  };

  it.each(['FoundryAscent-Api', 'FoundryAscent-Worker'])(
    '%s may invoke (incl. streaming) the Claude Haiku 4.5 profile and its model where it routes, both Nova profiles, the Nova model in every region and region-less, and Titan',
    (name) => {
      const runtime = functionPolicyStatements(templates.app, name).find(
        (s) => s.Sid === 'BedrockRuntimeModels',
      );
      expect(runtime?.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
      expect(((runtime?.Resource as unknown[] | undefined) ?? []).map(render).sort()).toEqual(
        [
          `arn:aws:bedrock:us-east-1:${account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
          'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
          'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
          'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
          `arn:aws:bedrock:us-east-1:${account}:inference-profile/us.amazon.nova-2-lite-v1:0`,
          `arn:aws:bedrock:us-east-1:${account}:inference-profile/global.amazon.nova-2-lite-v1:0`,
          'arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0',
        ].sort(),
      );
      // Luna stays gated (models.luna.enabled=false): no Mantle permission at all.
      expect(
        functionPolicyStatements(templates.app, name).some((s) => s.Sid === 'BedrockMantleInference'),
      ).toBe(false);
    },
  );
});
