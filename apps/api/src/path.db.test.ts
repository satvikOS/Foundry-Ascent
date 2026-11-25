/**
 * The founder path over HTTP: `GET /ventures/:id/path` (and `/arc`), `PUT …/path/intake`, `PATCH …/path/steps/:stepId`,
 * and the turn stream's `turn.guidance` frame, before the reply's first text.
 */
import { PathArcResponse, ProblemDetails, TurnStreamEvent, VenturePath } from '@foundry/contracts';
import { FIXTURE_PLAYBOOK } from '@foundry/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiHarness, type ApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let maya: string;
let venture: string;
beforeAll(async () => {
  api = await createApiHarness({ playbook: FIXTURE_PLAYBOOK });
  venture = api.h.ventures.quietquad.id;
  maya = await api.signInAs(api.h.people.maya);
}, 120_000);
afterAll(async () => {
  await api.cleanup();
});

const base = () => `/ventures/${venture}/path`;
const pathOf = async (cookie: string): Promise<VenturePath> =>
  VenturePath.parse(await (await api.request(base(), { cookie })).json());

describe('the founder path API', () => {
  it('reads the path and its story; anonymous and unrelated people read nothing', async () => {
    const path = await pathOf(maya);
    expect(path).toMatchObject({
      ventureId: venture,
      version: 1,
      intake: null,
      playbookVersion: FIXTURE_PLAYBOOK.version,
    });
    expect(path.now).not.toBeNull();
    const arc = PathArcResponse.parse(await (await api.request(`${base()}/arc`, { cookie: maya })).json());
    expect(arc.items).toEqual(path.arc);
    expect((await api.request(base())).status).toBe(401);
    const priya = await api.signInAs(api.h.people.priya);
    expect((await api.request(base(), { cookie: priya })).status).toBe(404);
    const lead = await api.signInAs(api.h.people.lead);
    expect((await api.request(base(), { cookie: lead })).status).toBe(200);
    expect((await api.request(`${base()}/arc`, { cookie: lead })).status).toBe(403);
  });

  it('saves the intake against the version that was read, and refuses what is not valid', async () => {
    const { version } = await pathOf(maya);
    const put = (body: object) => api.request(`${base()}/intake`, { cookie: maya, method: 'PUT', body });
    const saved = await put({ expectedVersion: version, intake: { idea: 'Quiet seats', hoursPerWeek: 6 } });
    expect(saved.status).toBe(200);
    expect(VenturePath.parse(await saved.json())).toMatchObject({
      version: version + 1,
      intake: { idea: 'Quiet seats', hoursPerWeek: 6 },
    });
    const stale = await put({ expectedVersion: version, intake: {} });
    expect(stale.status).toBe(409);
    expect(ProblemDetails.parse(await stale.json()).code).toBe('conflict');
    expect((await put({ expectedVersion: version + 1, intake: { hoursPerWeek: 100 } })).status).toBe(422);
  });

  it('changes a step against the version that was read', async () => {
    const { now } = await pathOf(maya);
    if (now === null) throw new Error('no step');
    const patch = (body: object, cookie = maya) =>
      api.request(`${base()}/steps/${now.id}`, { cookie, method: 'PATCH', body });
    const ticked = await patch({
      expectedVersion: now.version,
      update: { action: 'tick', item: 0, done: true },
    });
    expect(ticked.status).toBe(200);
    const path = VenturePath.parse(await ticked.json());
    expect(path.now).toMatchObject({ id: now.id, version: now.version + 1 });
    expect(
      (await patch({ expectedVersion: now.version, update: { action: 'tick', item: 0, done: false } }))
        .status,
    ).toBe(409);
    expect((await patch({ expectedVersion: 1, update: { action: 'burn' } })).status).toBe(422);
    const corin = await api.signInAs(api.h.people.eirCorin);
    expect(
      (await patch({ expectedVersion: 2, update: { action: 'tick', item: 0, done: false } }, corin)).status,
    ).toBe(403);
  });

  it('streams the step before the reply’s first text, and stores it with the turn', async () => {
    const created = await api.request(`/ventures/${venture}/sessions`, { cookie: maya, body: {} });
    const session = (await created.json()) as { id: string };
    const res = await api.request(`/sessions/${session.id}/turns`, {
      cookie: maya,
      body: { text: 'What should we do next?' },
    });
    const { frames } = parseSse(await res.text());
    const events = frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    const names = events.map((e) => e.event);
    expect(names.indexOf('turn.guidance')).toBeGreaterThan(0);
    expect(names.indexOf('turn.guidance')).toBeLessThan(names.indexOf('turn.delta'));
    const guidance = events.find((e) => e.event === 'turn.guidance');
    const done = events.findLast((e) => e.event === 'turn.completed');
    expect(
      done?.event === 'turn.completed' && guidance?.event === 'turn.guidance' && done.turn.guidance,
    ).toEqual(guidance?.event === 'turn.guidance' ? guidance.guidance : null);
    const read = (await (await api.request(`/sessions/${session.id}`, { cookie: maya })).json()) as {
      turns: { guidance: unknown }[];
    };
    expect(read.turns[0]?.guidance).not.toBeNull();
  });
});
