import { type EnvLike, type SpeechSynthesizer, type SttGrantIssuer } from '@foundry/core';

import { type ApiConfig } from '../config.js';
import { speechFor, sttGrantsFor } from './api.js';

/**
 * Speech for the LOCAL dev server, only when asked: `LOCAL_AWS_SPEECH=true` gives calls Amazon Polly
 * (`POST /speech`) and Amazon Transcribe streaming grants, exactly as the deployed API wires them (`speechFor`,
 * `sttGrantsFor`: they also need `MODEL_PROVIDER=bedrock` and `SPEECH_ENABLED` not `false`). The conversation lab
 * (docs/runbooks/conversation-lab.md) sets it to run true voice calls headless with its own AWS role. Without it,
 * local development stays as before: no AWS speech, `POST /speech` answers 501 and calls are typed. Opt-in on
 * purpose: credentials allowed to call the models locally must not also start paying for speech unasked.
 */
export function localSpeechFor(
  env: EnvLike,
  config: ApiConfig,
): { speech?: SpeechSynthesizer; sttGrants?: SttGrantIssuer } {
  if (env.LOCAL_AWS_SPEECH?.trim().toLowerCase() !== 'true') return {};
  return { ...speechFor(env, config), ...sttGrantsFor(env, config) };
}
