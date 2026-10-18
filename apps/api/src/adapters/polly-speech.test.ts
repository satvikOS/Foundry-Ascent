import { type PollyClient, type SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { SpeechSynthesisError } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { loadApiConfig } from '../config.js';
import { callSpeechEnabled, speechFor } from '../runtime/api.js';
import { PollySpeechSynthesizer, preferEngine } from './polly-speech.js';

function named(name: string): Error {
  const err = new Error(`${name} raised by the fake`);
  err.name = name;
  return err;
}

/** A Polly client answering per engine: audio bytes, or a thrown error. */
function fakeClient(outcomes: Record<string, Error | string>): {
  client: Pick<PollyClient, 'send'>;
  sent: SynthesizeSpeechCommand['input'][];
} {
  const sent: SynthesizeSpeechCommand['input'][] = [];
  const send = (command: SynthesizeSpeechCommand): Promise<unknown> => {
    sent.push(command.input);
    const outcome = outcomes[command.input.Engine ?? 'standard'];
    if (outcome instanceof Error) return Promise.reject(outcome);
    const bytes = new TextEncoder().encode(outcome ?? '');
    return Promise.resolve({
      ContentType: 'audio/mpeg',
      RequestCharacters: command.input.Text?.length,
      AudioStream: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      },
    });
  };
  return { client: { send }, sent };
}

const input = { text: 'Rerun the map in exam weeks.', voiceId: 'Ruth', requestId: 'req-1' } as const;

describe('PollySpeechSynthesizer', () => {
  it('synthesizes MP3 with the deployment engine first', async () => {
    const { client, sent } = fakeClient({ neural: 'neural-audio', generative: 'never-reached' });
    const speech = await new PollySpeechSynthesizer({
      region: 'us-east-1',
      engine: 'neural',
      client,
    }).synthesize({ ...input, engines: ['neural', 'generative'] });
    expect(speech).toMatchObject({
      contentType: 'audio/mpeg',
      engine: 'neural',
      voiceId: 'Ruth',
      characters: 28,
    });
    expect(new TextDecoder().decode(await new Response(speech.audio).arrayBuffer())).toBe('neural-audio');
    expect(sent).toEqual([
      { Engine: 'neural', OutputFormat: 'mp3', Text: input.text, TextType: 'text', VoiceId: 'Ruth' },
    ]);
  });

  it('tries a generative deployment engine before the order core gives', async () => {
    const { client, sent } = fakeClient({ generative: 'gen-audio', neural: 'never-reached' });
    const speech = await new PollySpeechSynthesizer({
      region: 'us-east-1',
      engine: 'generative',
      client,
    }).synthesize({ ...input, engines: ['neural', 'generative'] });
    expect(speech.engine).toBe('generative');
    expect(sent.map((s) => s.Engine)).toEqual(['generative']);
  });

  it('falls back to the next engine when the voice does not support one', async () => {
    const { client, sent } = fakeClient({
      generative: named('EngineNotSupportedException'),
      neural: 'neural-audio',
    });
    const speech = await new PollySpeechSynthesizer({
      region: 'us-east-1',
      engine: 'generative',
      client,
    }).synthesize({ ...input, engines: ['neural', 'generative'] });
    expect(speech.engine).toBe('neural');
    expect(sent.map((s) => s.Engine)).toEqual(['generative', 'neural']);
  });

  it('reports outages as SpeechSynthesisError without the text, and lets aborts through', async () => {
    const outage = fakeClient({ neural: named('ServiceFailureException'), generative: 'never-reached' });
    const failure = new PollySpeechSynthesizer({
      region: 'us-east-1',
      engine: 'neural',
      client: outage.client,
    }).synthesize({ ...input, engines: ['neural', 'generative'] });
    await expect(failure).rejects.toBeInstanceOf(SpeechSynthesisError);
    await expect(failure).rejects.not.toThrow(input.text);
    expect(outage.sent).toHaveLength(1);
    const aborted = fakeClient({ neural: named('AbortError') });
    await expect(
      new PollySpeechSynthesizer({
        region: 'us-east-1',
        engine: 'neural',
        client: aborted.client,
      }).synthesize({
        ...input,
        engines: ['neural'],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('preferEngine', () => {
  it('moves the deployment engine to the front only when the voice has it', () => {
    expect(preferEngine(['neural', 'generative'], 'generative')).toEqual(['generative', 'neural']);
    expect(preferEngine(['neural', 'generative'], 'neural')).toEqual(['neural', 'generative']);
    expect(preferEngine(['neural'], 'generative')).toEqual(['neural']);
    expect(preferEngine(['generative'], 'neural')).toEqual(['generative']);
  });
});

describe('speech wiring', () => {
  const env = { DOCUMENTS_BUCKET: 'docs-bucket', JOBS_QUEUE_URL: 'https://sqs.test/queue' };

  it('uses Polly wherever the models run on Bedrock, and nothing on the mock model', () => {
    const config = loadApiConfig(env, 'api');
    expect(callSpeechEnabled({ ...env, MODEL_PROVIDER: 'bedrock' }, config)).toBe(true);
    expect(speechFor({ ...env, MODEL_PROVIDER: 'bedrock' }, config).speech).toBeInstanceOf(
      PollySpeechSynthesizer,
    );
    expect(speechFor({ ...env, MODEL_PROVIDER: 'mock' }, config)).toEqual({});
    expect(speechFor(env, config)).toEqual({});
  });

  it('speaks with the configured engine, neural by default', () => {
    const bedrock = { ...env, MODEL_PROVIDER: 'bedrock' };
    const engineOf = (vars: Record<string, string>): unknown => {
      const { speech } = speechFor(vars, loadApiConfig(vars, 'api'));
      return speech instanceof PollySpeechSynthesizer ? speech.engine : null;
    };
    expect(engineOf(bedrock)).toBe('neural');
    expect(engineOf({ ...bedrock, SPEECH_ENGINE: 'neural' })).toBe('neural');
    expect(engineOf({ ...bedrock, SPEECH_ENGINE: 'generative' })).toBe('generative');
  });

  it('has no Polly when infra turned speech off (SPEECH_ENABLED=false), so /speech answers 501', () => {
    const off = { ...env, MODEL_PROVIDER: 'bedrock', SPEECH_ENABLED: 'false' };
    const config = loadApiConfig(off, 'api');
    expect(callSpeechEnabled(off, config)).toBe(false);
    expect(speechFor(off, config)).toEqual({});
  });
});

describe('prewarming the Polly connection (LAB-P2)', () => {
  it('sends one free DescribeVoices request, and never rejects', async () => {
    const sent: unknown[] = [];
    const ok = new PollySpeechSynthesizer({
      region: 'us-east-1',
      engine: 'neural',
      client: {
        send: (command: { input: unknown; constructor: { name: string } }) => {
          sent.push([command.constructor.name, command.input]);
          return Promise.resolve({ Voices: [] });
        },
      },
    });
    await ok.prewarm();
    expect(sent).toEqual([['DescribeVoicesCommand', { LanguageCode: 'en-US' }]]);
    const failing = new PollySpeechSynthesizer({
      region: 'us-east-1',
      engine: 'neural',
      client: { send: () => Promise.reject(named('AccessDeniedException')) },
    });
    await expect(failing.prewarm()).resolves.toBeUndefined();
  });
});
