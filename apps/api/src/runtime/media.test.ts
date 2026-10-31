import { type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it } from 'vitest';

import { ElevenLabsVoice } from '../adapters/elevenlabs-voice.js';
import { HeygenLiveAvatarFace } from '../adapters/heygen-liveavatar.js';
import { MediaSecrets } from '../adapters/media-secrets.js';
import { loadApiConfig } from '../config.js';
import { mediaFor } from './api.js';

const prod = {
  APP_ENV: 'production',
  DOCUMENTS_BUCKET: 'foundry-ascent-documents',
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/FoundryAscent-Jobs',
};

/** Secrets that count reads: wiring the adapters must read none. */
function counting() {
  let reads = 0;
  const client = {
    send: () => {
      reads += 1;
      return Promise.resolve({ SecretString: '{"apiKey":"k"}' });
    },
  } as unknown as Pick<SecretsManagerClient, 'send'>;
  return { secrets: new MediaSecrets({ region: 'us-east-1', client }), reads: () => reads };
}

describe('digital-twin wiring', () => {
  it('wires nothing by default: every call keeps the presence and the stock voices', () => {
    const { secrets, reads } = counting();
    expect(mediaFor(loadApiConfig(prod, 'api'), secrets)).toEqual({});
    expect(reads()).toBe(0);
  });

  it('wires LiveAvatar and ElevenLabs when configured, without reading a key until one is needed', () => {
    const { secrets, reads } = counting();
    const media = mediaFor(
      loadApiConfig(
        { ...prod, MEDIA_FACE_PROVIDER: 'heygen-liveavatar', MEDIA_VOICE_PROVIDER: 'elevenlabs' },
        'api',
      ),
      secrets,
    );
    expect(media.embodiment).toBeInstanceOf(HeygenLiveAvatarFace);
    expect(media.embodiment).toMatchObject({ id: 'heygen', likeness: true, usdPerMinute: 0.093 });
    expect(media.clonedVoice).toBeInstanceOf(ElevenLabsVoice);
    expect(media.clonedVoice).toMatchObject({ model: 'eleven_flash_v2_5', usdPer1kCharacters: 0.04 });
    expect(reads()).toBe(0);
  });

  it('wires a FULL stock face at its own price, admins only by default, with the LITE path unchanged', () => {
    const { secrets, reads } = counting();
    const media = mediaFor(
      loadApiConfig(
        {
          ...prod,
          MEDIA_FACE_PROVIDER: 'heygen-liveavatar',
          MEDIA_FACE_MODE: 'full',
          MEDIA_FACE_SANDBOX: 'true',
        },
        'api',
      ),
      secrets,
    );
    expect(media.embodiment).toMatchObject({
      id: 'heygen',
      mode: 'full',
      voicing: 'text',
      likeness: false,
      stock: true,
      sandbox: true,
      adminsOnly: true,
      usdPerMinute: 0.19,
    });
    const lite = mediaFor(
      loadApiConfig({ ...prod, MEDIA_FACE_PROVIDER: 'heygen-liveavatar' }, 'api'),
      secrets,
    );
    expect(lite.embodiment).toMatchObject({
      mode: 'lite',
      voicing: 'audio',
      likeness: true,
      adminsOnly: false,
    });
    expect(reads()).toBe(0);
  });
});
