import { randomBytes } from 'node:crypto';

import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  MockModelGateway,
  mockCoachResponse,
  type MockGenerateContext,
  type MockModelGatewayOptions,
} from '@foundry/ai';
import { type Db, notebooksRepo, principalsRepo, type SeedResult, type SeededVenture } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';

import { coreConfig, type CoreConfig } from '../config.js';
import { createRequestContext, type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import {
  type Clock,
  type EmbodimentProvider,
  type SpeechSynthesizer,
  type SttGrantIssuer,
  type VoiceProvider,
} from '../ports.js';
import { MemoryJobQueue, MemoryObjectStore, RecordingLogger, Utf8TextExtractor } from './fakes.js';

type ConfigOverrides = Parameters<typeof coreConfig>[0];

export interface CoreHarnessOptions {
  readonly config?: ConfigOverrides;
  readonly random?: () => number;
  readonly gatewayOptions?: MockModelGatewayOptions;
  readonly clock?: Clock;
  /** Text-to-speech for calls (absent: the speech service answers `speech_unavailable`). */
  readonly speech?: SpeechSynthesizer;
  /** Speech-to-text grants for calls (absent: calls start without one). */
  readonly sttGrants?: SttGrantIssuer;
  /** Vendor faces for calls (absent: every call keeps the built-in presence). */
  readonly embodiment?: EmbodimentProvider;
  /** The EIRs' cloned voices (absent: calls speak with stock voices). */
  readonly clonedVoice?: VoiceProvider;
}

/**
 * Mock-model fixtures whose memory candidate restates the founder's message, as real models often do (the
 * built-in mock states only the topic's open fact, never the founder's words). For tests of the guards and
 * the deduplication that act on such candidates (cross-venture names, a proposal raised again).
 */
export function restatingMemoryFixtures(): NonNullable<MockModelGatewayOptions['fixtures']> {
  const restating = (context: MockGenerateContext) => {
    const response = mockCoachResponse(context);
    const said = context.founderText.trim();
    return {
      ...response,
      memory_candidates: response.memory_candidates.map((m) => ({
        ...m,
        content: said === '' ? m.content : `The founder said: “${said}” ${m.content}`,
      })),
    };
  };
  return {
    CoachResponse: restating,
    [COACH_ANNOTATIONS_SCHEMA_NAME]: (context) => {
      const { answer: _answer, spoken: _spoken, ...annotations } = restating(context);
      return annotations;
    },
  };
}

/**
 * Stores `text` as the venture's next opener without the notebook service's checks, as an opener written
 * before they existed (or by distillation) would be stored: the guards applied when a conversation or a call
 * starts must still leave it out.
 */
export async function storeOpenerUnchecked(
  h: Pick<CoreHarness, 't' | 'seed'>,
  venture: SeededVenture,
  text: string,
): Promise<void> {
  await h.t.db.system(async (sx) => {
    const key = { ventureId: venture.id, personaId: venture.personaId };
    const current = await notebooksRepo.getNotebook(sx, key);
    const saved = await notebooksRepo.saveNotebook(sx, {
      tenantId: h.seed.tenantId,
      ...key,
      expectedVersion: current?.version ?? 0,
      content: { ...(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK), nextOpener: text },
      suppressed: current?.suppressed ?? [],
      editedBy: 'veir',
    });
    if (saved === null) throw new Error('the notebook changed while storing the opener');
  });
}

/** Seed people by role (synthetic demo data). */
export interface SeedPeople {
  readonly owner: string;
  readonly lead: string;
  readonly eirCorin: string;
  readonly eirRuth: string;
  readonly maya: string;
  readonly devin: string;
  readonly priya: string;
  readonly tomasz: string;
  readonly amara: string;
  readonly graham: string;
  readonly jonah: string;
  readonly ines: string;
}

export interface CoreHarness {
  readonly t: TestDatabase;
  readonly seed: SeedResult;
  readonly core: Core;
  readonly config: CoreConfig;
  readonly gateway: MockModelGateway;
  readonly objectStore: MemoryObjectStore;
  readonly jobQueue: MemoryJobQueue;
  readonly logger: RecordingLogger;
  readonly people: SeedPeople;
  readonly ventures: Readonly<Record<'quietquad' | 'benchtally' | 'solesignal' | 'emberloop', SeededVenture>>;
  /** Request context for a principal with its current roles (as verifySession would build it). */
  ctxFor(principalId: string, tenantId?: string): Promise<RequestContext>;
  /** A second core over the same database with different config (e.g. tight limits). */
  withConfig(overrides: ConfigOverrides): Core;
  /**
   * A second core over the same database with other call ports (speech, face, cloned voice); `db` wraps the
   * database it uses (e.g. to make one query fail).
   */
  withPorts(
    ports: Pick<CoreHarnessOptions, 'speech' | 'sttGrants' | 'embodiment' | 'clonedVoice'>,
    options?: { readonly db?: (db: Db) => Db },
  ): Core;
  cleanup(): Promise<void>;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`seed is missing ${what}`);
  return value;
}

