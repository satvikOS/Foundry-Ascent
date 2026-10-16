import { randomInt } from 'node:crypto';

import { type ModelGateway } from '@foundry/ai';
import { type Db } from '@foundry/db';

import { type CoreConfig } from './config.js';
import {
  noopCoreLogger,
  randomIds,
  systemClock,
  type Clock,
  type CoreLogger,
  type IdGenerator,
  type JobQueue,
  type ObjectStore,
  type SpeechSynthesizer,
  type SttGrantIssuer,
  type TextExtractor,
} from './ports.js';

/** Everything core needs from its host (apps/api handlers or tests). Create once per container. */
export interface CoreDeps {
  readonly db: Db;
  /** `createModelGateway(modelGatewayConfigFromEnv(env))` once per container, or `MockModelGateway` in tests. */
  readonly gateway: ModelGateway;
  readonly config: CoreConfig;
  readonly objectStore: ObjectStore;
  readonly jobQueue: JobQueue;
  /** Required by the ingestion worker only. */
  readonly textExtractor?: TextExtractor;
  /** Text-to-speech for calls (API only). Absent: the speech endpoint answers `speech_unavailable`. */
  readonly speech?: SpeechSynthesizer;
  /** Speech-to-text grants for calls (API only). Absent: calls start without one and the founder types. */
  readonly sttGrants?: SttGrantIssuer;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: CoreLogger;
  /** Uniform random number in [0, 1) for review sampling (injectable for tests). */
  readonly random?: () => number;
}

/** Deps with every optional port resolved. */
export interface ResolvedDeps extends CoreDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: CoreLogger;
  readonly random: () => number;
}

function cryptoRandom(): number {
  return randomInt(0, 2 ** 31) / 2 ** 31;
}

export function resolveDeps(deps: CoreDeps): ResolvedDeps {
  return {
    ...deps,
    clock: deps.clock ?? systemClock,
    ids: deps.ids ?? randomIds,
    logger: deps.logger ?? noopCoreLogger,
    random: deps.random ?? cryptoRandom,
  };
}
