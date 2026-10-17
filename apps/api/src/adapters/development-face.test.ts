import { describe, expect, it } from 'vitest';

import { DevelopmentFaceIssuer, developmentFaceFor } from './development-face.js';

const request = {
  callId: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  personaId: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
  avatarRef: null,
  maxSeconds: 1800,
  requestId: 'req-1',
};

describe('the development stand-in face', () => {
  it('is off unless asked for', () => {
    expect(developmentFaceFor({ APP_ENV: 'development' })).toEqual({});
    expect(developmentFaceFor({ APP_ENV: 'development', EMBODIMENT_PROVIDER: ' ' })).toEqual({});
  });

  it('runs on the local API only, and only as the stand-in', () => {
    expect(
      developmentFaceFor({ APP_ENV: 'development', EMBODIMENT_PROVIDER: 'fake' }).embodiment,
    ).toBeInstanceOf(DevelopmentFaceIssuer);
    for (const appEnv of ['production', 'staging', 'test', undefined]) {
      expect(() => developmentFaceFor({ APP_ENV: appEnv, EMBODIMENT_PROVIDER: 'fake' })).toThrow(
        /local development only/,
      );
    }
    expect(() => developmentFaceFor({ APP_ENV: 'development', EMBODIMENT_PROVIDER: 'heygen' })).toThrow(
      /must be "fake"/,
    );
  });

  it('mints a random single-use token that expires within a minute and never outlives the call', async () => {
    const face = new DevelopmentFaceIssuer();
    expect(face).toMatchObject({ provider: 'fake', voicing: 'audio', likeness: false });
    const a = await face.start(request);
    const b = await face.start(request);
    expect(a.token).toMatch(/^fake\.[\w-]{24}$/);
    expect(a.token).not.toBe(b.token);
    const lifetime = Date.parse(a.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(50_000);
    expect(lifetime).toBeLessThanOrEqual(60_000);
    const short = await face.start({ ...request, maxSeconds: 20 });
    expect(Date.parse(short.expiresAt) - Date.now()).toBeLessThanOrEqual(20_000);
  });
});
