/**
 * A LITE stock face fed by the page, over HTTP (docs/architecture/calls.md §4.4): the avatar session hands the
 * caller's page the vendor's speak channel (`controlUrl`) in that authenticated, uncached response only, never in a log
 * line; a spoken turn's units reach the page already admitted (`turn.speech` `face: true`); `/speech` streams the
 * unit's PCM with no face-audio manifest; the server's relay refuses this face; barge-in is counted without the server
 * opening a channel of its own.
 */
import { AvatarSessionResponse, SessionView, StartCallResponse, TurnStreamEvent } from '@foundry/contracts';
import { FakeEmbodimentProvider, FakeSpeechSynthesizer } from '@foundry/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FACE_MANIFEST_HEADER } from './routes/veir.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
const speech = new FakeSpeechSynthesizer();
// A stock face for everyone in this test (the audience is the deployment's choice; admins-only is covered in core).
const face = new FakeEmbodimentProvider('heygen', false, 0.093, 'lite');
face.liteRoute = 'browser';
face.stock = true;
let maya: string;

const quietquad = (): string => api.h.ventures.quietquad.id;

beforeAll(async () => {
  api = await createApiHarness({ speech, embodiment: face });
  maya = await api.signInAs(api.h.people.maya);
  await api.h.t.db.system((sx) =>
    sx.query(
      `INSERT INTO platform_settings (key, value) VALUES ('faces_enabled', 'true'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      {},
    ),
  );
});
afterAll(async () => {
  await api.cleanup();
});

describe('a LITE stock face fed by the page, over HTTP', () => {
  it('hands the page its speak channel in the session response only, and forwards only admitted units', async () => {
    const session = SessionView.parse(
      await (await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya })).json(),
    );
    const started = StartCallResponse.parse(
      await (
        await api.request(`/sessions/${session.id}/calls`, { body: { inputMode: 'typed' }, cookie: maya })
      ).json(),
    );
    const callId = started.call.id;
    const res = await api.request('/calls/avatar-session', {
      body: { ventureId: quietquad(), callId },
      cookie: maya,
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const minted = AvatarSessionResponse.parse(await res.json());
    expect(minted).toMatchObject({ provider: 'heygen', voicing: 'audio', stockFace: true });
    const controlUrl = minted.controlUrl ?? '';
    expect(controlUrl).toMatch(/^wss:\/\/face\.test\.invalid\/control\/\d+$/);

    // A spoken turn's units arrive already admitted to the face.
    const turn = await api.request(`/sessions/${session.id}/turns`, {
      body: { text: 'What should I test first?', channel: 'voice', callId },
      cookie: maya,
      idempotencyKey: 'face-lite-preapproved-turn',
    });
    const units = parseSse(await turn.text())
      .frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)))
      .flatMap((e) => (e.event === 'turn.speech' ? [e] : []));
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.face === true)).toBe(true);
    const [first] = units;
    if (first === undefined) throw new Error('no unit');

    // Its audio is the speakers' streamed PCM: no face-audio manifest (nothing for a relay to check).
    const audio = await api.request('/speech', {
      body: { sessionId: session.id, turnId: first.turnId, seq: first.seq, text: first.text, sig: first.sig },
      cookie: maya,
      headers: { accept: 'audio/pcm, audio/mpeg, application/problem+json' },
    });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toMatch(/^audio\/pcm/);
    expect(audio.headers.get(FACE_MANIFEST_HEADER)).toBeNull();
    await audio.arrayBuffer();

    // The server's relay is not this face's route; barge-in is counted, and no server channel is opened.
    const relayed = await api.request(`/calls/${callId}/face/speak`, {
      method: 'POST',
      body: new Uint8Array(4),
      headers: { [FACE_MANIFEST_HEADER]: 'fa1.x.y.z', 'x-face-part': '0' },
      cookie: maya,
    });
    expect(relayed.status).toBe(409);
    expect(
      (await api.request(`/calls/${callId}/face/interrupt`, { method: 'POST', cookie: maya })).status,
    ).toBe(204);
    expect(face.interrupts).toHaveLength(0);
    expect(face.spoken).toHaveLength(0);

    await api.request(`/calls/${callId}/end`, { body: { reason: 'user' }, cookie: maya });
    // The speak channel is a credential: in no log line.
    expect(api.logs.join('\n')).not.toContain(controlUrl);
    expect(api.logs.join('\n')).not.toContain('face.test.invalid');
  });
});
