import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';
import { migrationsChecksum } from '../src/lib/migrations.js';

const valid = (): Record<string, unknown> => ({
  region: 'us-east-1',
  githubRepository: 'satvikOS/Foundry-Ascent',
  githubBranch: 'main',
  homeTenant: { slug: 'ain', name: 'Ain Foundry' },
  owner: {
    displayName: 'Platform Owner',
    accessCodePrefix: 'T9302',
    accessCodeHash:
      'scrypt$N=32768,r=8,p=1$3EVOFO9pqROC_L4H7mo98g$RtIal90yLMyXBPUP_M2t51rYP2irq5D3k3DB6iweVY8',
  },
  models: {
    primary: 'us.amazon.nova-2-lite-v1:0',
    fallback: 'global.amazon.nova-2-lite-v1:0',
    embeddings: 'amazon.titan-embed-text-v2:0',
    luna: { modelId: 'openai.gpt-6-luna', enabled: false, note: 'gated' },
  },
  aurora: { minCapacityAcu: 0, maxCapacityAcu: 2, autoPauseMinutes: 10, engineVersion: '16.13' },
  api: { reservedConcurrency: 10, memoryMb: 1024, timeoutSeconds: 60 },
  logRetentionDays: 30,
});

const withChange = (path: string[], value: unknown): Record<string, unknown> => {
  const config = valid();
  let node = config;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path[path.length - 1] ?? ''] = value;
  return config;
};

describe('config', () => {
  it('loads config/production.json', () => {
    const config = loadConfig();
    expect(config.region).toBe('us-east-1');
    expect(config.aurora).toEqual({
      minCapacityAcu: 0,
      maxCapacityAcu: 2,
      autoPauseMinutes: 10,
      engineVersion: '16.13',
    });
    expect(config.api.reservedConcurrency).toBe(10);
  });

  it('accepts the documented shape', () => {
    const config = parseConfig(valid());
    expect(config.owner.accessCodePrefix).toBe('T9302');
    expect(config.models.luna).toEqual({ modelId: 'openai.gpt-6-luna', enabled: false });
  });

  it('treats the Luna block as optional', () => {
    const raw = valid();
    delete (raw.models as Record<string, unknown>).luna;
    expect(parseConfig(raw).models.luna).toBeUndefined();
  });

  it.each([
    [['region'], 'eu-west-1', /us-east-1/],
    [['owner', 'accessCodePrefix'], 'T930I', /accessCodePrefix/], // I is not Crockford base32
    [['owner', 'accessCodeHash'], 'bcrypt$2b$10$abc', /accessCodeHash/],
    [['aurora', 'minCapacityAcu'], 0.3, /minCapacityAcu/],
    [['aurora', 'maxCapacityAcu'], 0, /maxCapacityAcu/],
    [['aurora', 'autoPauseMinutes'], 2, /autoPauseMinutes/],
    [['api', 'timeoutSeconds'], 900, /timeoutSeconds/],
    [['logRetentionDays'], 31, /logRetentionDays/],
    [['githubRepository'], 'not a repo', /githubRepository/],
    [['models', 'primary'], '', /models.primary/],
    [['models', 'luna', 'enabled'], 'yes', /models.luna.enabled/],
    [['models', 'luna', 'modelId'], 'GPT 6', /models.luna.modelId/],
  ])('rejects %j = %j', (path, value, message) => {
    expect(() => parseConfig(withChange(path, value))).toThrow(ConfigError);
    expect(() => parseConfig(withChange(path, value))).toThrow(message);
  });

  it('reports unreadable files clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-config-'));
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(() => loadConfig(file)).toThrow(/Cannot read/);
  });
});

describe('migrationsChecksum', () => {
  it('covers every migration file and ignores everything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-migrations-'));
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE a (id int);\n', 'utf8');
    const first = migrationsChecksum(dir);
    writeFileSync(join(dir, 'README.md'), 'notes', 'utf8');
    expect(migrationsChecksum(dir)).toBe(first);
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE a (id int);\r\n', 'utf8');
    expect(migrationsChecksum(dir)).toBe(first); // CRLF-normalised like the generated bundle
    writeFileSync(join(dir, '0002_more.sql'), 'CREATE TABLE b (id int);\n', 'utf8');
    expect(migrationsChecksum(dir)).not.toBe(first);
  });

  it('fails when there is nothing to migrate', () => {
    expect(() => migrationsChecksum(mkdtempSync(join(tmpdir(), 'foundry-empty-')))).toThrow(/No migrations/);
  });
});
