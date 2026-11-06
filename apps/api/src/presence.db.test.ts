/**
 * The vEIR's presence over HTTP: the one-time welcome (`GET /me`, `POST /me/veir-welcome/acknowledge`: stored with
 * the person, once, audited the first time), the first-person consent scope (recorded through the consent
 * endpoint, reported by the venture and the call settings) and nothing unknown accepted as a scope.
 */
import {
  CallConfigResponse,
  ConsentView,
  Me,
  ProblemDetails,
  SessionView,
  VentureDetail,
  VeirWelcomeAcknowledgement,
} from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiHarness, createApiHarness } from './testing/api-harness.js';

let api: ApiHarness;
let corin: string;
let maya: string;
let devin: string;

beforeAll(async () => {
  api = await createApiHarness();
  [corin, maya, devin] = await Promise.all([
    api.signInAs(api.h.people.eirCorin),
    api.signInAs(api.h.people.maya),
    api.signInAs(api.h.people.devin),
  ]);
});
afterAll(async () => {
  await api.cleanup();
});

async function json<T>(res: Response, schema: { parse: (v: unknown) => T }, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

const quietquad = (): string => api.h.ventures.quietquad.id;

describe('the vEIR welcome', () => {
  it('is stored with the person: once, theirs only, audited the first time', async () => {
    const audited = async () =>
      Number(
        (
          await api.h.t.db.system((sx) =>
            sx.query(
              `SELECT count(*) AS n FROM audit_events WHERE action = 'veir.welcome_acknowledged' AND actor_id = :id`,
              { id: p.uuid(api.h.people.maya) },
            ),
          )
        ).rows[0]?.n,
      );
    const me = async (cookie: string) => json(await api.request('/me', { cookie }), Me);
    expect((await me(maya)).veirWelcomeAcknowledgedAt).toBeNull();

    const first = await json(
      await api.request('/me/veir-welcome/acknowledge', { method: 'POST', cookie: maya }),
      VeirWelcomeAcknowledgement,
    );
    expect(Date.parse(first.acknowledgedAt)).not.toBeNaN();
    expect((await me(maya)).veirWelcomeAcknowledgedAt).toBe(first.acknowledgedAt);
    expect(await audited()).toBe(1);

    // Idempotent: another browser (another key) keeps the first time and is not audited again.
    const again = await json(
      await api.request('/me/veir-welcome/acknowledge', {
        method: 'POST',
        cookie: maya,
        idempotencyKey: 'welcome-key-0001',
      }),
      VeirWelcomeAcknowledgement,
    );
    expect(again).toEqual(first);
    expect(await audited()).toBe(1);

    // Per person: a teammate has not seen it; the call notice is a separate answer.
    expect((await me(devin)).veirWelcomeAcknowledgedAt).toBeNull();
    const config = await json(
      await api.request(`/ventures/${quietquad()}/call-config`, { cookie: maya }),
      CallConfigResponse,
    );
    expect(config.callNoticeAcknowledgedAt).toBeNull();
    // Signed out: refused.
    expect((await api.request('/me/veir-welcome/acknowledge', { method: 'POST' })).status).toBe(401);
  });

  it('introduces each mentor once, and again when the persona is presented differently (Corin’s vEIR → Thomas)', async () => {
    const persona = api.h.ventures.quietquad.personaId;
    const audited = async () =>
      Number(
        (
          await api.h.t.db.system((sx) =>
            sx.query(
              `SELECT count(*) AS n FROM audit_events WHERE action = 'veir.welcome_acknowledged' AND actor_id = :id`,
              { id: p.uuid(api.h.people.maya) },
            ),
          )
        ).rows[0]?.n,
      );
    const introductions = async () =>
      (await json(await api.request('/me', { cookie: maya }), Me)).veirWelcomeIntroductions;
    const acknowledge = async (body?: object) =>
      json(
        await api.request('/me/veir-welcome/acknowledge', {
          method: 'POST',
          cookie: maya,
          ...(body === undefined ? {} : { body }),
        }),
        VeirWelcomeAcknowledgement,
      );
    // The test above acknowledged without a persona: every mentor Maya meets today (QuietQuad's, a twin here).
    expect(await introductions()).toEqual([`${persona}:twin`]);
    const before = await audited();
    try {
      await api.h.t.db.system((sx) =>
        sx.query(`UPDATE personas SET presentation = 'mentor' WHERE id = :id`, { id: p.uuid(persona) }),
      );
      // Thomas is new to her: the web shows his welcome until she reads it.
      expect(await introductions()).not.toContain(`${persona}:mentor`);
      const read = await acknowledge({ personaId: persona });
      expect(read.introductions).toEqual([`${persona}:twin`, `${persona}:mentor`]);
      expect(await introductions()).toEqual(read.introductions);
      expect(await audited()).toBe(before + 1);
      // Again: nothing new, not audited.
      expect((await acknowledge({ personaId: persona })).introductions).toEqual(read.introductions);
      // A persona that is not her mentor adds nothing.
      const stranger = await acknowledge({ personaId: '7c8d9e0f-1a2b-4c3d-8e4f-6a7b8c9d0e08' });
      expect(stranger.introductions).toEqual(read.introductions);
      expect(await audited()).toBe(before + 1);
      // Not an id: refused.
      const bad = await api.request('/me/veir-welcome/acknowledge', {
        method: 'POST',
        cookie: maya,
        body: { personaId: 'Thomas' },
      });
      expect(bad.status).toBe(422);
    } finally {
      await api.h.t.db.system((sx) =>
        sx.query(`UPDATE personas SET presentation = 'twin' WHERE id = :id`, { id: p.uuid(persona) }),
      );
    }
  });
});

describe('how the persona presents itself (ADR-0021)', () => {
  it('is reported by the venture, the call settings and each conversation: a twin, then a mentor', async () => {
    const persona = api.h.ventures.quietquad.personaId;
    const present = (presentation: 'twin' | 'mentor') =>
      api.h.t.db.system((sx) =>
        sx.query('UPDATE personas SET presentation = :presentation WHERE id = :id', {
          presentation: p.text(presentation),
          id: p.uuid(persona),
        }),
      );
    const read = async () => ({
      venture: (await json(await api.request(`/ventures/${quietquad()}`, { cookie: maya }), VentureDetail))
        .persona?.presentation,
      call: (
        await json(
          await api.request(`/ventures/${quietquad()}/call-config`, { cookie: maya }),
          CallConfigResponse,
        )
      ).veir.presentation,
      session: (
        await json(
          await api.request(`/ventures/${quietquad()}/sessions`, { body: {}, cookie: maya }),
          SessionView,
          201,
        )
      ).personaPresentation,
    });
    expect(await read()).toEqual({ venture: 'twin', call: 'twin', session: 'twin' });
    try {
      await present('mentor');
      expect(await read()).toEqual({ venture: 'mentor', call: 'mentor', session: 'mentor' });
    } finally {
      await present('twin');
    }
  });
});

describe('the first-person consent scope', () => {
  it('is reported by the venture and the call settings, and follows the consent the EIR records', async () => {
    const venture = await json(
      await api.request(`/ventures/${quietquad()}`, { cookie: maya }),
      VentureDetail,
    );
    expect(venture.persona).toMatchObject({ eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true });
    const config = await json(
      await api.request(`/ventures/${quietquad()}/call-config`, { cookie: maya }),
      CallConfigResponse,
    );
    expect(config.veir).toMatchObject({ firstPerson: true, eirSeesWork: true, shortName: 'Corin' });

    const persona = api.h.ventures.quietquad.personaId;
    const without = await json(
      await api.request(`/personas/${persona}/consents`, {
        body: { assetTypes: ['doctrine', 'style', 'voice', 'cases'] },
        cookie: corin,
      }),
      ConsentView,
      201,
    );
    expect(without.assetTypes).not.toContain('first_person');
    const after = await json(await api.request(`/ventures/${quietquad()}`, { cookie: maya }), VentureDetail);
    expect(after.persona?.firstPerson).toBe(false);

    const withScope = await json(
      await api.request(`/personas/${persona}/consents`, {
        body: { assetTypes: ['doctrine', 'style', 'voice', 'cases', 'first_person'] },
        cookie: corin,
      }),
      ConsentView,
      201,
    );
    expect(withScope.assetTypes).toContain('first_person');
    const back = await json(await api.request(`/ventures/${quietquad()}`, { cookie: maya }), VentureDetail);
    expect(back.persona?.firstPerson).toBe(true);
  });

  it('accepts no scope it does not know', async () => {
    const res = await api.request(`/personas/${api.h.ventures.quietquad.personaId}/consents`, {
      body: { assetTypes: ['doctrine', 'first_person_everywhere'] },
      cookie: corin,
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(422);
    expect(ProblemDetails.parse(JSON.parse(text)).code).toBe('validation_failed');
  });
});
