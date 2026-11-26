/**
 * A reply the writer writes whole (docs/architecture/understand.md), in a whole turn: a seeded database and the mock model.
 * Its fitted step is stored, shown and repeated; a draft that is no reply once what is false is out is written again once, in
 * time, or completed; the step line is never shown as it came.
 */
import {
  MockModelGateway,
  UNDERSTAND_SCHEMA_NAMES,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
} from '@foundry/ai';
import { TurnStreamEvent, type TurnGuidance, type TurnView } from '@foundry/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { coreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { FIXTURE_PLAYBOOK } from '../path/testing/fixture-playbook.js';
import { RecordingLogger } from '../testing/fakes.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

const ASK = 'the second room has empty shelves, does the kit go there or not';
const GOOD =
  'Move it only if somebody there uses it. Nobody in that room was asked yet.\n' +
  'NEXT: Ask 5 people in the second room what they borrow | DONE: 5 answered, and you know if 3 of 5 would use it';

let drafts: string[] = [];
class WriterGateway extends MockModelGateway {
  /** What the second and later calls of a turn wait for. */
  hangs = false;
  readonly wrote: StreamTextRequest[] = [];
  override async streamText(request: StreamTextRequest, onText: TextChunkHandler): Promise<StreamTextResult> {
    this.wrote.push(request);
    if (this.hangs && this.wrote.length > 1)
      await new Promise((resolve) => {
        request.signal?.addEventListener('abort', resolve, { once: true });
      });
    return super.streamText(request, onText);
  }
}

let h: CoreHarness;
let priya: RequestContext;
let gateway: WriterGateway;
let logger: RecordingLogger;

beforeAll(async () => {
  h = await createCoreHarness({ playbook: FIXTURE_PLAYBOOK });
  priya = await h.ctxFor(h.people.priya);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});
beforeEach(() => {
  drafts = [];
  gateway = new WriterGateway({
    streamDelayMs: 0,
    streamFixture: () => drafts.shift() ?? GOOD,
    fixtures: {
      [UNDERSTAND_SCHEMA_NAMES.judge]: () => ({
        x: null,
        o: null,
        t: null,
        g: ['Nobody in the second room was asked yet.', 'Moving it costs a morning.'],
        d: null,
      }),
    },
  });
  logger = new RecordingLogger();
});

const core = (): Core =>
  createCore({
    db: h.t.db,
    gateway,
    config: coreConfig({
      appEnv: 'test',
      turns: { founderPath: true, rateLimit: 500, understand: true },
    }),
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger,
    random: () => 0.99,
    playbook: FIXTURE_PLAYBOOK,
  });

