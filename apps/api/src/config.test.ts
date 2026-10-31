import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiConfig, loadCoreConfig } from './config.js';

const prod = {
  APP_ENV: 'production',
  APP_VERSION: 'abc1234',
  DOCUMENTS_BUCKET: 'foundry-ascent-documents',
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/FoundryAscent-Jobs',
  AWS_REGION: 'us-east-1',
};

describe('loadApiConfig', () => {
  it('reads the digital-twin vendors, refusing anything it does not know', () => {
    expect(
      loadApiConfig(
        {
          ...prod,
          MEDIA_FACE_PROVIDER: 'heygen-liveavatar',
          MEDIA_FACE_SANDBOX: 'true',
          MEDIA_VOICE_PROVIDER: 'elevenlabs',
          MEDIA_VOICE_MODEL: 'eleven_turbo_v2_5',
          MEDIA_VOICE_ZERO_RETENTION: 'true',
        },
        'api',
      ).media,
    ).toEqual({
      face: 'heygen-liveavatar',
      faceSandbox: true,
      faceMode: 'lite',
      faceStock: null,
      faceAudience: 'everyone',
      voice: 'elevenlabs',
      voiceModel: 'eleven_turbo_v2_5',
      voiceZeroRetention: true,
    });
    expect(() => loadApiConfig({ ...prod, MEDIA_FACE_PROVIDER: 'tavus' }, 'api')).toThrow(
      /MEDIA_FACE_PROVIDER/,
    );
    expect(() => loadApiConfig({ ...prod, MEDIA_VOICE_MODEL: 'Bad Model!' }, 'api')).toThrow(
      /MEDIA_VOICE_MODEL/,
    );
  });

  it('reads a FULL stock face: its avatar, its optional voice, admins only unless told otherwise', () => {
    const avatar = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
    const voice = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const full = { ...prod, MEDIA_FACE_PROVIDER: 'heygen-liveavatar', MEDIA_FACE_MODE: 'full' };
    expect(loadApiConfig({ ...full, MEDIA_FACE_AVATAR_ID: avatar }, 'api').media).toMatchObject({
      faceMode: 'full',
      faceStock: { avatarId: avatar, voiceId: null },
      faceAudience: 'admins',
    });
    expect(
      loadApiConfig(
        {
          ...full,
          MEDIA_FACE_AVATAR_ID: avatar,
          MEDIA_FACE_VOICE_ID: voice,
          MEDIA_FACE_AUDIENCE: 'everyone',
        },
        'api',
      ).media,
    ).toMatchObject({ faceStock: { avatarId: avatar, voiceId: voice }, faceAudience: 'everyone' });
    // The vendor sandbox has its own avatar; a paid FULL face must name one.
    expect(loadApiConfig({ ...full, MEDIA_FACE_SANDBOX: 'true' }, 'api').media.faceStock).toEqual({
      avatarId: null,
      voiceId: null,
    });
    expect(() => loadApiConfig(full, 'api')).toThrow(/MEDIA_FACE_AVATAR_ID/);
    expect(() => loadApiConfig({ ...full, MEDIA_FACE_AVATAR_ID: 'Wayne' }, 'api')).toThrow(
      /MEDIA_FACE_AVATAR_ID/,
    );
    expect(() => loadApiConfig({ ...full, MEDIA_FACE_MODE: 'medium' }, 'api')).toThrow(/MEDIA_FACE_MODE/);
    expect(() =>
      loadApiConfig({ ...full, MEDIA_FACE_AVATAR_ID: avatar, MEDIA_FACE_AUDIENCE: 'founders' }, 'api'),
    ).toThrow(/MEDIA_FACE_AUDIENCE/);
    // An admins-only LITE face (the EIR's avatar, before founders see it).
    expect(
      loadApiConfig(
        { ...prod, MEDIA_FACE_PROVIDER: 'heygen-liveavatar', MEDIA_FACE_AUDIENCE: 'admins' },
        'api',
      ).media,
    ).toMatchObject({ faceMode: 'lite', faceStock: null, faceAudience: 'admins' });
  });

  it('reads the runtime contract with defaults', () => {
    expect(loadApiConfig(prod, 'api')).toEqual({
      appEnv: 'production',
      appVersion: 'abc1234',
      logLevel: 'info',
      awsRegion: 'us-east-1',
      documentsBucket: 'foundry-ascent-documents',
      jobsQueueUrl: prod.JOBS_QUEUE_URL,
      jobsMaxReceiveCount: 3,
      siteOrigin: null,
      speech: { enabled: true, engine: 'neural' },
      // The digital twin is off unless configured.
      media: {
        face: 'none',
        faceSandbox: false,
        faceMode: 'lite',
        faceStock: null,
        faceAudience: 'everyone',
        voice: 'polly',
        voiceModel: 'eleven_flash_v2_5',
        voiceZeroRetention: false,
      },
    });
    expect(
      loadApiConfig({ LOG_LEVEL: 'DEBUG', SITE_ORIGIN: 'https://foundry.example.edu/' }, 'migrate'),
    ).toMatchObject({
      appEnv: 'development',
      logLevel: 'debug',
      siteOrigin: 'https://foundry.example.edu',
    });
  });

  it('requires the bucket and queue where they are used, naming variables but not values', () => {
    expect(() => loadApiConfig({ ...prod, JOBS_QUEUE_URL: '' }, 'api')).toThrow(/JOBS_QUEUE_URL/);
    expect(() => loadApiConfig({ APP_ENV: 'production' }, 'worker')).toThrow(/DOCUMENTS_BUCKET/);
    expect(() => loadApiConfig({ APP_ENV: 'production' }, 'migrate')).not.toThrow();
    expect(() => loadApiConfig({ ...prod, DOCUMENTS_BUCKET: 'Not_A_Bucket!' }, 'api')).toThrow(ConfigError);
    try {
      loadApiConfig({ ...prod, JOBS_MAX_RECEIVE_COUNT: 'many' }, 'worker');
    } catch (err) {
      expect((err as Error).message).toBe('Invalid environment: JOBS_MAX_RECEIVE_COUNT');
    }
  });
});

describe('speech variables (infra `speech`)', () => {
  it('reads SPEECH_ENABLED and SPEECH_ENGINE as infra sets them', () => {
    expect(
      loadApiConfig({ ...prod, SPEECH_ENABLED: 'false', SPEECH_ENGINE: 'generative' }, 'api').speech,
    ).toEqual({ enabled: false, engine: 'generative' });
    expect(loadApiConfig({ ...prod, SPEECH_ENABLED: 'true', SPEECH_ENGINE: 'neural' }, 'api').speech).toEqual(
      {
        enabled: true,
        engine: 'neural',
      },
    );
  });

  it('refuses an engine or switch value it does not know, naming the variable', () => {
    expect(() => loadApiConfig({ ...prod, SPEECH_ENGINE: 'standard' }, 'api')).toThrow(
      'Invalid environment: SPEECH_ENGINE',
    );
    expect(() => loadApiConfig({ ...prod, SPEECH_ENABLED: 'yes' }, 'api')).toThrow(
      'Invalid environment: SPEECH_ENABLED',
    );
  });
});

describe('loadCoreConfig', () => {
  it('uses core defaults with 5-minute upload URLs', () => {
    const config = loadCoreConfig({ APP_ENV: 'test', HOME_TENANT_SLUG: 'ain' });
    expect(config.uploads.presignTtlSeconds).toBe(300);
    expect(config.session.ttlSeconds).toBe(43_200);
    expect(config.appEnv).toBe('test');
  });
});
