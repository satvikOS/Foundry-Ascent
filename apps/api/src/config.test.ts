import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiConfig, loadCoreConfig } from './config.js';

const prod = {
  APP_ENV: 'production',
  APP_VERSION: 'abc1234',
  DOCUMENTS_BUCKET: 'foundry-ascent-documents',
  JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/FoundryAscent-Jobs',
  AWS_REGION: 'us-east-1',
};

describe('loadApiConfig', () => {
  it('reads the runtime contract with defaults', () => {
    expect(loadApiConfig(prod, 'api')).toEqual({
      appEnv: 'production',
      appVersion: 'abc1234',
      logLevel: 'info',
      awsRegion: 'us-east-1',
      documentsBucket: 'foundry-ascent-documents',
      jobsQueueUrl: prod.JOBS_QUEUE_URL,
      jobsMaxReceiveCount: 3,
      siteOrigin: null,
    });
    expect(
      loadApiConfig({ LOG_LEVEL: 'DEBUG', SITE_ORIGIN: 'https://foundry.example.edu/' }, 'migrate'),
    ).toMatchObject({
      appEnv: 'development',
      logLevel: 'debug',
      siteOrigin: 'https://foundry.example.edu',
    });
  });

  it('requires the bucket and queue where they are used, naming variables but not values', () => {
    expect(() => loadApiConfig({ ...prod, JOBS_QUEUE_URL: '' }, 'api')).toThrow(/JOBS_QUEUE_URL/);
    expect(() => loadApiConfig({ APP_ENV: 'production' }, 'worker')).toThrow(/DOCUMENTS_BUCKET/);
    expect(() => loadApiConfig({ APP_ENV: 'production' }, 'migrate')).not.toThrow();
    expect(() => loadApiConfig({ ...prod, DOCUMENTS_BUCKET: 'Not_A_Bucket!' }, 'api')).toThrow(ConfigError);
    try {
      loadApiConfig({ ...prod, JOBS_MAX_RECEIVE_COUNT: 'many' }, 'worker');
    } catch (err) {
      expect((err as Error).message).toBe('Invalid environment: JOBS_MAX_RECEIVE_COUNT');
    }
  });
});

describe('loadCoreConfig', () => {
  it('uses core defaults with 5-minute upload URLs', () => {
    const config = loadCoreConfig({ APP_ENV: 'test', HOME_TENANT_SLUG: 'ain' });
    expect(config.uploads.presignTtlSeconds).toBe(300);
    expect(config.session.ttlSeconds).toBe(43_200);
    expect(config.appEnv).toBe('test');
  });
});
