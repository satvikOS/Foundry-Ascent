import type { PathStepAction, PathStepView, TurnGuidance, VenturePath } from '@foundry/contracts';
import type { Page } from '@playwright/test';

import { makeEvidence, makeTurn } from '../../src/features/coach/testing';
import { makeGuidance, makePath, PATH_IDS } from '../../src/features/path/testing';

/*
 * The founder path as the API answers it, kept in this test (synthetic data, no server): reads, ticks, done, new dates,
 * changes of plan and the intake, each with its version. The conversation itself is the real local API; only a turn's
 * stream is scripted (`scriptTurns`), so the step can be seen arriving before the words.
 */

export interface PathMock {
  readonly path: () => VenturePath;
  readonly updates: () => readonly PathStepAction[];
}

/** What the server makes of a step's change: the lists move with it. */
function applied(
  path: VenturePath,
  stepId: string,
  update: PathStepAction,
  offered: readonly PathStepView[],
): VenturePath {
  const all = [...(path.now ? [path.now] : []), ...path.next, ...path.done, ...offered];
  const step = all.find((candidate) => candidate.id === stepId);
  if (!step) return path;
  const bump = (patch: Partial<PathStepView>): PathStepView => ({
    ...step,
    ...patch,
    version: step.version + 1,
  });
  const next = { ...path, version: path.version + 1 };
  const swap = (changed: PathStepView): VenturePath => ({
    ...next,
    now: next.now?.id === stepId ? changed : next.now,
    next: next.next.map((candidate) => (candidate.id === stepId ? changed : candidate)),
    done: next.done.map((candidate) => (candidate.id === stepId ? changed : candidate)),
  });
  switch (update.action) {
    case 'tick':
      return swap(
        bump({
          items: step.items.map((item, index) =>
            index === update.item ? { ...item, done: update.done } : item,
          ),
        }),
      );
    // The step now when the path has none, else after the one it is on.
    case 'add':
      return next.now === null
        ? { ...next, now: bump({ status: 'now' }) }
        : { ...next, next: [bump({ status: 'next' }), ...next.next].slice(0, 3) };
    case 'reschedule':
      return swap(bump({ dueOn: update.dueOn }));
    case 'block':
      return swap(bump({ status: 'blocked', evidence: update.reason }));
    case 'reopen': {
      const open = bump({ status: 'now', completedAt: null });
      return { ...next, now: open, done: next.done.filter((candidate) => candidate.id !== stepId) };
    }
    case 'complete':
    case 'skip': {
      const [following, ...rest] = next.next;
      const over =
        update.action === 'complete'
          ? bump({ status: 'done', evidence: update.evidence, completedAt: new Date().toISOString() })
          : bump({ status: 'skipped', evidence: update.reason });
      return {
        ...next,
        now: following ? { ...following, status: 'now' } : null,
        next: rest,
        done: update.action === 'complete' ? [over, ...next.done] : next.done,
      };
    }
  }
}

