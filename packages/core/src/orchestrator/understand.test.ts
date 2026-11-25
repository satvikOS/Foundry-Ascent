import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_VOICE_SYSTEM_PROMPT,
  SUMS_SYSTEM_PROMPT,
  UNDERSTAND_FORMS,
  UNDERSTAND_PARTS,
  UNDERSTAND_SCHEMAS,
  UNDERSTAND_SCHEMA_NAMES,
  UNDERSTAND_TIMEOUT_MS,
  type PromptContinuity,
} from '@foundry/ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { coreConfig, loadConfig } from '../config.js';
import { FIXTURE_PLAYBOOK } from '../path/testing/fixture-playbook.js';
import { PLAYBOOK } from '../path/playbook/index.js';
import { input, LAB_MEMORY, NO_READS, storedStep, TODAY, VENTURE_ID } from '../path/testing/inputs.js';
import { pathTurn } from '../path/turn.js';
import {
  judgeLeads,
  prepareUnderstand,
  understandCatalogue,
  understandDue,
  type UnderstandInput,
} from './understand.js';

const prepared = (over: Partial<UnderstandInput> = {}) =>
  prepareUnderstand({
    playbook: FIXTURE_PLAYBOOK,
    ventureId: VENTURE_ID,
    venture: input('').venture,
    reads: { ...NO_READS, memory: LAB_MEMORY, steps: [storedStep()] },
    continuity: { founderFirstName: 'Runa' } satisfies PromptContinuity,
    today: TODAY,
    message: 'what does one lab bring in',
    history: [],
    opener: null,
    channel: 'text',
    ...over,
  });

describe('the switch', () => {
  it('is off unless the environment turns it on', () => {
    expect(coreConfig().turns.understand).toBe(false);
    expect(loadConfig({}).turns.understand).toBe(false);
    expect(loadConfig({ CORE_UNDERSTAND: 'on' }).turns.understand).toBe(true);
    expect(loadConfig({ CORE_UNDERSTAND: ' OFF ' }).turns.understand).toBe(false);
    expect(() => loadConfig({ CORE_UNDERSTAND: 'yes' })).toThrow('CORE_UNDERSTAND must be on or off');
  });
});

describe('how long it may take', () => {
  it('is the channel’s, or what the environment says within bounds', () => {
    const of = (env: Record<string, string>) => {
      const { understandTypedMs, understandVoiceMs } = loadConfig(env).turns;
      return [understandTypedMs, understandVoiceMs];
    };
    expect(of({})).toEqual([UNDERSTAND_TIMEOUT_MS.text, UNDERSTAND_TIMEOUT_MS.voice]);
    expect(of({ CORE_UNDERSTAND_TYPED_MS: '4500', CORE_UNDERSTAND_VOICE_MS: ' 2000 ' })).toEqual([
      4_500, 2_000,
    ]);
    for (const wrong of ['0', '20000', '2.5', 'soon'])
      expect(() => of({ CORE_UNDERSTAND_TYPED_MS: wrong }), wrong).toThrow();
    expect(() => of({ CORE_UNDERSTAND_VOICE_MS: '9000' })).toThrow();
  });

  it('waits for JUDGE where the reply opens on it', () => {
    const route = { a: 'x', b: null, r: [], c: null, f: null, p: null, s: null, h: false };
    for (const k of ['choice', 'Result', 'update', 'pushback'])
      expect(judgeLeads({ ...route, k: [k] })).toBe(true);
    expect(judgeLeads({ ...route, k: ['question', 'result'] })).toBe(true);
    for (const k of ['question', 'recall', 'next', 'sum'])
      expect(judgeLeads({ ...route, k: [k] })).toBe(false);
    // Not known what it is: what there is of it is waited for.
    expect(judgeLeads(null)).toBe(true);
    expect(judgeLeads({ ...route, k: [] })).toBe(true);
  });
});

