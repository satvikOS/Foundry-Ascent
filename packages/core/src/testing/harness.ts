import { randomBytes } from 'node:crypto';

import { MockModelGateway, type MockModelGatewayOptions } from '@foundry/ai';
import { principalsRepo, type SeedResult, type SeededVenture } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';

import { coreConfig, type CoreConfig } from '../config.js';
import { createRequestContext, type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { type Clock } from '../ports.js';
import { MemoryJobQueue, MemoryObjectStore, RecordingLogger, Utf8TextExtractor } from './fakes.js';

type ConfigOverrides = Parameters<typeof coreConfig>[0];

export interface CoreHarnessOptions {
  readonly config?: ConfigOverrides;
  readonly random?: () => number;
  readonly gatewayOptions?: MockModelGatewayOptions;
  readonly clock?: Clock;
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
  const gateway = new MockModelGateway(options.gatewayOptions);
  const objectStore = new MemoryObjectStore();
  const jobQueue = new MemoryJobQueue();
  const logger = new RecordingLogger();
  const build = (cfg: CoreConfig): Core =>
    createCore({
      db: t.db,
      gateway,
      config: cfg,
      objectStore,
      jobQueue,
      textExtractor: new Utf8TextExtractor(),
      logger,
      ...(options.random ? { random: options.random } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
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
    cleanup: () => t.cleanup(),
  };
}
