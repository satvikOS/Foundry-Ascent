import { ModelUnavailableError } from '@foundry/ai';
import { DatabaseResumingError, DbError, NoRowsError } from '@foundry/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_CORE_CONFIG, coreConfig, loadConfig } from './config.js';
import { createRequestContext, toDbContext } from './context.js';
import { DomainError, isDomainError, parseInput, toDomainError } from './errors.js';
import { documentKey, storageFilename } from './services/documents.js';

describe('config', () => {
  it('defaults to the system-design values', () => {
    expect(DEFAULT_CORE_CONFIG.session).toMatchObject({ ttlSeconds: 43_200, revocationCacheSeconds: 60 });
    expect(DEFAULT_CORE_CONFIG.signIn).toMatchObject({ ipFailureLimit: 10, ipWindowSeconds: 900 });
    expect(DEFAULT_CORE_CONFIG.turns).toMatchObject({
      rateLimit: 20,
      rateWindowSeconds: 600,
      reviewSampleRate: 0.3,
    });
    expect(DEFAULT_CORE_CONFIG.retrieval).toEqual({
      memory: 8,
      chunks: 6,
      doctrine: 4,
      resources: 4,
      patterns: 2,
    });
    expect(DEFAULT_CORE_CONFIG.ingestion).toMatchObject({ chunkTokens: 800, overlapRatio: 0.15 });
  });

  it('loads the runtime-contract variables (and nothing else is required)', () => {
    const cfg = loadConfig({
      APP_ENV: 'production',
      APP_VERSION: '1.2.3',
      HOME_TENANT_SLUG: 'ain',
      SITE_ORIGIN: 'https://foundry.example.edu/',
      CORE_TURN_RATE_LIMIT: '5',
    });
    expect(cfg).toMatchObject({
      appEnv: 'production',
      appVersion: '1.2.3',
      siteOrigin: 'https://foundry.example.edu',
    });
    expect(cfg.turns.rateLimit).toBe(5);
    expect(loadConfig({}).appEnv).toBe('development');
    expect(() => loadConfig({ APP_ENV: 'staging' })).toThrow();
    expect(() => loadConfig({ CORE_TURN_RATE_LIMIT: 'many' })).toThrow();
  });

  it('merges nested overrides', () => {
    const cfg = coreConfig({ turns: { rateLimit: 2 } });
    expect(cfg.turns).toMatchObject({ rateLimit: 2, rateWindowSeconds: 600 });
  });
});

describe('request context', () => {
  it('validates ids and bounds the request id', () => {
    const ctx = createRequestContext({
      principalId: '11111111-1111-4111-8111-11111111111A',
      tenantId: '33333333-3333-4333-8333-333333333333',
      roles: ['eir', 'eir'],
      requestId: 'r'.repeat(300),
    });
    expect(ctx.principalId).toBe('11111111-1111-4111-8111-11111111111a');
    expect(ctx.roles).toEqual(['eir']);
    expect(ctx.requestId).toHaveLength(128);
    expect(toDbContext(ctx)).toEqual({
      principalId: ctx.principalId,
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
    });
    expect(() => createRequestContext({ principalId: 'x', tenantId: 'y', requestId: 'r' })).toThrow();
  });
});

describe('errors', () => {
  it('maps database and model errors to domain errors', () => {
    expect(
      toDomainError(new DatabaseResumingError({ waitedMs: 45_000, retryAfterSeconds: 7 })),
    ).toMatchObject({
      code: 'database_resuming',
      status: 503,
      retryAfterSeconds: 7,
    });
    expect(toDomainError(new NoRowsError())).toMatchObject({ code: 'not_found' });
    expect(toDomainError(new DbError('x', { sqlState: '23505' }))).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(toDomainError(new DbError('x', { sqlState: '42501' }))).toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(toDomainError(new DbError('x', { sqlState: '23514' }))).toMatchObject({
      code: 'validation_failed',
    });
    expect(toDomainError(new DbError('x', { sqlState: '55000' }))).toMatchObject({ code: 'conflict' });
    expect(toDomainError(new ModelUnavailableError('timeout', 'm'))).toMatchObject({
      code: 'model_unavailable',
    });
    const unknown = new Error('boom');
    expect(toDomainError(unknown)).toBe(unknown);
    expect(toDomainError(new DbError('x', { sqlState: 'XX000' }))).not.toBeInstanceOf(DomainError);
  });

  it('parseInput reports paths and messages but never values', () => {
    const schema = z.object({ name: z.string().min(3), n: z.number() });
    try {
      parseInput(schema, { name: 'secret-value', n: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (!isDomainError(err)) return;
      expect(err.code).toBe('validation_failed');
      expect(err.errors?.map((e) => e.path)).toEqual(['n']);
      expect(JSON.stringify(err.errors)).not.toContain('secret-value');
    }
    expect(new DomainError('rate_limited', 'slow down').retryable).toBe(true);
    expect(new DomainError('forbidden', 'no').retryable).toBe(false);
  });
});

describe('document keys', () => {
  it('builds tenants/{t}/ventures/{v}/documents/{id}/{filename} with an S3-safe name', () => {
    expect(
      documentKey({ tenantId: 't', ventureId: 'v', documentId: 'd', filename: 'Pitch deck v2.pdf' }),
    ).toBe('tenants/t/ventures/v/documents/d/Pitch-deck-v2.pdf');
    expect(storageFilename('..hidden')).toBe('hidden');
    expect(storageFilename('résumé?#.md')).toBe('resume_.md');
    expect(storageFilename('')).toBe('document');
    expect(storageFilename('a'.repeat(300))).toHaveLength(120);
  });
});
