/**
 * The vEIR's digital twin in the EIR studio: who reads and records a persona's face and cloned voice, `ready`
 * only under the scope's consent, and withdrawing one scope of a consent (the subject's own act, a program lead's
 * for a fictional EIR) without suspending anyone: the record is replaced by a copy without the scope.
 */
import { DigitalTwinView, VeirIdentity } from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';

let h: CoreHarness;
type Person = 'maya' | 'lead' | 'corin' | 'ruth';
const ctx = {} as Record<Person, RequestContext>;
const corinPersona = (): string => h.ventures.quietquad.personaId;

async function consentInForce(): Promise<string> {
  const twin = DigitalTwinView.parse(await h.core.twin.get(ctx.lead, corinPersona()));
  if (twin.consentId === null) throw new Error('no consent in force');
  return twin.consentId;
}

beforeAll(async () => {
  h = await createCoreHarness();
  ctx.maya = await h.ctxFor(h.people.maya);
  ctx.lead = await h.ctxFor(h.people.lead);
  ctx.corin = await h.ctxFor(h.people.eirCorin);
  ctx.ruth = await h.ctxFor(h.people.eirRuth);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('the digital twin in the studio', () => {
  it('shows its curators the scopes and media, never a founder or another EIR', async () => {
    const twin = DigitalTwinView.parse(await h.core.twin.get(ctx.corin, corinPersona()));
    expect(twin).toMatchObject({
      personaId: corinPersona(),
      scopes: { likeness: false, voice: true, firstPerson: true },
      face: null,
      voice: null,
      facesEnabled: false,
      clonedVoiceEnabled: false,
    });
    await expect(h.core.twin.get(ctx.maya, corinPersona())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.core.twin.get(ctx.ruth, corinPersona())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('records a voice under voice consent, a pending face without likeness, and refuses a guide', async () => {
    const voice = await h.core.twin.setMedia(ctx.corin, corinPersona(), 'voice', {
      vendorRef: 'VoiceClone01',
    });
    expect(voice.voice).toMatchObject({ vendor: 'elevenlabs', vendorRef: 'VoiceClone01', status: 'ready' });
    await expect(
      h.core.twin.setMedia(ctx.corin, corinPersona(), 'face', { vendorRef: 'avatar-1', status: 'ready' }),
    ).rejects.toMatchObject({ reason: 'likeness_consent_required' });
    const pending = await h.core.twin.setMedia(ctx.lead, corinPersona(), 'face', {
      vendorRef: 'avatar-1',
      status: 'pending',
    });
    expect(pending.face).toMatchObject({ vendor: 'heygen', status: 'pending' });
    await expect(
      h.core.twin.setMedia(ctx.lead, corinPersona(), 'face', { vendorRef: 'not an id!' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.core.twin.setMedia(ctx.lead, h.seed.personaId, 'voice', { vendorRef: 'VoiceClone01' }),
    ).rejects.toMatchObject({ reason: 'not_eir_persona' });
    await expect(
      h.core.twin.setMedia(ctx.lead, corinPersona(), 'hair', { vendorRef: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // A null id withdraws it.
    const cleared = await h.core.twin.setMedia(ctx.lead, corinPersona(), 'face', { vendorRef: null });
    expect(cleared.face?.status).toBe('withdrawn');
  });

  it('withdraws one scope as the subject, moving the vEIR to a narrower copy without suspending it', async () => {
    const before = await consentInForce();
    const result = await h.core.twin.withdrawScope(ctx.corin, before, { assetType: 'first_person' });
    expect(result.previousConsentId).toBe(before);
    expect(result.consent.assetTypes).toEqual(['doctrine', 'style', 'voice', 'cases']);
    expect(result.consent.revokedAt).toBeNull();
    // The vEIR runs on, now as "Corin's vEIR" (no first-person presence), on the new record.
    const identity = VeirIdentity.parse(await h.core.veir.identity(ctx.maya, h.ventures.quietquad.id));
    expect(identity.firstPerson).toBe(false);
    expect(await consentInForce()).toBe(result.consent.id);
    const consents = await h.core.personas.listConsents(ctx.corin, corinPersona());
    expect(consents.find((c) => c.id === before)?.revokedAt).not.toBeNull();
    expect(
      (await h.t.db.system((sx) => sx.query(`SELECT status FROM personas WHERE id = '${corinPersona()}'`)))
        .rows[0]?.status,
    ).toBe('active');
  });

  it('withdrawing voice drops the cloned voice and the EIR’s own stock voice, leaving the platform voice', async () => {
    const result = await h.core.twin.withdrawScope(ctx.lead, await consentInForce(), { assetType: 'voice' });
    expect(result.consent.assetTypes).not.toContain('voice');
    const twin = DigitalTwinView.parse(await h.core.twin.get(ctx.lead, corinPersona()));
    expect(twin.scopes.voice).toBe(false);
    expect(twin.voice?.status).toBe('withdrawn');
    const embodiment = await h.core.personas.getEmbodiment(ctx.lead, corinPersona());
    expect(embodiment).toMatchObject({ voiceId: null, voiceConsented: false });
    // Calls still start (the platform voice).
    const config = await h.core.veir.callConfig(ctx.maya, h.ventures.quietquad.id);
    expect(config.veir.embodiment.voiceConsented).toBe(false);
  });

  it('refuses a scope no longer in force, another EIR, and a founder', async () => {
    const consentId = await consentInForce();
    await expect(
      h.core.twin.withdrawScope(ctx.corin, consentId, { assetType: 'voice' }),
    ).rejects.toMatchObject({
      reason: 'scope_not_in_force',
    });
    await expect(
      h.core.twin.withdrawScope(ctx.ruth, consentId, { assetType: 'likeness' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.core.twin.withdrawScope(ctx.maya, consentId, { assetType: 'likeness' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.core.twin.withdrawScope(ctx.corin, consentId, { assetType: 'doctrine' as never }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
