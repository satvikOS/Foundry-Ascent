/**
 * The vEIR's digital twin over HTTP (docs/runbooks/avatars.md), with fake vendors behind the ports: the studio's
 * twin and scope withdrawal, the call's face session (`POST /calls/avatar-session`), speech that carries the
 * face-audio manifest, handing the face exactly that audio (`POST /calls/:id/face/speak`), barge-in and the end.
 * Refusals carry their problem code; nothing secret (room tokens, the control channel) reaches a log line or a
 * response other than the one the browser needs.
 */
import {
  AvatarSessionResponse,
  CallHeartbeatResponse,
  DigitalTwinView,
  ProblemDetails,
  SessionView,
  StartCallResponse,
  WithdrawConsentScopeResponse,
} from '@foundry/contracts';
import { FakeEmbodimentProvider, FakeSpeechSynthesizer, FakeVoiceProvider } from '@foundry/core/testing';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FACE_MANIFEST_HEADER, FACE_PART_HEADER } from './routes/veir.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
const speech = new FakeSpeechSynthesizer();
const face = new FakeEmbodimentProvider('heygen', true, 0.093);
const clone = new FakeVoiceProvider('elevenlabs', 0.04);
let maya: string;
let devin: string;
let owner: string;

async function json<T>(res: Response, schema: { parse: (v: unknown) => T }, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return ProblemDetails.parse(JSON.parse(text));
}

