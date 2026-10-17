import { describe, expect, it } from 'vitest';

import { PollySpeechSynthesizer } from '../adapters/polly-speech.js';
import { TranscribeStreamingPresigner } from '../adapters/transcribe-presigner.js';
import { loadApiConfig } from '../config.js';
import { localSpeechFor } from './local-speech.js';

const lab = { MODEL_PROVIDER: 'bedrock', LOCAL_AWS_SPEECH: 'true', AWS_REGION: 'us-east-1' };
const ports = (env: Record<string, string>) => localSpeechFor(env, loadApiConfig(env, 'dev'));

describe('localSpeechFor (the dev server, conversation lab)', () => {
  it('wires Amazon Polly and Transcribe grants like the deployed API when asked, with the real model', () => {
    const wired = ports(lab);
    expect(wired.speech).toBeInstanceOf(PollySpeechSynthesizer);
    expect(wired.sttGrants).toBeInstanceOf(TranscribeStreamingPresigner);
    expect((wired.speech as PollySpeechSynthesizer).engine).toBe('neural');
    expect((ports({ ...lab, SPEECH_ENGINE: 'generative' }).speech as PollySpeechSynthesizer).engine).toBe(
      'generative',
    );
  });

  it('wires nothing unless asked: local development keeps typed calls and POST /speech 501', () => {
    expect(ports({ MODEL_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' })).toEqual({});
    expect(ports({ ...lab, LOCAL_AWS_SPEECH: 'false' })).toEqual({});
    expect(ports({ ...lab, LOCAL_AWS_SPEECH: '1' })).toEqual({});
  });

  it('never with the mock model or with speech disabled (infra speech.enabled = false)', () => {
    expect(ports({ ...lab, MODEL_PROVIDER: 'mock' })).toEqual({});
    expect(ports({ LOCAL_AWS_SPEECH: 'true' })).toEqual({});
    expect(ports({ ...lab, SPEECH_ENABLED: 'false' })).toEqual({});
  });
});
