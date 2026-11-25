/**
 * A venture's path stays where it is while nothing is reported, on a seeded database with the mock model: the same ask in
 * one conversation after another gives the same step, whatever notes were kept in between; the program's change of stage
 * moves it, and so does what the founder reports.
 */
import { type TurnGuidance } from '@foundry/contracts';
import { memoryRepo, p, pathRepo, readTogether } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { PLAYBOOK } from './playbook/index.js';

let h: CoreHarness;
let maya: RequestContext;
const venture = () => h.ventures.quietquad;

beforeAll(async () => {
  h = await createCoreHarness({
    playbook: PLAYBOOK,
    config: { turns: { rateLimit: 500 } },
    random: () => 0.99,
  });
  maya = await h.ctxFor(h.people.maya);
  // A venture the program has at validation, with nothing on record of its own.
  await h.t.db.system(async (sx) => {
    const v = { v: p.uuid(venture().id) };
    for (const table of ['path_criteria', 'path_steps', 'venture_paths'])
      await sx.query(`DELETE FROM ${table} WHERE venture_id = :v`, v);
    await sx.query(`UPDATE memory_objects SET status = 'deleted' WHERE venture_id = :v`, v);
    await sx.query(`UPDATE ventures SET stage = 'validation' WHERE id = :v`, v);
  });
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const reads = (): Promise<pathRepo.PathReads> =>
  h.t.db.withContext(maya, async (tx) =>
    pathRepo.pathReadsFrom(await readTogether(tx, pathRepo.pathParts(venture().id))),
  );

async function ask(text: string): Promise<TurnGuidance> {
  const session = (await h.core.sessions.create(maya, venture().id, {})).id;
  const given: TurnGuidance[] = [];
  await h.core.orchestrator.runTurn(maya, session, { text }, (e) => {
    if (e.event === 'turn.guidance') given.push(e.guidance);
  });
  const [guidance] = given;
  if (guidance === undefined) throw new Error('no guidance');
  return guidance;
}

/** A note the mentor keeps by itself, as the distillation of a conversation writes it. */
const note = (type: 'fact' | 'decision' | 'milestone', title: string, content: string) =>
  h.t.db.withContext(maya, (tx) =>
    memoryRepo.createMemory(tx, {
      tenantId: h.seed.tenantId,
      ventureId: venture().id,
      type,
      title,
      content,
      keptAutomatically: true,
      visibility: 'team',
      confidence: 0.8,
      origin: 'ai',
      createdBy: maya.principalId,
      sourceRefs: [],
      attributes: {},
    }),
  );

const stageNow = async (): Promise<string | null> => (await reads()).path?.stage ?? null;
const setStage = (stage: string) =>
  h.t.db.system((sx) =>
    sx.query('UPDATE ventures SET stage = :s WHERE id = :v', { s: p.text(stage), v: p.uuid(venture().id) }),
  );

describe('a path while nothing is reported', () => {
  it('an ask whose step is only offered begins the path, and remembers the program’s stage of that day', async () => {
    expect(await stageNow()).toBeNull();
    const first = await ask('Should I keep going with this or stop?');
    expect(first.stage).toBe('idea');
    expect((await reads()).path).toMatchObject({ stage: 'idea', programStage: 'validation' });
    await note('fact', 'Quiet rooms', 'QuietQuad finds students a quiet room.');
    await note('milestone', 'Ten talks', 'The founder plans to have interviewed ten students.');
    const second = await ask('Should I keep going with this or stop?');
    await note('decision', 'A test', 'The founder will run a landing page test next week.');
    const third = await ask('Should I keep going with this or stop?');
    expect(second.step?.id).toBe(first.step?.id);
    expect(third.step?.id).toBe(first.step?.id);
    expect([second.stage, third.stage]).toEqual(['idea', 'idea']);
  });

  it('“what should I do next?” in three conversations is one stage and one step', async () => {
    const asked = [];
    for (let i = 0; i < 3; i += 1) {
      asked.push(await ask('What should I do next?'));
      await note('fact', `Seen ${String(i)}`, `QuietQuad is for students who study, note ${String(i)}.`);
    }
    expect(new Set(asked.map((g) => g.stage))).toEqual(new Set(['idea']));
    expect(new Set(asked.map((g) => g.step?.id)).size).toBe(1);
    const [memory, path] = [(await reads()).memory, await h.core.path.get(maya, venture().id)];
    expect(memory.length).toBeGreaterThanOrEqual(6);
    expect(memory.every((m) => m.origin === 'ai' && m.vouched === false)).toBe(true);
    expect(path.stage).toBe('idea');
  });

  it('the program’s change of stage moves it, and what it moved to stays', async () => {
    await setStage('discovery');
    expect((await h.core.path.get(maya, venture().id)).stage).toBe('discovery');
    expect((await ask('What should I do next?')).stage).toBe('discovery');
    expect(await stageNow()).toBe('discovery');
    await setStage('idea');
    expect((await ask('What should I do next?')).stage).toBe('discovery');
  });

  it('work they report moves it', async () => {
    const told = await ask(
      'I interviewed 12 students this week about the last time they found no room. 9 said it cost them an hour.',
    );
    expect(told.stage).toBe('discovery');
    expect(await stageNow()).toBe('discovery');
    expect(
      (await reads()).criteria.find((c) => c.criterionId === 'discovery-ten-conversations')?.status,
    ).toBe('met');
  });
});
