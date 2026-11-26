import { describe, expect, it } from 'vitest';
import { loadConfig, type PlatformConfig } from '../src/config.js';
import {
  effectiveModels,
  understandEnvironment,
  embeddingsAccess,
  foundationModelId,
  geoDestinations,
  isInferenceProfile,
  reasoningAccess,
  runtimeAccess,
  servedInRegionOnly,
  usesMantle,
  usesOpenAiProfile,
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

/** Production's coach (ADR-0025) and the understand call's SUMS model: bare ids, served in us-east-1 with no profile. */
const MISTRAL = 'mistral.mistral-large-3-675b-instruct';
const OSS = 'openai.gpt-oss-120b-1:0';

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

  it('grants a model reached only through a checked US profile in that profile’s destination regions alone, and one served in region with no profile in that region alone', () => {
    const production = effectiveModels(loadConfig().models);
    expect(production).toEqual({
      primary: MISTRAL,
      fallback: 'us.amazon.nova-2-lite-v1:0',
      embeddings: 'amazon.titan-embed-text-v2:0',
      background: {
        primary: 'us.amazon.nova-2-lite-v1:0',
        fallback: 'global.amazon.nova-2-lite-v1:0',
        purposes: ['classification', 'eval', 'ingestion', 'seed'],
      },
      understand: 'us.amazon.nova-2-lite-v1:0',
      understandSums: OSS,
    });
    expect(reasoningAccess(production)).toEqual({
      // Nova is also reached through its global profile (the background's fallback): the widest grant wins, so Nova
      // is granted in every region and no Claude model is granted to the app at all.
      foundationModels: ['amazon.nova-2-lite-v1:0'],
      globalFoundationModels: ['amazon.nova-2-lite-v1:0'],
      // Mistral Large 3 and gpt-oss-120b have no inference profile (their model cards): served in the platform
      // region, granted there alone, and no `us.` retry profile is granted for them (none exists).
      regionalFoundationModels: [
        { modelId: MISTRAL, regions: ['us-east-1'] },
        { modelId: OSS, regions: ['us-east-1'] },
      ],
      inferenceProfiles: ['us.amazon.nova-2-lite-v1:0', 'global.amazon.nova-2-lite-v1:0'],
    });
    expect(JSON.stringify(reasoningAccess(production))).not.toContain('anthropic');
    expect(servedInRegionOnly(MISTRAL, 'us-east-1')).toBe(true);
    expect(servedInRegionOnly(OSS, 'us-east-1')).toBe(true);
    // Not checked for another region, nor for a model with a profile: the wider grant (every region, its `us.` profile).
    expect(servedInRegionOnly(MISTRAL, 'eu-west-1')).toBe(false);
    expect(servedInRegionOnly('amazon.nova-2-lite-v1:0', 'us-east-1')).toBe(false);
    expect(servedInRegionOnly(`us.${MISTRAL}`, 'us-east-1')).toBe(false);
    expect(reasoningAccess({ ...production, primary: MISTRAL }, 'eu-west-1').inferenceProfiles).toContain(
      `us.${MISTRAL}`,
    );
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
    // Luna becomes primary and the configured primary (the coach, Mistral Large 3) goes behind it.
    expect(luna).toMatchObject({
      primary: 'openai.gpt-6-luna',
      fallback: MISTRAL,
      background: models.background,
    });
    expect(usesMantle(luna)).toBe(true);
  });
});

/**
 * The switch ADR-0024 prepares, still one line after ADR-0025: production.json with `models.primary` changed (the
 * coach, Mistral Large 3, gives way to Luna; Nova 2 Lite's US profile stays behind it).
 */
const LUNA_COACH: PlatformConfig['models'] = { ...loadConfig().models, primary: 'us.openai.gpt-6-luna' };

