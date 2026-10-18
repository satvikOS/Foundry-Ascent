import {
  type EnvLike,
  FACE_SAMPLE_RATE,
  type SynthesizedSpeech,
  type VoiceProvider,
  type VoiceSynthesisInput,
  pcmToWav,
} from '@foundry/core';

/**
 * A soft 220 Hz hum, 50 ms per character of the unit (never speech, never the words): what the development
 * stand-in "says". 16-bit mono at 24 kHz, the face's rate.
 */
export function standInPcm(characters: number): Uint8Array {
  const samples = Math.max(FACE_SAMPLE_RATE / 10, Math.round(characters * 0.05 * FACE_SAMPLE_RATE));
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    const fade = Math.min(1, i / 1200, (samples - i) / 1200);
    view.setInt16(
      i * 2,
      Math.round(Math.sin((2 * Math.PI * 220 * i) / FACE_SAMPLE_RATE) * 1500 * fade),
      true,
    );
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The development stand-in for an EIR's cloned voice (core `VoiceProvider` port): with `VOICE_CLONE_PROVIDER=fake`
 * the local API voices a persona whose voice is ready under voice consent (Studio › Consent) once cloned voices are
 * switched on, with a hum instead of words. It exercises the whole path (call start, verified units only,
 * metering at no cost, the face's PCM) without a vendor account or network.
 */
export class DevelopmentVoice implements VoiceProvider {
  readonly id = 'fake' as const;
  readonly model = 'stand_in';
  readonly usdPer1kCharacters = 0;

  synthesize(input: VoiceSynthesisInput): Promise<SynthesizedSpeech> {
    const pcm = standInPcm(input.unit.text.length);
    return Promise.resolve(
      input.format === 'pcm_24000'
        ? {
            audio: streamOf(pcm),
            contentType: 'audio/pcm',
            sampleRateHertz: FACE_SAMPLE_RATE,
            characters: input.unit.text.length,
            engine: 'clone',
            voiceId: input.voiceRef,
          }
        : {
            audio: streamOf(pcmToWav(pcm, FACE_SAMPLE_RATE)),
            contentType: 'audio/wav',
            characters: input.unit.text.length,
            engine: 'clone',
            voiceId: input.voiceRef,
          },
    );
  }
}

/** `VOICE_CLONE_PROVIDER=fake` on the local API only (refused anywhere else, like the stand-in face). */
export function developmentVoiceFor(env: EnvLike): { clonedVoice?: VoiceProvider } {
  const wanted = env.VOICE_CLONE_PROVIDER?.trim().toLowerCase() ?? '';
  if (wanted === '') return {};
  if (wanted !== 'fake') throw new Error('VOICE_CLONE_PROVIDER must be "fake" (the development stand-in)');
  if (env.APP_ENV !== 'development')
    throw new Error('VOICE_CLONE_PROVIDER=fake is for local development only');
  return { clonedVoice: new DevelopmentVoice() };
}
