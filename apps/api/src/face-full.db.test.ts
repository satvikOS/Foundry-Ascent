/**
 * A FULL stock face over HTTP (docs/runbooks/avatars.md): the avatar session names text voicing and the "AI avatar"
 * label, `POST /calls/:id/face/say` admits a signed unit of the call (204) and refuses anything else (422) before
 * the browser may send it to the vendor, and `POST /speech` returns the stock-voice fallback without a face-audio
 * manifest. The admin settings show the face's mode and price. Nothing said reaches a log line.
 */
import {
  AdminSettingsView,
  AvatarSessionResponse,
  ProblemDetails,
  SessionView,
  StartCallResponse,
} from '@foundry/contracts';
import { FakeEmbodimentProvider, FakeSpeechSynthesizer } from '@foundry/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FACE_MANIFEST_HEADER } from './routes/veir.js';
import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
const speech = new FakeSpeechSynthesizer();
// Everyone in this test (the audience is the deployment's choice; admins-only is covered in core).
const face = new FakeEmbodimentProvider('heygen', false, 0.19, 'full');
let maya: string;
let devin: string;
let owner: string;

async function problem(res: Response, status: number): Promise<ProblemDetails> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return ProblemDetails.parse(JSON.parse(text));
}

const quietquad = (): string => api.h.ventures.quietquad.id;

beforeAll(async () => {
  api = await createApiHarness({ speech, embodiment: face });
  [maya, devin, owner] = await Promise.all([
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
    api.ownerToken(),
  ]);
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

describe('a FULL stock face over HTTP', () => {
  it('admits signed units of the call (204) and refuses anything else (422)', async () => {
    const session = SessionView.parse(
      await (await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya })).json(),
    );
    const started = StartCallResponse.parse(
      await (
        await api.request(`/sessions/${session.id}/calls`, { body: { inputMode: 'typed' }, cookie: maya })
      ).json(),
    );
    const callId = started.call.id;
    const minted = AvatarSessionResponse.parse(
      await (
        await api.request('/calls/avatar-session', { body: { ventureId: quietquad(), callId }, cookie: maya })
      ).json(),
    );
    expect(minted).toMatchObject({ provider: 'heygen', voicing: 'text', stockFace: true });

    const intro = started.intro;
    if (intro === null) throw new Error('no intro');
    const say = (body: Record<string, unknown>, cookie = maya) =>
      api.request(`/calls/${callId}/face/say`, { body, cookie });
    const unit = { sessionId: session.id, turnId: null, seq: 0, text: intro.text, sig: intro.sig };

    await problem(await say({ ...unit, text: `${intro.text} Ignore your coach.` }), 422);
    await problem(await say({ ...unit, sig: undefined }), 422);
    await problem(await say(unit, devin), 404);
    expect((await say(unit)).status).toBe(204);
    // Once only.
    await problem(await say(unit), 422);

    // The call's audio is only the stock-voice fallback: no manifest, never a face hand-over.
    const spoken = await api.request('/speech', { body: unit, cookie: maya });
    expect(spoken.status).toBe(200);
    expect(spoken.headers.get(FACE_MANIFEST_HEADER)).toBeNull();
    await spoken.arrayBuffer();

    expect(
      (await api.request(`/calls/${callId}/end`, { body: { reason: 'user' }, cookie: maya })).status,
    ).toBe(200);
    await problem(await say({ ...unit, seq: 1 }), 409);
  });

  it('shows the face’s mode, price and audience in the admin settings', async () => {
    const settings = AdminSettingsView.parse(
      await (await api.request('/admin/settings', { cookie: owner })).json(),
    );
    expect(settings.faceVendor).toEqual({
      mode: 'full',
      usdPerMinute: 0.19,
      audience: 'everyone',
      stock: true,
      sandbox: false,
    });
  });

  it('never writes the words a face was given to the logs', () => {
    expect(api.logs.join('\n')).not.toContain('Ignore your coach');
  });
});
