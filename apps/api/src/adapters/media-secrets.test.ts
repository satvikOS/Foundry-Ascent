import { type GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it } from 'vitest';

import { DevelopmentVoice, developmentVoiceFor, standInPcm } from './development-voice.js';
import { MediaSecretError, MediaSecrets, SECRET_CACHE_MS } from './media-secrets.js';

/** The error a promise rejects with (fails the test when it resolves). */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a failure');
}

function client(values: Record<string, string | Error>) {
  const asked: string[] = [];
  const send = (command: GetSecretValueCommand): Promise<unknown> => {
    const id = String(command.input.SecretId);
    asked.push(id);
    const value = values[id];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve({ SecretString: value });
  };
  return { client: { send } as unknown as Pick<SecretsManagerClient, 'send'>, asked };
}

describe('MediaSecrets', () => {
  it('reads a vendor key on first use only, caches it for five minutes, then reads it again', async () => {
    let now = 1_000_000;
    const { client: c, asked } = client({ 'foundry-ascent/media/heygen': '{"apiKey":" la-key "}' });
    const secrets = new MediaSecrets({ region: 'us-east-1', client: c, now: () => now });
    const key = secrets.apiKey('foundry-ascent/media/heygen');
    expect(asked).toEqual([]);
    expect(await key()).toBe('la-key');
    expect(await key()).toBe('la-key');
    expect(asked).toHaveLength(1);
    now += SECRET_CACHE_MS + 1;
    await key();
    expect(asked).toHaveLength(2);
  });

  it('refuses a secret that is not {"apiKey": …}, names the secret and never the value, and caches no failure', async () => {
    const denied = new Error('AccessDeniedException: secret-value-here');
    denied.name = 'AccessDeniedException';
    const { client: c, asked } = client({
      'foundry-ascent/media/elevenlabs': 'plain-text-key',
      'foundry-ascent/media/empty': '{"apiKey":""}',
      'foundry-ascent/media/denied': denied,
    });
    const secrets = new MediaSecrets({ region: 'us-east-1', client: c });
    const plain = await failure(secrets.apiKey('foundry-ascent/media/elevenlabs')());
    expect(plain).toBeInstanceOf(MediaSecretError);
    expect(plain.message).toContain('foundry-ascent/media/elevenlabs');
    expect(plain.message).not.toContain('plain-text-key');
    expect(await failure(secrets.apiKey('foundry-ascent/media/empty')())).toBeInstanceOf(MediaSecretError);
    const refused = await failure(secrets.apiKey('foundry-ascent/media/denied')());
    expect(refused.message).not.toContain('secret-value-here');
    await failure(secrets.apiKey('foundry-ascent/media/denied')());
    expect(asked.filter((id) => id === 'foundry-ascent/media/denied')).toHaveLength(2);
  });
});

describe('the development stand-in voice', () => {
  it('runs on the local API only', () => {
    expect(developmentVoiceFor({ APP_ENV: 'development' })).toEqual({});
    expect(
      developmentVoiceFor({ APP_ENV: 'development', VOICE_CLONE_PROVIDER: 'fake' }).clonedVoice,
    ).toBeInstanceOf(DevelopmentVoice);
    expect(() => developmentVoiceFor({ APP_ENV: 'production', VOICE_CLONE_PROVIDER: 'fake' })).toThrow(
      /local development only/,
    );
    expect(() => developmentVoiceFor({ APP_ENV: 'development', VOICE_CLONE_PROVIDER: 'elevenlabs' })).toThrow(
      /must be "fake"/,
    );
  });

  it('hums instead of speaking: never the words, free, PCM for a face and WAV for the speakers', async () => {
    const voice = new DevelopmentVoice();
    expect(voice).toMatchObject({ id: 'fake', usdPer1kCharacters: 0 });
    const unit = { text: 'Hello there.', sig: 'x', seq: 0, turnId: null, sessionId: 's' } as never;
    const pcm = await voice.synthesize({ unit, voiceRef: 'v', format: 'pcm_24000', requestId: 'r' });
    expect(pcm).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 24_000, characters: 12 });
    const bytes = new Uint8Array(await new Response(pcm.audio).arrayBuffer());
    expect(bytes).toEqual(standInPcm(12));
    expect(new TextDecoder().decode(bytes)).not.toContain('Hello');
    const wav = await voice.synthesize({ unit, voiceRef: 'v', format: 'mp3', requestId: 'r' });
    expect(wav.contentType).toBe('audio/wav');
  });
});