/** Answers the path's endpoints for every venture this page opens. `offered`: steps of replies, not on the path yet. */
export async function mockPath(
  page: Page,
  initial: Partial<VenturePath> = {},
  offered: readonly PathStepView[] = [],
): Promise<PathMock> {
  let path = makePath(initial);
  let aside = [...offered];
  const updates: PathStepAction[] = [];
  const answer = (status: number, body: unknown) => ({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
  await page.route(/\/api\/v1\/ventures\/[0-9a-f-]{36}\/path(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill(answer(200, path));
    const body = request.postDataJSON() as {
      expectedVersion: number;
      intake?: VenturePath['intake'];
      update?: PathStepAction;
    };
    if (request.method() === 'PUT' && url.endsWith('/path/intake')) {
      path = { ...path, intake: body.intake ?? null, version: path.version + 1 };
      return route.fulfill(answer(200, path));
    }
    const stepId = /\/path\/steps\/([0-9a-f-]{36})$/.exec(url)?.[1];
    const step = [...(path.now ? [path.now] : []), ...path.next, ...path.done, ...aside].find(
      (s) => s.id === stepId,
    );
    if (request.method() !== 'PATCH' || !step || !body.update)
      return route.fulfill(answer(404, { code: 'not_found', status: 404, title: 'Not found' }));
    if (body.expectedVersion !== step.version)
      return route.fulfill(answer(409, { code: 'conflict', status: 409, title: 'Conflict' }));
    updates.push(body.update);
    path = applied(path, step.id, body.update, aside);
    // Not on the path, it moves on all the same: the next change is made against what it is now.
    aside = aside.map((each) => (each.id === step.id ? { ...each, version: each.version + 1 } : each));
    return route.fulfill(answer(200, path));
  });
  return { path: () => path, updates: () => updates };
}

/** The scripted reply's words, in the units the stream sends. */
export const REPLY_UNITS = [
  'Talk to five lab managers first, not twenty. ',
  'Five people telling you about the last time it happened is enough to see the pattern [E1]. ',
  'Your next step is below.',
] as const;

const EVIDENCE = makeEvidence({
  key: 'E1',
  kind: 'chunk',
  title: 'The Mom Test, notes',
  excerpt: 'Ask about specifics in the past instead of opinions about the future.',
  status: null,
});

/**
 * Scripts every turn of the page: the step first (`turn.guidance`), then, after a pause, the words, then the stored
 * turn. `mode: 'plain'` sends a turn without a step. Stored turns stay in the conversation's reads.
 */
export async function scriptTurns(
  page: Page,
  { pauseMs = 900, guidance = makeGuidance() }: { pauseMs?: number; guidance?: TurnGuidance } = {},
): Promise<void> {
  const reply = makeTurn().response;
  if (!reply) throw new Error('the turn fixture has no response');
  const base = makeTurn({
    evidence: [EVIDENCE],
    guidance,
    response: {
      ...reply,
      answer: REPLY_UNITS.join(''),
      claims: [],
      challenge: null,
      uncertainty: [],
      memory_candidates: [],
      follow_up_questions: [],
    },
  });
  await page.addInitScript(
    ({ turn, step, units, pause }) => {
      const real = window.fetch.bind(window);
      const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const stored = new Map<string, unknown[]>();
      const scripted = window as unknown as { __scriptedTurns: number };
      scripted.__scriptedTurns = 0;
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const turns = /\/api\/v1\/sessions\/([0-9a-f-]{36})\/turns$/.exec(url);
        const detail = /\/api\/v1\/sessions\/([0-9a-f-]{36})$/.exec(url);
        if (turns && method === 'POST') {
          const sessionId = turns[1] ?? '';
          scripted.__scriptedTurns += 1;
          const ordinal = scripted.__scriptedTurns;
          const turnId = `2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f${String(ordinal).padStart(2, '0')}`;
          const raw = init?.body;
          const sent = JSON.parse(
            typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array),
          ) as { text: string; channel?: string };
          const full = {
            ...turn,
            id: turnId,
            sessionId,
            ordinal,
            founderText: sent.text,
            channel: sent.channel ?? 'text',
            response: {
              ...turn.response,
              spoken: sent.channel === 'voice' ? 'Talk to five lab managers.' : null,
            },
          };
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (event: Record<string, unknown>) => {
                controller.enqueue(
                  encoder.encode(`event: ${String(event.event)}\ndata: ${JSON.stringify(event)}\n\n`),
                );
              };
              send({ event: 'turn.accepted', turnId, ordinal });
              await wait(60);
              send({ event: 'turn.guidance', turnId, guidance: step });
              await wait(pause);
              for (const [seq, text] of units.entries()) {
                send({ event: 'turn.delta', turnId, seq, text });
                await wait(Math.min(250, pause / 3));
              }
              stored.set(sessionId, [...(stored.get(sessionId) ?? []), full]);
              send({ event: 'turn.completed', turn: full });
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        const response = await real(input, init);
        const kept = detail ? stored.get(detail[1] ?? '') : undefined;
        if (!kept || method !== 'GET' || !response.ok) return response;
        const body = (await response.json()) as { session: object; turns: unknown[] };
        return new Response(JSON.stringify({ ...body, turns: [...body.turns, ...kept] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    },
    { turn: base, step: guidance, units: [...REPLY_UNITS], pause: pauseMs },
  );
}

export { PATH_IDS };