async function setting(key: string, value: string): Promise<void> {
  await api.h.t.db.system((sx) =>
    sx.query(
      `INSERT INTO platform_settings (key, value) VALUES (:k, :v::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      { k: p.text(key), v: p.text(value) },
    ),
  );
}

const quietquad = (): string => api.h.ventures.quietquad.id;
const persona = (): string => api.h.ventures.quietquad.personaId;

beforeAll(async () => {
  api = await createApiHarness({ speech, embodiment: face, clonedVoice: clone });
  [maya, devin, owner] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.ownerToken(),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

describe('the digital twin over HTTP', () => {
  let callId: string;
  let manifest: string;
  let pcm: Uint8Array;
  let consentId: string;

  it('lets curators record the twin under consent, never a founder', async () => {
    await problem(await api.request(`/personas/${persona()}/twin`, { cookie: maya }), 403);
    const before = await json(
      await api.request(`/personas/${persona()}/twin`, { cookie: owner }),
      DigitalTwinView,
    );
    expect(before).toMatchObject({ scopes: { likeness: false }, face: null, facesEnabled: false });
    const refused = await problem(
      await api.request(`/personas/${persona()}/twin/face`, {
        method: 'PATCH',
        body: { vendorRef: 'avatar-1' },
        cookie: owner,
      }),
      409,
    );
    expect(refused.detail).toMatch(/consent that covers likeness/);
    // Corin is a fictional EIR: the program lead records the consent with likeness.
    expect(
      (
        await api.request(`/personas/${persona()}/consents`, {
          body: { assetTypes: ['doctrine', 'style', 'voice', 'likeness', 'cases', 'first_person'] },
          cookie: owner,
        })
      ).status,
    ).toBe(201);
    const ready = await json(
      await api.request(`/personas/${persona()}/twin/face`, {
        method: 'PATCH',
        body: { vendorRef: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a' },
        cookie: owner,
      }),
      DigitalTwinView,
    );
    expect(ready.face).toMatchObject({ status: 'ready', vendor: 'heygen' });
    await json(
      await api.request(`/personas/${persona()}/twin/voice`, {
        method: 'PATCH',
        body: { vendorRef: 'VoiceClone01', status: 'ready' },
        cookie: owner,
      }),
      DigitalTwinView,
    );
    await problem(
      await api.request(`/personas/${persona()}/twin/face`, {
        method: 'PATCH',
        body: { vendorRef: 'a b' },
        cookie: owner,
      }),
      422,
    );
    const twin = await json(
      await api.request(`/personas/${persona()}/twin`, { cookie: owner }),
      DigitalTwinView,
    );
    if (twin.consentId === null) throw new Error('no consent in force');
    consentId = twin.consentId;
  });

  it('opens the face of a live call with a room token only, the speak channel staying on the server', async () => {
    await setting('faces_enabled', 'true');
    await setting('cloned_voice_enabled', 'true');
    const session = await json(
      await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya }),
      SessionView,
      201,
    );
    const started = await json(
      await api.request(`/sessions/${session.id}/calls`, { body: { inputMode: 'typed' }, cookie: maya }),
      StartCallResponse,
      201,
    );
    callId = started.call.id;
    const res = await api.request('/calls/avatar-session', {
      body: { ventureId: quietquad(), callId },
      cookie: maya,
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const minted = AvatarSessionResponse.parse(JSON.parse(text));
    expect(minted).toMatchObject({ provider: 'heygen', voicing: 'audio' });
    expect(minted.url).toMatch(/^wss:\/\/room-/);
    expect(text).not.toContain('control');

    // The intro: cloned voice, a WAV for the browser and the manifest for the face.
    const intro = started.intro;
    if (intro === null) throw new Error('no intro');
    const spoken = await api.request('/speech', {
      body: { sessionId: session.id, turnId: null, seq: 0, text: intro.text, sig: intro.sig },
      cookie: maya,
    });
    expect(spoken.status).toBe(200);
    expect(spoken.headers.get('content-type')).toBe('audio/wav');
    manifest = spoken.headers.get(FACE_MANIFEST_HEADER) ?? '';
    expect(manifest).toMatch(/^fa1\./);
    const wav = new Uint8Array(await spoken.arrayBuffer());
    pcm = wav.subarray(44, Math.min(wav.length, 44 + 18 * 48_000));
    expect(clone.calls.at(-1)?.format).toBe('pcm_24000');
  });

  it('hands the face exactly the audio it was given, once; anything else is refused', async () => {
    const speak = (body: Uint8Array, headers: Record<string, string>, cookie = maya) =>
      api.request(`/calls/${callId}/face/speak`, { body, headers, cookie });
    await problem(await speak(pcm, {}), 400);
    const tampered = pcm.slice();
    tampered[3] = (tampered[3] ?? 0) ^ 0xff;
    await problem(await speak(tampered, { [FACE_MANIFEST_HEADER]: manifest, [FACE_PART_HEADER]: '0' }), 422);
    await problem(
      await speak(pcm, { [FACE_MANIFEST_HEADER]: manifest, [FACE_PART_HEADER]: '0' }, devin),
      404,
    );
    expect(face.spoken).toHaveLength(0);
    const ok = await speak(pcm, { [FACE_MANIFEST_HEADER]: manifest, [FACE_PART_HEADER]: '0' });
    expect(ok.status).toBe(204);
    expect(face.spoken).toHaveLength(1);
    await problem(await speak(pcm, { [FACE_MANIFEST_HEADER]: manifest, [FACE_PART_HEADER]: '0' }), 422);
    expect(face.spoken).toHaveLength(1);
    expect((await api.request(`/calls/${callId}/face/interrupt`, { body: {}, cookie: maya })).status).toBe(
      204,
    );
    expect(face.interrupts).toHaveLength(1);
  });

  it('withdrawing likeness ends the face at once; the call goes on', async () => {
    const withdrawn = await json(
      await api.request(`/consents/${consentId}/withdraw-scope`, {
        body: { assetType: 'likeness' },
        cookie: owner,
      }),
      WithdrawConsentScopeResponse,
    );
    expect(withdrawn.consent.assetTypes).not.toContain('likeness');
    const refused = await problem(
      await api.request(`/calls/${callId}/face/speak`, {
        body: pcm,
        headers: { [FACE_MANIFEST_HEADER]: manifest, [FACE_PART_HEADER]: '0' },
        cookie: maya,
      }),
      409,
    );
    expect(refused.reason).toBe('face_not_active');
    const beat = await json(
      await api.request(`/calls/${callId}/heartbeat`, {
        body: { state: 'listening', micOpenSeconds: 0, face: 'live' },
        cookie: maya,
      }),
      CallHeartbeatResponse,
    );
    expect(beat).toMatchObject({ action: 'continue', face: 'stop' });
    expect(face.ended.at(-1)?.reason).toBe('face_stopped');
    // Idempotent: a face already gone ends again quietly, with or without the page's reason.
    expect((await api.request(`/calls/${callId}/face/end`, { body: {}, cookie: maya })).status).toBe(204);
    expect(
      (
        await api.request(`/calls/${callId}/face/end`, {
          body: { reason: 'video_unsubscribed' },
          cookie: maya,
        })
      ).status,
    ).toBe(204);
    // A reason outside the contract is refused (it is audited, so never free text).
    await problem(
      await api.request(`/calls/${callId}/face/end`, {
        body: { reason: 'whatever', vendorReason: 'two words' },
        cookie: maya,
      }),
      422,
    );
    expect(
      (await api.request(`/calls/${callId}/end`, { body: { reason: 'user' }, cookie: maya })).status,
    ).toBe(200);
  });

  it('never writes a room token or the control channel to the logs', () => {
    const joined = api.logs.join('\n');
    expect(joined).not.toContain('heygen.session-');
    expect(joined).not.toContain('face.test.invalid');
    expect(joined).not.toContain(manifest);
  });
});
