import { type PollyClient, type SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { SpeechSynthesisError } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { PollySpeechSynthesizer } from './polly-speech.js';

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
  it('synthesizes MP3 with the first engine the voice supports', async () => {
    const { client, sent } = fakeClient({ generative: 'gen-audio' });
    const speech = await new PollySpeechSynthesizer({ region: 'us-east-1', client }).synthesize({
      ...input,
      engines: ['generative', 'neural'],
    });
    expect(speech).toMatchObject({
      contentType: 'audio/mpeg',
      engine: 'generative',
      voiceId: 'Ruth',
      characters: 28,
    });
    expect(new TextDecoder().decode(await new Response(speech.audio).arrayBuffer())).toBe('gen-audio');
    expect(sent).toEqual([
      { Engine: 'generative', OutputFormat: 'mp3', Text: input.text, TextType: 'text', VoiceId: 'Ruth' },
    ]);
  });

  it('falls back to the next engine when the voice does not support one', async () => {
    const { client, sent } = fakeClient({
      generative: named('EngineNotSupportedException'),
      neural: 'neural-audio',
    });
    const speech = await new PollySpeechSynthesizer({ region: 'us-east-1', client }).synthesize({
      ...input,
      engines: ['generative', 'neural'],
    });
    expect(speech.engine).toBe('neural');
    expect(sent.map((s) => s.Engine)).toEqual(['generative', 'neural']);
  });

  it('reports outages as SpeechSynthesisError without the text, and lets aborts through', async () => {
    const outage = fakeClient({ generative: named('ServiceFailureException'), neural: 'never-reached' });
    const failure = new PollySpeechSynthesizer({ region: 'us-east-1', client: outage.client }).synthesize({
      ...input,
      engines: ['generative', 'neural'],
    });
    await expect(failure).rejects.toBeInstanceOf(SpeechSynthesisError);
    await expect(failure).rejects.not.toThrow(input.text);
    expect(outage.sent).toHaveLength(1);
    const aborted = fakeClient({ generative: named('AbortError') });
    await expect(
      new PollySpeechSynthesizer({ region: 'us-east-1', client: aborted.client }).synthesize({
        ...input,
        engines: ['generative'],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
