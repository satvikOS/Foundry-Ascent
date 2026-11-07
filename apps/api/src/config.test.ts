import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiConfig, loadCoreConfig } from './config.js';

const prod = {
  APP_ENV: 'production',
  APP_VERSION: 'abc1234',
  DOCUMENTS_BUCKET: 'foundry-ascent-documents',
  RECORDINGS_BUCKET: 'foundry-ascent-recordings',
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
      faceLiteRoute: 'server',
      voice: 'elevenlabs',
      voiceId: null,
      voiceFallbackId: null,
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

  it('reads the ElevenLabs stock voice and its Polly stand-in: both required, both ignored for other providers', () => {
    const stock = {
      ...prod,
      MEDIA_VOICE_PROVIDER: 'elevenlabs-stock',
      MEDIA_VOICE_FALLBACK_VOICE_ID: 'Matthew',
    };
    expect(loadApiConfig({ ...stock, MEDIA_VOICE_ID: 'AaOhDHYJ1XLZk74lXhdE' }, 'api').media).toMatchObject({
      voice: 'elevenlabs-stock',
      voiceId: 'AaOhDHYJ1XLZk74lXhdE',
      voiceFallbackId: 'Matthew',
      voiceModel: 'eleven_flash_v2_5',
    });
    expect(() => loadApiConfig(stock, 'api')).toThrow(/MEDIA_VOICE_ID/);
    expect(() => loadApiConfig({ ...stock, MEDIA_VOICE_ID: 'not a voice!' }, 'api')).toThrow(
      /MEDIA_VOICE_ID/,
    );
    // The stand-in is named with the stock voice (the call's own Polly voice could be of another gender), and it is
    // one of the Polly voices calls speak with.
    const { MEDIA_VOICE_FALLBACK_VOICE_ID: _named, ...unnamed } = stock;
    expect(() => loadApiConfig({ ...unnamed, MEDIA_VOICE_ID: 'AaOhDHYJ1XLZk74lXhdE' }, 'api')).toThrow(
      /MEDIA_VOICE_FALLBACK_VOICE_ID/,
    );
    expect(() =>
      loadApiConfig(
        { ...stock, MEDIA_VOICE_ID: 'AaOhDHYJ1XLZk74lXhdE', MEDIA_VOICE_FALLBACK_VOICE_ID: 'Brian' },
        'api',
      ),
    ).toThrow(/MEDIA_VOICE_FALLBACK_VOICE_ID/);
    expect(
      loadApiConfig(
        {
          ...prod,
          MEDIA_VOICE_PROVIDER: 'polly',
          MEDIA_VOICE_ID: 'AaOhDHYJ1XLZk74lXhdE',
          MEDIA_VOICE_FALLBACK_VOICE_ID: 'Matthew',
        },
        'api',
      ).media,
    ).toMatchObject({ voiceId: null, voiceFallbackId: null });
  });

  it('reads a LITE stock face the browser feeds: a stock avatar only, admins only, never a likeness', () => {
    const avatar = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
    const browser = {
      ...prod,
      MEDIA_FACE_PROVIDER: 'heygen-liveavatar',
      MEDIA_FACE_MODE: 'lite',
      MEDIA_FACE_LITE_ROUTE: 'browser',
    };
    expect(loadApiConfig({ ...browser, MEDIA_FACE_AVATAR_ID: avatar }, 'api').media).toMatchObject({
      faceMode: 'lite',
      faceLiteRoute: 'browser',
      faceStock: { avatarId: avatar, voiceId: null },
      faceAudience: 'admins',
    });
    // The sandbox's own stock avatar (Wayne) needs no id.
    expect(loadApiConfig({ ...browser, MEDIA_FACE_SANDBOX: 'true' }, 'api').media).toMatchObject({
      faceLiteRoute: 'browser',
      faceStock: { avatarId: null, voiceId: null },
    });
    // Without a stock avatar the face would be the persona's likeness: never fed by the browser.
    expect(() => loadApiConfig(browser, 'api')).toThrow(/likeness is never fed by the browser/);
    expect(() =>
      loadApiConfig({ ...browser, MEDIA_FACE_AVATAR_ID: avatar, MEDIA_FACE_AUDIENCE: 'everyone' }, 'api'),
    ).toThrow(/MEDIA_FACE_AUDIENCE=admins/);
    expect(() =>
      loadApiConfig({ ...browser, MEDIA_FACE_MODE: 'full', MEDIA_FACE_AVATAR_ID: avatar }, 'api'),
    ).toThrow(/LITE mode only/);
    expect(() => loadApiConfig({ ...browser, MEDIA_FACE_LITE_ROUTE: 'page' }, 'api')).toThrow(
      /MEDIA_FACE_LITE_ROUTE/,
    );
    // Absent: the server's relay (the likeness route), as before.
    expect(
      loadApiConfig({ ...prod, MEDIA_FACE_PROVIDER: 'heygen-liveavatar' }, 'api').media.faceLiteRoute,
    ).toBe('server');
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
      recordingsBucket: 'foundry-ascent-recordings',
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
        faceLiteRoute: 'server',
        voice: 'polly',
        voiceId: null,
        voiceFallbackId: null,
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
    expect(() => loadApiConfig({ ...prod, RECORDINGS_BUCKET: '' }, 'api')).toThrow(/RECORDINGS_BUCKET/);
    expect(() => loadApiConfig({ ...prod, RECORDINGS_BUCKET: '' }, 'worker')).toThrow(/RECORDINGS_BUCKET/);
    expect(() => loadApiConfig({ ...prod, RECORDINGS_BUCKET: 'Not_A_Bucket!' }, 'api')).toThrow(ConfigError);
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
