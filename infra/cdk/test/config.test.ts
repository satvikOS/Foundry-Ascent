import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';
import { migrationsChecksum } from '../src/lib/migrations.js';
import { PLACEHOLDER_OWNER } from './helpers.js';

const valid = (): Record<string, unknown> => ({
  region: 'us-east-1',
  githubRepository: 'satvikOS/Foundry-Ascent',
  githubOwnerId: '228056784',
  githubRepositoryId: '1356439229',
  githubBranch: 'main',
  homeTenant: { slug: 'ain', name: 'Ain Foundry' },
  owner: {
    displayName: 'Platform Owner',
    // Placeholder owner (FA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ); the real values live only in config/production.json.
    accessCodePrefix: PLACEHOLDER_OWNER.prefix,
    accessCodeHash: PLACEHOLDER_OWNER.hash,
  },
  models: {
    primary: 'us.amazon.nova-2-lite-v1:0',
    fallback: 'global.amazon.nova-2-lite-v1:0',
    embeddings: 'amazon.titan-embed-text-v2:0',
    luna: { modelId: 'openai.gpt-6-luna', enabled: false, note: 'gated' },
  },
  aurora: { minCapacityAcu: 0, maxCapacityAcu: 2, autoPauseMinutes: 10, engineVersion: '16.13' },
  api: { reservedConcurrency: 10, memoryMb: 1024, timeoutSeconds: 60 },
  speech: { enabled: true, engine: 'neural', dailyAlarmUsd: 2.5, note: 'ignored' },
  distillation: { sweepEnabled: true, sweepIntervalMinutes: 20 },
  logRetentionDays: 30,
});

const withChange = (path: string[], value: unknown): Record<string, unknown> => {
  const config = valid();
  let node = config;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path[path.length - 1] ?? ''] = value;
  return config;
};