describe('GPT-6 Luna as the coach (ADR-0024: prepared, off)', () => {
  it('is off: production coaches on Mistral Large 3, and its only OpenAI model is gpt-oss-120b (the sums, Converse)', () => {
    const models = effectiveModels(loadConfig().models);
    expect(models.primary).toBe(MISTRAL);
    const access = reasoningAccess(models);
    expect(JSON.stringify(access)).not.toContain('luna');
    expect(
      [
        ...access.foundationModels,
        ...access.regionalFoundationModels.map((m) => m.modelId),
        ...access.inferenceProfiles,
      ].filter((id) => id.includes('openai')),
    ).toEqual([OSS]);
    expect(usesOpenAiProfile(access.inferenceProfiles)).toBe(false);
    expect(usesMantle(models)).toBe(false);
  });

  it('is one line: the profile becomes primary, Nova stays behind it, Mistral leaves the grant, Mantle stays out', () => {
    const models = effectiveModels(LUNA_COACH);
    expect(models).toEqual({
      ...effectiveModels(loadConfig().models),
      primary: 'us.openai.gpt-6-luna',
      fallback: 'us.amazon.nova-2-lite-v1:0',
    });
    expect(usesMantle(models)).toBe(false);
    expect(reasoningAccess(models)).toEqual({
      foundationModels: ['amazon.nova-2-lite-v1:0'],
      globalFoundationModels: ['amazon.nova-2-lite-v1:0'],
      regionalFoundationModels: [
        { modelId: 'openai.gpt-6-luna', regions: ['us-east-1', 'us-east-2', 'us-west-2'] },
        { modelId: OSS, regions: ['us-east-1'] },
      ],
      inferenceProfiles: [
        'us.openai.gpt-6-luna',
        'us.amazon.nova-2-lite-v1:0',
        'global.amazon.nova-2-lite-v1:0',
      ],
    });
    expect(JSON.stringify(reasoningAccess(models))).not.toContain('mistral');
    expect(usesOpenAiProfile(['us.openai.gpt-6-luna'])).toBe(true);
    expect(usesOpenAiProfile(['openai.gpt-6-luna', 'us.amazon.nova-2-lite-v1:0'])).toBe(false);
  });

  it('gives every function its environment, and api and worker exactly its permissions', () => {
    const { templates } = synthesize({}, { ...loadConfig(), models: LUNA_COACH });
    for (const [, fn] of resourcesOfType(templates.app, 'AWS::Lambda::Function').filter(([, p]) =>
      String(p.FunctionName).startsWith('FoundryAscent-'),
    )) {
      expect((fn.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({
        MODEL_PRIMARY_ID: 'us.openai.gpt-6-luna',
        MODEL_FALLBACK_ID: 'us.amazon.nova-2-lite-v1:0',
        MODEL_BACKGROUND_PRIMARY_ID: 'us.amazon.nova-2-lite-v1:0',
        MODEL_BACKGROUND_PURPOSES: 'classification,eval,ingestion,seed',
      });
    }
    const expected = [
      profile('us.openai.gpt-6-luna'),
      ...['us-east-1', 'us-east-2', 'us-west-2'].map((region) =>
        regionalFoundationModel('openai.gpt-6-luna', region),
      ),
      join(
        'arn:',
        { Ref: 'AWS::Partition' },
        ':bedrock:us-east-1:',
        { Ref: 'AWS::AccountId' },
        ':project/default',
      ),
      profile('us.amazon.nova-2-lite-v1:0'),
      profile('global.amazon.nova-2-lite-v1:0'),
      foundationModel('amazon.nova-2-lite-v1:0'),
      regionlessFoundationModel('amazon.nova-2-lite-v1:0'),
      foundationModel('amazon.titan-embed-text-v2:0'),
    ];
    // The understand call's SUMS model (gpt-oss-120b, in region) is the API's alone: only it runs that call.
    const roles: [string, unknown[]][] = [
      ['FoundryAscent-Api', [...expected, regionalFoundationModel(OSS, 'us-east-1')]],
      ['FoundryAscent-Worker', expected],
    ];
    for (const [name, resources] of roles) {
      const statements = functionPolicyStatements(templates.app, name);
      const runtime = statements.find((s) => s.Sid === 'BedrockRuntimeModels');
      expect(runtime?.Resource).toEqual(expect.arrayContaining(resources));
      expect(runtime?.Resource).toHaveLength(resources.length);
      expect(statements.some((s) => s.Sid === 'BedrockMantleInference')).toBe(false);
    }
    // Embeddings only, as before.
    expect(
      functionPolicyStatements(templates.app, 'FoundryAscent-Migrate').find(
        (s) => s.Sid === 'BedrockEmbeddings',
      )?.Resource,
    ).toEqual(foundationModel('amazon.titan-embed-text-v2:0'));
  });
});

describe('the understand call (models.understand)', () => {
  const api = (models: PlatformConfig['models']) => {
    const { templates } = synthesize({}, { ...loadConfig(), models });
    const found = (name: string) =>
      resourcesOfType(templates.app, 'AWS::Lambda::Function').find(([, p]) => p.FunctionName === name)?.[1];
    const variables = (name: string) =>
      (found(name)?.Environment as { Variables: Record<string, unknown> } | undefined)?.Variables ?? {};
    return { templates, variables };
  };

  it('production turns it on (ADR-0025): Nova 2 Lite reads, gpt-oss-120b sums, the API alone gets its variables and the sums model', () => {
    const { models } = loadConfig();
    expect(models.understand).toMatchObject({
      enabled: true,
      modelId: 'us.amazon.nova-2-lite-v1:0',
      sumsModelId: OSS,
    });
    const expected = {
      CORE_UNDERSTAND: 'on',
      MODEL_UNDERSTAND_ID: 'us.amazon.nova-2-lite-v1:0',
      MODEL_UNDERSTAND_SUMS_ID: OSS,
    };
    expect(understandEnvironment(models)).toEqual(expected);
    const { templates, variables } = api(models);
    const understandOf = (name: string) =>
      Object.fromEntries(Object.entries(variables(name)).filter(([k]) => k.includes('UNDERSTAND')));
    expect(understandOf('FoundryAscent-Api')).toEqual(expected);
    expect(understandOf('FoundryAscent-Worker')).toEqual({});
    const runtime = (name: string) =>
      functionPolicyStatements(templates.app, name).find((s) => s.Sid === 'BedrockRuntimeModels')
        ?.Resource as unknown[];
    expect(runtime('FoundryAscent-Api')).toContainEqual(regionalFoundationModel(OSS, 'us-east-1'));
    expect(JSON.stringify(runtime('FoundryAscent-Worker'))).not.toContain('gpt-oss');
    // Nova 2 Lite, the reading's model, is the coach's fallback already: the worker keeps it for that.
    expect(runtime('FoundryAscent-Worker')).toContainEqual(profile('us.amazon.nova-2-lite-v1:0'));
  });

  it('is passed to the API alone, and its model granted, when it is set', () => {
    const models = {
      ...loadConfig().models,
      understand: { enabled: true, modelId: OSS, think: 'low' as const },
    };
    const { templates, variables } = api(models);
    expect(variables('FoundryAscent-Api')).toMatchObject({
      CORE_UNDERSTAND: 'on',
      MODEL_UNDERSTAND_ID: OSS,
      MODEL_UNDERSTAND_THINK: 'low',
    });
    expect(Object.keys(variables('FoundryAscent-Worker')).filter((k) => k.includes('UNDERSTAND'))).toEqual(
      [],
    );
    expect(effectiveModels(models).understand).toBe(OSS);
    const runtime = functionPolicyStatements(templates.app, 'FoundryAscent-Api').find(
      (s) => s.Sid === 'BedrockRuntimeModels',
    );
    // In region, with no profile (its model card): granted in the platform region alone, no `us.` profile.
    expect(runtime?.Resource).toEqual(expect.arrayContaining([regionalFoundationModel(OSS, 'us-east-1')]));
    expect(JSON.stringify(runtime?.Resource)).not.toContain(`us.${OSS}`);
    expect(
      JSON.stringify(
        functionPolicyStatements(templates.app, 'FoundryAscent-Worker').find(
          (s) => s.Sid === 'BedrockRuntimeModels',
        )?.Resource,
      ),
    ).not.toContain('gpt-oss');
    // OpenAI's open-weight models are Converse's: no Mantle permission.
    expect(usesMantle(effectiveModels(models))).toBe(false);
  });

  it('names the SUMS part’s own model, granted, with its effort, when it is set', () => {
    const models = {
      ...loadConfig().models,
      understand: { enabled: true, sumsModelId: OSS, sumsThink: 'low' as const },
    };
    const { templates, variables } = api(models);
    expect(variables('FoundryAscent-Api')).toMatchObject({
      CORE_UNDERSTAND: 'on',
      MODEL_UNDERSTAND_SUMS_ID: OSS,
      MODEL_UNDERSTAND_SUMS_THINK: 'low',
    });
    expect(variables('FoundryAscent-Api')).not.toHaveProperty('MODEL_UNDERSTAND_ID');
    expect(effectiveModels(models)).toMatchObject({ understandSums: OSS });
    expect(effectiveModels(models)).not.toHaveProperty('understand');
    const runtime = functionPolicyStatements(templates.app, 'FoundryAscent-Api').find(
      (s) => s.Sid === 'BedrockRuntimeModels',
    );
    expect(runtime?.Resource).toEqual(expect.arrayContaining([regionalFoundationModel(OSS, 'us-east-1')]));
  });

  it('on the coach itself it grants nothing more', () => {
    const models = { ...loadConfig().models, understand: { enabled: true } };
    expect(reasoningAccess(effectiveModels(models))).toEqual(
      reasoningAccess(effectiveModels({ ...loadConfig().models, understand: undefined })),
    );
    expect(understandEnvironment(models)).toEqual({ CORE_UNDERSTAND: 'on' });
    expect(understandEnvironment({ ...models, understand: { enabled: false } })).toEqual({
      CORE_UNDERSTAND: 'off',
    });
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

  const both = [
    `arn:aws:bedrock:us-east-1:${account}:inference-profile/us.amazon.nova-2-lite-v1:0`,
    `arn:aws:bedrock:us-east-1:${account}:inference-profile/global.amazon.nova-2-lite-v1:0`,
    'arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0',
    'arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0',
    // The coach: in region, no profile (its model card), so no `us.` profile ARN.
    `arn:aws:bedrock:us-east-1::foundation-model/${MISTRAL}`,
    'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0',
  ];
  it.each([
    // The understand call's SUMS part runs on the API alone.
    ['FoundryAscent-Api', [...both, `arn:aws:bedrock:us-east-1::foundation-model/${OSS}`]],
    ['FoundryAscent-Worker', both],
  ] as const)(
    '%s may invoke (incl. streaming) Mistral Large 3 in the platform region, both Nova profiles, the Nova model in every region and region-less, Titan, gpt-oss-120b on the API alone, and no Claude model',
    (name, expected) => {
      const runtime = functionPolicyStatements(templates.app, name).find(
        (s) => s.Sid === 'BedrockRuntimeModels',
      );
      expect(runtime?.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
      const resources = ((runtime?.Resource as unknown[] | undefined) ?? []).map(render);
      expect(resources.sort()).toEqual([...expected].sort());
      expect(resources.join(' ')).not.toMatch(/anthropic|luna|project\/default/);
      // Luna stays gated (models.luna.enabled=false) and gpt-oss is Converse's: no Mantle permission at all.
      expect(
        functionPolicyStatements(templates.app, name).some((s) => s.Sid === 'BedrockMantleInference'),
      ).toBe(false);
    },
  );
});