describe('what the calls read', () => {
  it('hold the record, the open step and the message, and nothing of another kind', () => {
    const p = prepared();
    const text = p.parts.route.messages[0]?.content ?? '';
    expect(p.parts.route.messages).toHaveLength(1);
    expect(text).toContain('Two paid pilots signed at $40 per lab per month.');
    expect(p.parts.judge.messages[0]?.content).toContain(
      'Two labs signed the pilot agreement and paid the first invoice.',
    );
    expect(text).toContain('Interview ten people about the last time, due November 30');
    for (const part of UNDERSTAND_PARTS) {
      const { system, promptCache, messages } = p.parts[part] ?? p.parts.route;
      expect(messages[0]?.content).toContain('<message>\nwhat does one lab bring in\n</message>');
      expect(promptCache.systemChars).toBe(system.length);
    }
    expect(p.context.record.map((r) => r.key)).toEqual(p.context.record.map((_r, i) => `R${String(i + 1)}`));
  });

  it('on a call JUDGE is asked for what the reply opens on, and no more', () => {
    const call = prepared({ channel: 'voice' }).parts;
    expect([call.route.form, call.sums?.form, call.judge.form]).toEqual(['route', 'sums', 'judgeVoice']);
    expect(prepared().parts.judge.form).toBe('judge');
    expect(call.judge.system).toBe(JUDGE_VOICE_SYSTEM_PROMPT);
    expect(call.judge.messages[0]?.content).toContain('A phone call, as it was transcribed.');
  });

  it('show the last exchanges, and the opener only at the start', () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      founderText: `said ${String(i)}`,
      answer: `reply ${String(i)}`,
    }));
    const p = prepared({ history, opener: 'Hi Runa, how did it go?' });
    const text = p.parts.judge.messages[0]?.content ?? '';
    expect(p.context.history.map((h) => h.founder)).toEqual(['said 2', 'said 3', 'said 4', 'said 5']);
    expect(text).toContain('Founder: said 5');
    expect(text).not.toContain('Hi Runa');
    const first = prepared({ opener: 'Hi Runa, how did it go?' }).parts.judge.messages[0]?.content ?? '';
    expect(first).toContain('Mentor: Hi Runa, how did it go?');
    expect(first).not.toContain('Founder: \n');
  });

  it('the same playbook is the same system prompt, and no venture’s words are in it', () => {
    const a = prepared();
    const b = prepared({ message: 'other', venture: { ...input('').venture, name: 'Elsewhere' } });
    expect(a.parts.route.system).toBe(b.parts.route.system);
    expect(understandCatalogue(FIXTURE_PLAYBOOK)).toBe(understandCatalogue(FIXTURE_PLAYBOOK));
    expect(a.parts.route.system).not.toMatch(/ReagentLoop|reagent/i);
    expect([a.parts.sums?.system, a.parts.judge.system]).toEqual([SUMS_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT]);
  });

  it('SUMS is not asked where there is nothing to count and no figure is asked for', () => {
    const none = { reads: NO_READS, history: [] };
    expect(prepared({ ...none, message: 'where do we meet people' }).parts.sums).toBeNull();
    expect(prepared({ ...none, message: 'are we making money' }).parts.sums).not.toBeNull();
    expect(prepared({ ...none, message: 'twelve came' }).parts.sums).not.toBeNull();
  });

  it('names every play of the programme, and all three together are about as large as the one call was', () => {
    const { plays, system } = understandCatalogue(PLAYBOOK);
    expect(plays).toHaveLength(PLAYBOOK.plays.length);
    for (const play of PLAYBOOK.plays) expect(system).toContain(`\n${play.id}: `);
    expect(system.length).toBeLessThan(13_800);
    // The one call's system prompt was 22,400 characters, its schema 2,900.
    expect(system.length + SUMS_SYSTEM_PROMPT.length + JUDGE_SYSTEM_PROMPT.length).toBeLessThan(22_000);
    const schemas = UNDERSTAND_PARTS.map((part) => JSON.stringify(z.toJSONSchema(UNDERSTAND_SCHEMAS[part])));
    expect(schemas.join('').length).toBeLessThan(2_400);
  });

  it('offers the steps of the stage, the one before and the one after', () => {
    const { context } = prepared();
    const stages = new Set(
      FIXTURE_PLAYBOOK.plays.filter((p) => context.stepCandidates.has(p.id)).map((p) => p.stage),
    );
    expect([...stages].sort()).toEqual(['business_model', 'discovery', 'validation']);
  });
});

describe('which messages are read', () => {
  const due = (text: string, over: Partial<Parameters<typeof understandDue>[0]> = {}) =>
    understandDue({
      text,
      crisis: false,
      mode: null,
      counterpart: null,
      conversationMode: 'coach',
      previousReply: null,
      ...over,
    });
  it.each(['what should I charge', 'we sold nine', 'ugh, this is useless', 'ok but why'])('%s', (text) => {
    expect(due(text)).toBe(true);
  });
  it.each(['hi Thomas!', 'thanks so much, bye', 'good morning'])('not %s', (text) => {
    expect(due(text)).toBe(false);
  });
  it('a bare yes answers a question, and is none without one', () => {
    expect(due('yes', { previousReply: 'Did the two labs pay?' })).toBe(true);
    expect(due('ok', { previousReply: 'They paid.' })).toBe(false);
  });
  it('never a crisis or role-play', () => {
    expect(due('what should I charge', { crisis: true })).toBe(false);
    expect(due('what should I charge', { mode: 'rehearse' })).toBe(false);
    expect(due('what should I charge', { counterpart: 'an investor' })).toBe(false);
  });
});

describe('a turn without a reading', () => {
  it('is decided as before, the field absent or null', () => {
    for (const message of ['What should I charge?', 'We sold nine.', 'What next?']) {
      const turn = { ...input(message), continuity: {}, earlierMessages: [] };
      expect(pathTurn({ ...turn, understanding: null })).toEqual(pathTurn(turn));
    }
  });
  it('each schema has a name of its own', () => {
    expect(new Set(Object.values(UNDERSTAND_SCHEMA_NAMES)).size).toBe(UNDERSTAND_FORMS.length);
  });
});