interface Run {
  readonly shown: string;
  readonly guidance: TurnGuidance[];
  readonly turn: TurnView | null;
  readonly phase: Record<string, unknown> | null;
  readonly sessionId: string;
}
async function say(on: Core, text: string, sessionId?: string): Promise<Run> {
  const id =
    sessionId ?? (await on.sessions.create(priya, h.ventures.benchtally.id, { privacy: 'standard' })).id;
  const events: TurnStreamEvent[] = [];
  await on.orchestrator.runTurn({ ...priya, requestId: crypto.randomUUID() }, id, { text }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = events.findLast((e) => e.event === 'turn.completed');
  return {
    shown: events.flatMap((e) => (e.event === 'turn.delta' ? [e.text] : [])).join(''),
    guidance: events.flatMap((e) => (e.event === 'turn.guidance' ? [e.guidance] : [])),
    turn: last?.event === 'turn.completed' ? last.turn : null,
    phase: logger.records.findLast((r) => r.event === 'turn.phase_a')?.fields ?? null,
    sessionId: id,
  };
}

describe('a whole reply', () => {
  it('is shown as written, with the step it fitted, stored and said again as it is', async () => {
    const on = core();
    const run = await say(on, ASK);
    expect(logger.records.findLast((r) => r.event === 'turn.path')?.fields.read).not.toBe('none');
    expect(run.shown).toMatch(
      /^Move it only if somebody there uses it\. Nobody in that room was asked yet\./,
    );
    expect(run.shown).not.toMatch(/NEXT|DONE|\|/);
    expect(run.shown).toMatch(/\*\*Next:\*\* Ask 5 people in the second room what they borrow by /);
    expect(run.turn?.response?.answer).toBe(run.shown.trim());
    const title = 'Ask 5 people in the second room what they borrow';
    expect(run.turn?.guidance?.step).toMatchObject({ title, status: 'now' });
    expect(run.guidance.at(-1)?.step?.title).toBe(title);
    expect(run.phase).toMatchObject({ repair: 'none', step: 'fitted', cuts: '' });
    const path = await on.path.get(priya, h.ventures.benchtally.id);
    expect(path.now).toMatchObject({ title, doneWhen: '5 answered, and you know if 3 of 5 would use it.' });
    // Asked again, the rules say the stored one.
    const again = await say(on, "what's my next step?", run.sessionId);
    expect(again.turn?.guidance?.step).toMatchObject({ id: run.turn?.guidance?.step?.id, title });
    expect(again.shown).toContain(title);
  });

  it('that is none is written again once, with what was cut and why', async () => {
    drafts = ['The founder has a kit. It is on the shelf.', GOOD];
    const run = await say(core(), ASK);
    expect(run.shown).toMatch(/^Move it only if somebody there uses it\./);
    expect(run.shown).not.toMatch(/founder/);
    expect(gateway.wrote).toHaveLength(2);
    expect(gateway.wrote[1]?.messages.at(-1)?.content).toMatch(/"The founder has a kit\.": it speaks of how/);
    expect(run.phase).toMatchObject({ repair: 'ok', step: 'fitted' });
    expect(String(run.phase?.repairWhy)).toMatch(/works/);
    expect(JSON.stringify(run.phase)).not.toMatch(/shelf/);
  });

  it('is completed when the second draft is late, or is none either', async () => {
    drafts = ['The founder has a kit.'];
    gateway.hangs = true;
    const late = await say(core(), ASK);
    expect(late.phase).toMatchObject({ repair: 'late' });
    expect(late.shown.trim()).not.toBe('');
    expect(late.turn?.status).toBe('completed');
    gateway.hangs = false;
    drafts = ['The founder has a kit.', 'The founder has a kit.'];
    const none = await say(core(), ASK);
    expect(none.phase).toMatchObject({ repair: 'unfit' });
    expect(none.shown).toMatch(/\*\*(?:Next|On your path, next is):\*\*/);
  }, 30_000);

  it('whose step is made up has the play’s own', async () => {
    drafts = [GOOD.replace('Ask 5 people', 'Sell 500 boxes at $75 to people')];
    const run = await say(core(), ASK);
    expect(run.phase).toMatchObject({ step: 'figure' });
    expect(run.shown).not.toMatch(/500|\$75/);
    expect(run.shown).toMatch(/\*\*(?:Next|On your path, next is):\*\*/);
  });

  it('is read the same way when its stream was given up, and its step line is not shown either', async () => {
    drafts = [GOOD];
    gateway.scriptStream('fail_midway');
    const run = await say(core(), ASK);
    expect(run.turn?.status).toBe('completed');
    expect(run.turn?.response?.answer).not.toMatch(/NEXT|DONE|\|/);
    expect(run.turn?.response?.answer).toMatch(/\*\*(?:Next|On your path, next is):\*\*/);
  });

  it('that came without its step line has that line asked for alone, once, and kept', async () => {
    drafts = [
      'Move it only if somebody there uses it. Nobody in that room was asked yet.',
      'NEXT: Ask 4 people in the second room what they borrow | DONE: 4 answered',
    ];
    const run = await say(core(), ASK);
    expect(gateway.wrote).toHaveLength(2);
    expect(gateway.wrote[1]?.messages.at(-1)?.content).toMatch(
      /It has no last line\. Write only that line now/,
    );
    expect(run.shown).toMatch(/\*\*Next:\*\* Ask 4 people in the second room what they borrow by /);
    expect(run.phase).toMatchObject({ stepAsk: 'ok', step: 'fitted' });
    expect(run.turn?.guidance?.step?.title).toBe('Ask 4 people in the second room what they borrow');
  });

  it('whose step line, asked for again, is late, has the play’s own step', async () => {
    drafts = ['Move it only if somebody there uses it. Nobody in that room was asked yet.'];
    gateway.hangs = true;
    const run = await say(core(), ASK);
    expect(run.phase).toMatchObject({ stepAsk: 'late', step: 'missing' });
    expect(run.shown).toMatch(/\*\*(?:Next|On your path, next is):\*\*/);
  });
});