describe('config', () => {
  it('loads config/production.json', () => {
    const config = loadConfig();
    expect(config.region).toBe('us-east-1');
    // Pauses after 30 idle minutes (USD 0 while paused); the owner chose this over staying awake (about USD 44 a
    // month). The web app wakes the cluster when a page opens: docs/runbooks/cost-controls.md, "Aurora: paused when idle".
    expect(config.aurora).toEqual({
      minCapacityAcu: 0,
      maxCapacityAcu: 2,
      autoPauseMinutes: 30,
      engineVersion: '16.13',
    });
    // One full vCPU for the API.
    expect(config.api.memoryMb).toBe(1769);
    // Unreserved: some accounts have a total concurrency quota of 10, which any reservation would break.
    expect(config.api.reservedConcurrency).toBeNull();
    expect(config.worker.reservedConcurrency).toBeNull();
    // Voice calls on Polly's neural engine (lower latency, half the price, no generative speech caveat).
    expect(config.speech).toEqual({ enabled: true, engine: 'neural', dailyAlarmUsd: 15 });
    // The sweep would keep Aurora awake; distillation runs from jobs the API enqueues (ADR-0018).
    expect(config.distillation).toEqual({ sweepEnabled: false, sweepIntervalMinutes: 15 });
  });

  it('reads the speech and distillation sections', () => {
    const config = parseConfig(valid());
    expect(config.speech).toEqual({ enabled: true, engine: 'neural', dailyAlarmUsd: 2.5 });
    expect(parseConfig(withChange(['speech', 'engine'], 'generative')).speech.engine).toBe('generative');
    expect(config.distillation).toEqual({ sweepEnabled: true, sweepIntervalMinutes: 20 });
  });

  it('ships the vendor sandbox stock face for platform admins only, and reads the digital twin when configured', () => {
    // 2026-10-31 (owner): HeyGen's stock avatar in its stock voice, in the vendor sandbox (free), platform admins only,
    // until the mid-December presentation. 2026-11-05 (owner): the vEIR's live voice is ElevenLabs (a stock library
    // voice, an "AI voice"), with Amazon Polly saying any unit it fails on. 2026-11-05: the stock avatar speaks that
    // ElevenLabs voice in LITE, its speak channel held by the caller's page (exactly that origin in connect-src).
    // 2026-11-05 (owner): the chosen stock avatar Thomas (Friendly) live, on the HeyGen account's own credits.
    expect(loadConfig().media).toEqual({
      face: {
        provider: 'heygen-liveavatar',
        sandbox: false,
        csp: {
          connect: [
            'wss://heygen-feapbkvq.livekit.cloud',
            'https://heygen-feapbkvq.livekit.cloud',
            'wss://webrtc-signaling.heygen.io',
          ],
          media: [],
        },
        mode: 'lite',
        stock: { avatarId: '6c2017bc-1eef-4071-ba70-0e9d5bcbf00f', voiceId: null },
        audience: 'admins',
        liteRoute: 'browser',
      },
      voice: {
        provider: 'elevenlabs-stock',
        voiceId: 'AaOhDHYJ1XLZk74lXhdE',
        model: 'eleven_flash_v2_5',
        fallback: 'polly',
        fallbackVoiceId: 'Matthew',
        zeroRetention: false,
      },
    });
    // Absent: off as well.
    expect(parseConfig(valid()).media.voice).toEqual({
      provider: 'polly',
      model: 'eleven_flash_v2_5',
      zeroRetention: false,
      voiceId: null,
      fallback: 'polly',
      fallbackVoiceId: null,
    });
    expect(parseConfig(valid()).media.face.provider).toBe('none');
    const on = parseConfig({
      ...valid(),
      media: {
        face: {
          provider: 'heygen-liveavatar',
          sandbox: true,
          csp: {
            connect: ['wss://heygen-feapbkvq.livekit.cloud', 'https://heygen-feapbkvq.livekit.cloud'],
            media: [],
          },
        },
        voice: { provider: 'elevenlabs', model: 'eleven_turbo_v2_5', zeroRetention: true },
        note: 'ignored',
      },
    });
    expect(on.media).toEqual({
      face: {
        provider: 'heygen-liveavatar',
        sandbox: true,
        csp: {
          connect: ['wss://heygen-feapbkvq.livekit.cloud', 'https://heygen-feapbkvq.livekit.cloud'],
          media: [],
        },
        // Absent voicing keys keep faces as they were before FULL: LITE, the persona's own face on the server's
        // relay, everyone.
        mode: 'lite',
        stock: null,
        audience: 'everyone',
        liteRoute: 'server',
      },
      voice: {
        provider: 'elevenlabs',
        model: 'eleven_turbo_v2_5',
        zeroRetention: true,
        voiceId: null,
        fallback: 'polly',
        fallbackVoiceId: null,
      },
    });
  });

  it('reads the ElevenLabs stock voice: a named voice, a named Polly voice as its fallback, speech on', () => {
    const voice = (v: Record<string, unknown>, speech: Record<string, unknown> = {}) =>
      parseConfig({
        ...valid(),
        ...(Object.keys(speech).length === 0
          ? {}
          : { speech: { ...(valid() as { speech: Record<string, unknown> }).speech, ...speech } }),
        media: {
          face: { provider: 'none', sandbox: false, csp: { connect: [], media: [] } },
          voice: { provider: 'elevenlabs-stock', model: 'eleven_flash_v2_5', zeroRetention: false, ...v },
        },
      }).media.voice;
    const named = { voiceId: 'AaOhDHYJ1XLZk74lXhdE', fallbackVoiceId: 'Matthew' };
    expect(voice(named)).toEqual({
      provider: 'elevenlabs-stock',
      model: 'eleven_flash_v2_5',
      zeroRetention: false,
      voiceId: 'AaOhDHYJ1XLZk74lXhdE',
      fallback: 'polly',
      fallbackVoiceId: 'Matthew',
    });
    expect(voice({ ...named, fallback: 'polly' }).fallback).toBe('polly');
    expect(() => voice({ fallbackVoiceId: 'Matthew' })).toThrow(
      /media\.voice\.voiceId.*must name the ElevenLabs stock voice/,
    );
    expect(() => voice({ ...named, voiceId: 'not a voice' })).toThrow(/media\.voice\.voiceId/);
    expect(() => voice({ ...named, fallback: 'none' })).toThrow(/media\.voice\.fallback /);
    // The Polly voice that says a failed unit is named with the stock voice, and is one calls can speak with.
    expect(() => voice({ voiceId: 'AaOhDHYJ1XLZk74lXhdE' })).toThrow(
      /media\.voice\.fallbackVoiceId.*must name the Amazon Polly voice/,
    );
    expect(() => voice({ ...named, fallbackVoiceId: 'Brian' })).toThrow(
      /media\.voice\.fallbackVoiceId.*must be a voice of packages\/core\/speech-voices\.json/,
    );
    expect(() => voice({ provider: 'polly', voiceId: 'AaOhDHYJ1XLZk74lXhdE' })).toThrow(
      /voiceId is read only when provider is elevenlabs-stock/,
    );
    expect(() => voice({ provider: 'polly', fallbackVoiceId: 'Matthew' })).toThrow(
      /fallbackVoiceId is read only when provider is elevenlabs-stock/,
    );
    expect(() => voice(named, { enabled: false })).toThrow(/elevenlabs-stock needs speech.enabled/);
  });

  describe('the face’s voicing (mode, stock, audience)', () => {
    const room = ['wss://heygen-feapbkvq.livekit.cloud', 'https://heygen-feapbkvq.livekit.cloud'];
    const WAYNE = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
    const VOICE = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
    const face = (extra: Record<string, unknown>, provider = 'heygen-liveavatar') =>
      parseConfig({
        ...valid(),
        media: {
          face: {
            provider,
            sandbox: true,
            csp: provider === 'none' ? { connect: [], media: [] } : { connect: room, media: [] },
            ...extra,
          },
          voice: { provider: 'polly', model: 'eleven_flash_v2_5', zeroRetention: false },
        },
      }).media.face;

    it('reads FULL with a stock avatar and voice, offered to admins (the default and only FULL audience)', () => {
      expect(
        face({ mode: 'full', stock: { avatarId: WAYNE, voiceId: VOICE }, audience: 'admins' }),
      ).toMatchObject({
        mode: 'full',
        stock: { avatarId: WAYNE, voiceId: VOICE },
        audience: 'admins',
      });
      // No voice: the avatar's own default voice; no audience: admins.
      expect(face({ mode: 'full', stock: { avatarId: WAYNE } })).toMatchObject({
        mode: 'full',
        stock: { avatarId: WAYNE, voiceId: null },
        audience: 'admins',
      });
    });

    it('refuses FULL together with a likeness: FULL needs a stock avatar', () => {
      expect(() => face({ mode: 'full' })).toThrow(/media\.face\.stock must name a vendor stock avatar/);
      expect(() => face({ mode: 'full', stock: null })).toThrow(/FULL never renders an EIR’s likeness/);
      // Also while the face is not wired: the rule does not wait for the deploy that wires it.
      expect(() => face({ mode: 'full' }, 'none')).toThrow(/media\.face\.stock/);
    });

    it('refuses FULL for anyone but platform admins', () => {
      expect(() => face({ mode: 'full', stock: { avatarId: WAYNE }, audience: 'everyone' })).toThrow(
        /media\.face\.audience must be admins when mode is full/,
      );
    });

    const SOCKET = 'wss://webrtc-signaling.heygen.io';
    const liteFace = (extra: Record<string, unknown>) =>
      parseConfig({
        ...valid(),
        media: {
          face: {
            provider: 'heygen-liveavatar',
            sandbox: true,
            csp: { connect: [...room, SOCKET], media: [] },
            ...extra,
          },
          voice: { provider: 'polly', model: 'eleven_flash_v2_5', zeroRetention: false },
        },
      }).media.face;

    it('reads a LITE stock face the browser feeds: admins by default, its speak channel’s exact origin allowed', () => {
      expect(liteFace({ mode: 'lite', stock: { avatarId: WAYNE } })).toMatchObject({
        mode: 'lite',
        liteRoute: 'browser',
        stock: { avatarId: WAYNE, voiceId: null },
        audience: 'admins',
      });
      expect(liteFace({ mode: 'lite', liteRoute: 'browser', stock: { avatarId: WAYNE } }).liteRoute).toBe(
        'browser',
      );
      // The likeness route stays the default without a stock avatar, and FULL is never browser-fed.
      expect(face({ mode: 'lite' })).toMatchObject({
        liteRoute: 'server',
        stock: null,
        audience: 'everyone',
      });
      expect(face({ mode: 'full', stock: { avatarId: WAYNE } }).liteRoute).toBe('server');
    });

    it('refuses the browser route for a real person’s likeness, for everyone, or without its socket origin', () => {
      // No stock avatar: the face would be the persona's likeness, never fed by the browser.
      expect(() => liteFace({ mode: 'lite', liteRoute: 'browser' })).toThrow(
        /media\.face\.liteRoute browser is for a vendor stock avatar only/,
      );
      expect(() => liteFace({ mode: 'lite', liteRoute: 'browser', stock: null })).toThrow(
        /real person’s likeness is never fed by the browser/,
      );
      expect(() => liteFace({ mode: 'lite', stock: { avatarId: WAYNE }, audience: 'everyone' })).toThrow(
        /media\.face\.audience must be admins when liteRoute is browser/,
      );
      // The CSP must name exactly the speak channel's origin (the room's origins alone would block it).
      expect(() => face({ mode: 'lite', stock: { avatarId: WAYNE } })).toThrow(
        /media\.face\.csp\.connect must name wss:\/\/webrtc-signaling\.heygen\.io/,
      );
      // A stock avatar in LITE is the browser route's, and LITE says our own audio (no stock voice).
      expect(() => liteFace({ mode: 'lite', liteRoute: 'server', stock: { avatarId: WAYNE } })).toThrow(
        /media\.face\.stock in LITE names only the stock avatar of the browser route/,
      );
      expect(() => liteFace({ mode: 'lite', stock: { avatarId: WAYNE, voiceId: VOICE } })).toThrow(
        /media\.face\.stock in LITE/,
      );
      expect(() => liteFace({ mode: 'full', liteRoute: 'browser', stock: { avatarId: WAYNE } })).toThrow(
        /media\.face\.liteRoute is LITE mode only/,
      );
      expect(() => liteFace({ mode: 'lite', liteRoute: 'tab', stock: { avatarId: WAYNE } })).toThrow(
        /media\.face\.liteRoute must be one of server, browser/,
      );
      // No stock key, or an explicit null, is LITE with the persona's own face, on the server's relay.
      expect(face({ mode: 'lite', stock: null })).toMatchObject({
        mode: 'lite',
        stock: null,
        liteRoute: 'server',
      });
    });

    it('refuses malformed values', () => {
      expect(() => face({ mode: 'FULL', stock: { avatarId: WAYNE } })).toThrow(
        /media\.face\.mode must be one of lite, full/,
      );
      expect(() => face({ audience: 'founders' })).toThrow(
        /media\.face\.audience must be one of admins, everyone/,
      );
      expect(() => face({ mode: 'full', stock: { avatarId: 'Wayne' } })).toThrow(
        /media\.face\.stock\.avatarId/,
      );
      expect(() => face({ mode: 'full', stock: { avatarId: WAYNE.toUpperCase() } })).toThrow(ConfigError);
      expect(() => face({ mode: 'full', stock: { avatarId: WAYNE, voiceId: '' } })).toThrow(
        /media\.face\.stock\.voiceId/,
      );
      expect(() => face({ mode: 'full', stock: { avatarId: WAYNE, contextId: WAYNE } })).toThrow(
        /media\.face\.stock has unknown keys: contextId/,
      );
      expect(() => face({ mode: 'full', stock: [WAYNE] })).toThrow(/media\.face\.stock must be an object/);
    });
  });

  it('keeps the CSP strict: exact origins only, and none while no face is wired', () => {
    const room = ['wss://heygen-feapbkvq.livekit.cloud', 'https://heygen-feapbkvq.livekit.cloud'];
    const media = (face: Record<string, unknown>, voice: Record<string, unknown> = {}) => ({
      ...valid(),
      media: {
        face: { provider: 'heygen-liveavatar', sandbox: false, csp: { connect: room, media: [] }, ...face },
        voice: { provider: 'polly', model: 'eleven_flash_v2_5', zeroRetention: false, ...voice },
      },
    });
    expect(parseConfig(media({})).media.face.csp.connect).toEqual(room);
    // A wired face with a CSP that blocks its room would never show: refused at synth, not found in a session.
    for (const connect of [[], [room[0]], [room[1]]]) {
      expect(() => parseConfig(media({ csp: { connect, media: [] } }))).toThrow(
        /media.face.csp.connect.*wss:\/\/ and https:\/\/ origins/,
      );
    }
    expect(() => parseConfig(media({ csp: { connect: ['wss://*.livekit.cloud'], media: [] } }))).toThrow(
      /exact wss:\/\/ or https:\/\/ origin/,
    );
    expect(() => parseConfig(media({ csp: { connect: ['https://host.example/path'], media: [] } }))).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(media({ csp: { connect: ['http://host.example'], media: [] } }))).toThrow(
      ConfigError,
    );
    expect(() =>
      parseConfig(
        media({ provider: 'none', csp: { connect: ['wss://heygen-feapbkvq.livekit.cloud'], media: [] } }),
      ),
    ).toThrow(/must be empty while media.face.provider is none/);
    expect(() => parseConfig(media({ provider: 'tavus' }))).toThrow(/media.face.provider/);
    expect(() => parseConfig(media({}, { provider: 'cartesia' }))).toThrow(/media.voice.provider/);
    expect(() => parseConfig(media({}, { model: 'Bad Model' }))).toThrow(/media.voice.model/);
  });

  it('turns speech and the distillation sweep off when their sections are absent', () => {
    const raw = valid();
    delete raw.speech;
    delete raw.distillation;
    const config = parseConfig(raw);
    expect(config.speech.enabled).toBe(false);
    expect(config.distillation.sweepEnabled).toBe(false);
    expect(config.distillation.sweepIntervalMinutes).toBe(15);
  });

  it('treats reserved concurrency as optional (null or absent = unreserved)', () => {
    expect(parseConfig(valid()).api.reservedConcurrency).toBe(10);
    expect(parseConfig(withChange(['api', 'reservedConcurrency'], null)).api.reservedConcurrency).toBeNull();
    const absent = valid();
    delete (absent.api as Record<string, unknown>).reservedConcurrency;
    expect(parseConfig(absent).api.reservedConcurrency).toBeNull();
    expect(parseConfig(valid()).worker.reservedConcurrency).toBeNull();
    expect(parseConfig({ ...valid(), worker: { reservedConcurrency: 3 } }).worker.reservedConcurrency).toBe(
      3,
    );
    expect(parseConfig({ ...valid(), worker: {} }).worker.reservedConcurrency).toBeNull();
  });

  it('accepts the documented shape', () => {
    const config = parseConfig(valid());
    expect(config.owner).toMatchObject({
      accessCodePrefix: PLACEHOLDER_OWNER.prefix,
      accessCodeHash: PLACEHOLDER_OWNER.hash,
    });
    expect(config.models.luna).toEqual({ modelId: 'openai.gpt-6-luna', enabled: false });
  });

  it('treats the Luna block as optional', () => {
    const raw = valid();
    delete (raw.models as Record<string, unknown>).luna;
    expect(parseConfig(raw).models.luna).toBeUndefined();
  });

  it.each([
    [['region'], 'eu-west-1', /us-east-1/],
    [['owner', 'accessCodePrefix'], 'T930I', /accessCodePrefix/], // I is not Crockford base32
    [['owner', 'accessCodeHash'], 'bcrypt$2b$10$abc', /accessCodeHash/],
    [['aurora', 'minCapacityAcu'], 0.3, /minCapacityAcu/],
    [['aurora', 'maxCapacityAcu'], 0, /maxCapacityAcu/],
    [['aurora', 'autoPauseMinutes'], 2, /autoPauseMinutes/],
    [['api', 'timeoutSeconds'], 900, /timeoutSeconds/],
    [['api', 'timeoutSeconds'], 50, /timeoutSeconds/], // shorter than the 40 s resume budget + 15 s margin
    [['api', 'reservedConcurrency'], 0, /reservedConcurrency/],
    [['api', 'reservedConcurrency'], '10', /reservedConcurrency/],
    [['logRetentionDays'], 31, /logRetentionDays/],
    [['githubRepository'], 'not a repo', /githubRepository/],
    [['githubOwnerId'], 'satvikOS', /githubOwnerId/],
    [['githubRepositoryId'], '0123', /githubRepositoryId/],
    [['models', 'primary'], '', /models.primary/],
    [['models', 'luna', 'enabled'], 'yes', /models.luna.enabled/],
    [['models', 'luna', 'modelId'], 'GPT 6', /models.luna.modelId/],
    [['speech'], 'on', /\$\.speech must be an object/],
    [['speech', 'enabled'], 'true', /speech.enabled/],
    [['speech', 'engine'], 'standard', /speech.engine must be one of neural, generative/],
    [['speech', 'engine'], 'long-form', /speech.engine/],
    // The platform voice is packages/core/speech-voices.json, which the API reads; a voice here reaches nobody.
    [
      ['speech', 'defaultVoice'],
      'Matthew',
      /speech.defaultVoice is not read: the platform voice is platformVoice/,
    ],
    [['speech', 'dailyAlarmUsd'], undefined, /speech.dailyAlarmUsd/],
    [['speech', 'dailyAlarmUsd'], 0, /speech.dailyAlarmUsd/],
    [['speech', 'dailyAlarmUsd'], 101, /speech.dailyAlarmUsd/],
    [['speech', 'dailyAlarmUsd'], 1.005, /speech.dailyAlarmUsd/],
    [['speech', 'dailyAlarmUsd'], '15', /speech.dailyAlarmUsd/],
    [['distillation', 'sweepEnabled'], 1, /distillation.sweepEnabled/],
    [['distillation', 'sweepIntervalMinutes'], 1, /distillation.sweepIntervalMinutes/],
    [['distillation', 'sweepIntervalMinutes'], 90, /distillation.sweepIntervalMinutes/],
    [['distillation', 'sweepIntervalMinutes'], 7.5, /distillation.sweepIntervalMinutes/],
  ])('rejects %j = %j', (path, value, message) => {
    expect(() => parseConfig(withChange(path, value))).toThrow(ConfigError);
    expect(() => parseConfig(withChange(path, value))).toThrow(message);
  });

  it('reports unreadable files clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-config-'));
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(() => loadConfig(file)).toThrow(/Cannot read/);
  });
});

describe('migrationsChecksum', () => {
  it('covers every migration file and ignores everything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-migrations-'));
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE a (id int);\n', 'utf8');
    const first = migrationsChecksum(dir);
    writeFileSync(join(dir, 'README.md'), 'notes', 'utf8');
    expect(migrationsChecksum(dir)).toBe(first);
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE a (id int);\r\n', 'utf8');
    expect(migrationsChecksum(dir)).toBe(first); // CRLF-normalised like the generated bundle
    writeFileSync(join(dir, '0002_more.sql'), 'CREATE TABLE b (id int);\n', 'utf8');
    expect(migrationsChecksum(dir)).not.toBe(first);
  });

  it('fails when there is nothing to migrate', () => {
    expect(() => migrationsChecksum(mkdtempSync(join(tmpdir(), 'foundry-empty-')))).toThrow(/No migrations/);
  });
});
