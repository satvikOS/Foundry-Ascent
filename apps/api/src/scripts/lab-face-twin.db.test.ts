/**
 * The conversation lab's LITE face prerequisites (lab-face-twin.ts): the synthetic vEIR the seeded founder calls gets
 * a consent covering likeness and its face reference marked ready, so `app.persona_twin` (what a call reads) offers
 * the face, as it would in production after a program lead recorded both. Idempotent; never for an unknown name.
 */
import { personasRepo, twinRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from '../testing/api-harness.js';
import { LAB_FACE_FOUNDER } from './lab-face-admin.js';
import { formatLine, LAB_FACE_REFERENCE, seedLabFaceTwin } from './lab-face-twin.js';

let api: ApiHarness;

beforeAll(async () => {
  api = await createApiHarness();
});
afterAll(async () => {
  await api.cleanup();
});

describe('lab-face-twin', () => {
  it('gives the founder’s vEIR a ready face under likeness consent, once', async () => {
    const { t, people } = api.h;
    const persona = api.h.ventures.quietquad.personaId;
    const maya = await api.h.ctxFor(people.maya);
    const before = await t.db.withContext(maya, (tx) => twinRepo.personaTwin(tx, persona));
    expect(before.face).toBeNull();
    const consentBefore = await t.db.system((sx) =>
      sx.query('SELECT consent_id FROM personas WHERE id = :id', { id: { type: 'uuid', value: persona } }),
    );

    const first = await t.db.system((sx) => seedLabFaceTwin(sx));
    expect(first.personas).toBeGreaterThanOrEqual(1);
    expect(first.ready).toBe(first.personas);
    expect(first.consents).toBe(first.personas);
    expect(formatLine(first)).toBe(`lab-face-twin: personas=${String(first.personas)} face=ready`);

    const after = await t.db.withContext(maya, (tx) => twinRepo.personaTwin(tx, persona));
    expect(after.face).toEqual({ vendor: 'heygen', ref: LAB_FACE_REFERENCE });
    // The cloned voice is not touched: the LITE face speaks the call's Polly audio.
    expect(after.voice).toBeNull();
    // A new record of the same synthetic subject, the earlier scopes kept.
    const consentId = await t.db.system(async (sx) =>
      String(
        (
          await sx.query('SELECT consent_id FROM personas WHERE id = :id', {
            id: { type: 'uuid', value: persona },
          })
        ).rows[0]?.consent_id,
      ),
    );
    expect(consentId).not.toBe(String(consentBefore.rows[0]?.consent_id));
    const consent = await t.db.system((sx) => personasRepo.getConsent(sx, consentId));
    expect(consent?.assetTypes).toEqual(expect.arrayContaining(['doctrine', 'voice', 'likeness']));

    const second = await t.db.system((sx) => seedLabFaceTwin(sx));
    expect(second).toEqual({ personas: first.personas, consents: 0, ready: first.personas });
  });

  it('records nothing for a name that is not a synthetic founder', async () => {
    const result = await api.h.t.db.system((sx) => seedLabFaceTwin(sx, 'Nobody At All'));
    expect(result).toEqual({ personas: 0, consents: 0, ready: 0 });
    expect(formatLine(result)).toBe('lab-face-twin: personas=0 face=not_found');
    expect(LAB_FACE_FOUNDER).toBe('Maya Okafor-Lindqvist');
  });
});
