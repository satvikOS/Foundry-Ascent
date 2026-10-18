import { describe, expect, it } from 'vitest';

import { DevelopmentFace, developmentFaceFor } from './development-face.js';

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
    ).toBeInstanceOf(DevelopmentFace);
    for (const appEnv of ['production', 'staging', 'test', undefined]) {
      expect(() => developmentFaceFor({ APP_ENV: appEnv, EMBODIMENT_PROVIDER: 'fake' })).toThrow(
        /local development only/,
      );
    }
    expect(() => developmentFaceFor({ APP_ENV: 'development', EMBODIMENT_PROVIDER: 'heygen' })).toThrow(
      /must be "fake"/,
    );
  });

  it('opens a pretend session: a random token within a minute, no control channel, no one’s likeness, free', async () => {
    const face = new DevelopmentFace();
    expect(face).toMatchObject({ id: 'fake', voicing: 'audio', likeness: false, usdPerMinute: 0 });
    const a = await face.createSession(request);
    const b = await face.createSession(request);
    expect(a.browser.token).toMatch(/^fake\.[\w-]{24}$/);
    expect(a.browser.token).not.toBe(b.browser.token);
    expect(a.sessionRef).not.toBe(b.sessionRef);
    expect(a).toMatchObject({ control: null, browser: { url: null } });
    const lifetime = Date.parse(a.browser.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(50_000);
    expect(lifetime).toBeLessThanOrEqual(60_000);
    const short = await face.createSession({ ...request, maxSeconds: 20 });
    expect(Date.parse(short.browser.expiresAt) - Date.now()).toBeLessThanOrEqual(20_000);
  });
});
