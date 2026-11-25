import { UNDERSTAND_SCHEMA_NAME, type PromptContinuity } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { coreConfig, loadConfig } from '../config.js';
import { FIXTURE_PLAYBOOK } from '../path/testing/fixture-playbook.js';
import { PLAYBOOK } from '../path/playbook/index.js';
import { input, LAB_MEMORY, NO_READS, storedStep, TODAY, VENTURE_ID } from '../path/testing/inputs.js';
import { pathTurn } from '../path/turn.js';
import { prepareUnderstand, understandCatalogue, understandDue, type UnderstandInput } from './understand.js';

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

describe('what the call reads', () => {
  it('holds the record, the open step and the message, and nothing of another kind', () => {
    const p = prepared();
    const text = p.messages[0]?.content ?? '';
    expect(p.messages).toHaveLength(1);
    expect(text).toContain('Two labs signed the pilot agreement and paid the first invoice.');
    expect(text).toContain('Interview ten people about the last time, due November 30');
    expect(text).toContain('<message>\nwhat does one lab bring in\n</message>');
    expect(p.context.record.map((r) => r.key)).toEqual(p.context.record.map((_r, i) => `R${String(i + 1)}`));
    expect(p.promptCache.systemChars).toBe(p.system.length);
  });

  it('shows the last four exchanges, and the opener only at the start', () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      founderText: `said ${String(i)}`,
      answer: `reply ${String(i)}`,
    }));
    const p = prepared({ history, opener: 'Hi Runa, how did it go?' });
    const text = p.messages[0]?.content ?? '';
    expect(p.context.history.map((h) => h.founder)).toEqual(['said 2', 'said 3', 'said 4', 'said 5']);
    expect(text).not.toContain('Hi Runa');
    const first = prepared({ opener: 'Hi Runa, how did it go?' }).messages[0]?.content ?? '';
    expect(first).toContain('Mentor: Hi Runa, how did it go?');
    expect(first).not.toContain('Founder: \n');
  });

  it('the same playbook is the same system prompt, and no venture’s words are in it', () => {
    const a = prepared();
    const b = prepared({ message: 'other', venture: { ...input('').venture, name: 'Elsewhere' } });
    expect(a.system).toBe(b.system);
    expect(understandCatalogue(FIXTURE_PLAYBOOK)).toBe(understandCatalogue(FIXTURE_PLAYBOOK));
    expect(a.system).not.toMatch(/ReagentLoop|reagent/i);
  });

  it('names every play of the programme, small enough to be read on every turn', () => {
    const { plays, system } = understandCatalogue(PLAYBOOK);
    expect(plays).toHaveLength(PLAYBOOK.plays.length);
    for (const play of PLAYBOOK.plays) expect(system).toContain(`\n${play.id} [${play.stage}]: `);
    expect(system.length / 4).toBeLessThan(6_500);
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
  it('the schema has one name', () => {
    expect(UNDERSTAND_SCHEMA_NAME).toBe('Understanding');
  });
});