/**
 * Fresh seeded database (non-superuser owner, RLS active) + MockModelGateway + in-memory ports +
 * `createCore`. One harness per test file; call `cleanup()` in afterAll.
 */
export async function createCoreHarness(options: CoreHarnessOptions = {}): Promise<CoreHarness> {
  const t = await createTestDatabase({ seed: true });
  const seed = must(t.seed, 'seed result');
  const config = coreConfig({ appEnv: 'test', ...options.config });
  // Streams without pauses unless a test asks for them.
  const gateway = new MockModelGateway({ streamDelayMs: 0, ...options.gatewayOptions });
  const objectStore = new MemoryObjectStore();
  const jobQueue = new MemoryJobQueue();
  const logger = new RecordingLogger();
  const build = (cfg: CoreConfig, ports: CoreHarnessOptions = options, db: Db = t.db): Core =>
    createCore({
      db,
      gateway,
      config: cfg,
      objectStore,
      jobQueue,
      textExtractor: new Utf8TextExtractor(),
      logger,
      ...(options.random ? { random: options.random } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(ports.speech ? { speech: ports.speech } : {}),
      ...(ports.sttGrants ? { sttGrants: ports.sttGrants } : {}),
      ...(ports.embodiment ? { embodiment: ports.embodiment } : {}),
      ...(ports.clonedVoice ? { clonedVoice: ports.clonedVoice } : {}),
    });
  const core = build(config);
  const venture = (key: string): SeededVenture =>
    must(
      seed.ventures.find((v) => v.key === key),
      `venture ${key}`,
    );
  const person = (key: string): string => must(seed.principals[key], `principal ${key}`);
  return {
    t,
    seed,
    core,
    config,
    gateway,
    objectStore,
    jobQueue,
    logger,
    people: {
      owner: must(seed.ownerId, 'owner'),
      lead: must(seed.programLeadId, 'program lead'),
      eirCorin: person('eir-corin'),
      eirRuth: person('eir-ruth'),
      maya: person('maya'),
      devin: person('devin'),
      priya: person('priya'),
      tomasz: person('tomasz'),
      amara: person('amara'),
      graham: person('graham'),
      jonah: person('jonah'),
      ines: person('ines'),
    },
    ventures: {
      quietquad: venture('quietquad'),
      benchtally: venture('benchtally'),
      solesignal: venture('solesignal'),
      emberloop: venture('emberloop'),
    },
    async ctxFor(principalId, tenantId = seed.tenantId) {
      const roles = await t.db.system((sx) => principalsRepo.listActiveRoles(sx, { principalId, tenantId }));
      return createRequestContext({
        principalId,
        tenantId,
        roles,
        requestId: `test-${randomBytes(6).toString('hex')}`,
      });
    },
    withConfig: (overrides) => build(coreConfig({ appEnv: 'test', ...options.config, ...overrides })),
    withPorts: (ports, wrap) => build(config, ports, wrap?.db ? wrap.db(t.db) : t.db),
    cleanup: () => t.cleanup(),
  };
}
