/**
 * The face's FULL voicing reaches the API function, stated directly: with the runtime contract listing the four
 * MEDIA_FACE_* names for the API (as apps/api/lambda-contract.json must), a FULL config synthesizes an API function
 * whose environment holds exactly the FULL values, and no other function gets them. The contract is replaced here (and
 * only here: vitest isolates files) so this holds whatever the shipped contract lists today; the expectation is not
 * derived from it.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as ContractModule from '../src/lib/lambda-contract.js';
import type { LambdaContract, LambdaRole } from '../src/lib/lambda-contract.js';

const FACE_VARIABLES = [
  'MEDIA_FACE_MODE',
  'MEDIA_FACE_AVATAR_ID',
  'MEDIA_FACE_VOICE_ID',
  'MEDIA_FACE_AUDIENCE',
];

vi.mock('../src/lib/lambda-contract.js', async (importOriginal) => {
  const real = await importOriginal<typeof ContractModule>();
  const api = [
    ...real.LAMBDA_CONTRACT.environment.api.filter((name) => !FACE_VARIABLES.includes(name)),
    ...FACE_VARIABLES,
  ];
  const contract: LambdaContract = {
    ...real.LAMBDA_CONTRACT,
    environment: { ...real.LAMBDA_CONTRACT.environment, api },
  };
  return {
    ...real,
    LAMBDA_CONTRACT: contract,
    environmentNames: (role: LambdaRole): readonly string[] => [
      ...contract.environment.common,
      ...contract.environment[role],
    ],
  };
});

const { loadConfig } = await import('../src/config.js');
const { functionPolicyStatements, resourcesOfType, synthesize } = await import('./helpers.js');

const WAYNE = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
const VOICE = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
const ROOM = ['wss://heygen-feapbkvq.livekit.cloud', 'https://heygen-feapbkvq.livekit.cloud'];

describe('the face’s FULL voicing on the API function (contract listing MEDIA_FACE_*)', () => {
  const config = loadConfig();
  const full = {
    provider: 'heygen-liveavatar',
    sandbox: true,
    csp: { connect: ROOM, media: [] },
    mode: 'full',
    stock: { avatarId: WAYNE, voiceId: VOICE },
    audience: 'admins',
  } as const;
  const variablesOf = (
    templates: ReturnType<typeof synthesize>['templates'],
    name: string,
  ): Record<string, unknown> =>
    (
      resourcesOfType(templates.app, 'AWS::Lambda::Function').find(([, p]) => p.FunctionName === name)?.[1]
        .Environment as { Variables: Record<string, unknown> }
    ).Variables;

  it('hands FoundryAscent-Api the FULL mode, stock avatar and voice, and the admins audience; nothing else gets them', () => {
    const { templates } = synthesize({}, { ...config, media: { ...config.media, face: full } });
    expect(variablesOf(templates, 'FoundryAscent-Api')).toMatchObject({
      MEDIA_FACE_PROVIDER: 'heygen-liveavatar',
      MEDIA_FACE_SANDBOX: 'true',
      MEDIA_FACE_MODE: 'full',
      MEDIA_FACE_AVATAR_ID: WAYNE,
      MEDIA_FACE_VOICE_ID: VOICE,
      MEDIA_FACE_AUDIENCE: 'admins',
    });
    for (const name of ['FoundryAscent-Worker', 'FoundryAscent-Migrate', 'FoundryAscent-Insights']) {
      for (const key of FACE_VARIABLES)
        expect(variablesOf(templates, name), `${name} ${key}`).not.toHaveProperty(key);
    }
    // FULL changes no permission: the API still only reads the vendor keys.
    const actionsOf = (s: Record<string, unknown>): string[] =>
      Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string];
    const secrets = functionPolicyStatements(templates.app, 'FoundryAscent-Api').filter((s) =>
      actionsOf(s).some((a) => a.startsWith('secretsmanager:')),
    );
    expect(secrets.flatMap(actionsOf)).toEqual(['secretsmanager:GetSecretValue']);
  });

  it('hands it the LITE defaults when the face is off (and an empty voice when the stock avatar keeps its own)', () => {
    const off = {
      ...config,
      media: {
        ...config.media,
        face: {
          provider: 'none',
          sandbox: false,
          csp: { connect: [], media: [] },
          mode: 'lite',
          stock: null,
          audience: 'everyone',
        } as const,
      },
    };
    const lite = synthesize({}, off).templates;
    expect(variablesOf(lite, 'FoundryAscent-Api')).toMatchObject({
      MEDIA_FACE_MODE: 'lite',
      MEDIA_FACE_AVATAR_ID: '',
      MEDIA_FACE_VOICE_ID: '',
      MEDIA_FACE_AUDIENCE: 'everyone',
    });
    const ownVoice = synthesize(
      {},
      { ...config, media: { ...config.media, face: { ...full, stock: { avatarId: WAYNE, voiceId: null } } } },
    ).templates;
    expect(variablesOf(ownVoice, 'FoundryAscent-Api')).toMatchObject({ MEDIA_FACE_VOICE_ID: '' });
  });
});
