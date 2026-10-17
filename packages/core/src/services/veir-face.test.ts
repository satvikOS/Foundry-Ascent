import { describe, expect, it } from 'vitest';

import { FakeEmbodimentSessionIssuer } from '../testing/fakes.js';
import { faceIssuer } from './veir.js';

describe('faceIssuer: which face a persona’s calls get', () => {
  const standIn = new FakeEmbodimentSessionIssuer('fake', 'audio', false);
  const vendor = new FakeEmbodimentSessionIssuer('heygen', 'audio', true);

  it('keeps the presence when no face is configured', () => {
    expect(faceIssuer(undefined, { provider: 'heygen', likenessConsented: true })).toBeNull();
  });

  it('serves the stand-in to any persona: it draws no one', () => {
    expect(faceIssuer(standIn, { provider: 'builtin', likenessConsented: false })).toBe(standIn);
  });

  it('serves a vendor likeness only to a persona configured for it, under likeness consent', () => {
    expect(faceIssuer(vendor, { provider: 'heygen', likenessConsented: true })).toBe(vendor);
    expect(faceIssuer(vendor, { provider: 'heygen', likenessConsented: false })).toBeNull();
    expect(faceIssuer(vendor, { provider: 'builtin', likenessConsented: true })).toBeNull();
    expect(faceIssuer(vendor, { provider: 'tavus', likenessConsented: true })).toBeNull();
  });
});
