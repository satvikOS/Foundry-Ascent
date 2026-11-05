import { describe, expect, it } from 'vitest';

import { validateCoachResponse } from './coach-response.js';
import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';
import { SPOKEN_HAND_BACKS, asksToRepeat, isListItem, spokenHandBackFor, withoutRepeats } from './social.js';

/**
 * The whole-conversation repeat guard (live pilot 42099643194). Paraphrased patterns, never transcript text:
 * - the coach alternated two replies (A, B, A): 113 of 122 repeated sentences repeated a reply two or more turns back,
 *   and the guard compared against the previous reply only;
 * - when it did fire, it left holes: a plan with steps two and three but not one, "Ask them:" followed by nothing
 *   (41 replies in 21 runs).
 */

function gate(overrides: Partial<SentenceGateOptions> = {}): SentenceGate {
  return new SentenceGate({
    personaName: "Corin's vEIR",
    eirNames: ['Corin Halvorsen'],
    personaEirName: 'Corin Halvorsen',
    otherVentureNames: ['BenchTally'],
    otherVentureCanaries: ['ZX-CANARY-4471'],
    keepDropped: true,
    ...overrides,
  });
}

function run(g: SentenceGate, chunks: readonly string[]): GateUnit[] {
  const units: GateUnit[] = [];
  for (const chunk of chunks) {
    const r = g.push(chunk);
    units.push(...r.units);
    if (r.cut !== null) return units;
  }
  units.push(...g.end().units);
  return units;
}

const joined = (units: readonly GateUnit[]): string => units.map((u) => u.text).join('');
const chunkings = (text: string): string[][] => [[text], text.match(/.{1,7}/gs) ?? [text]];

// Two replies the coach alternated between (01-09, 28-04, paraphrased).
const A =
  'Bring the commit logs to the tech-transfer office and ask them to confirm the ownership dates in writing. ' +
  'What did the office say about the disclosure form and the filing deadline?';
const B = 'Write down which parts of the code you wrote before the lab job started, with the dates.';

describe('every earlier reply in view is guarded, not only the previous one', () => {
  it('leaves out a sentence of the reply two turns back (A, B, A)', () => {
    const reply =
      'Bring the commit logs to the tech-transfer office and ask them to confirm the ownership dates in writing. ' +
      'Since you already have the disclosure, the open question is who pays for the filing.';
    for (const chunks of chunkings(reply)) {
      const g = gate({
        previousReply: B,
        earlierReplies: [A],
        founderText: 'I already did that. What next?',
      });
      expect(joined(run(g, chunks)).trim()).toBe(
        'Since you already have the disclosure, the open question is who pays for the filing.',
      );
      expect(g.trace.repeatsDropped).toBe(1);
      expect(g.cut).toBeNull();
    }
  });

  it('with the previous reply alone, the same sentence went through (the pilot’s defect)', () => {
    const reply =
      'Bring the commit logs to the tech-transfer office and ask them to confirm the ownership dates in writing.';
    expect(joined(run(gate({ previousReply: B, founderText: 'What next?' }), [reply])).trim()).toBe(reply);
  });

  it('never asks a question an older reply asked, in other words', () => {
    const reply = 'Good. So what did the office tell you about the disclosure form and its deadline?';
    const g = gate({ previousReply: B, earlierReplies: [A], founderText: 'Done.' });
    expect(joined(run(g, [reply])).trim()).toBe('Good.');
    expect(g.trace.reasksDropped).toBe(1);
  });

  it('lets the founder ask for it again, or rerun a drill (diff3-A3)', () => {
    for (const text of [
      'Can you say that again?',
      'ok stop, run it again from the top',
      'Same questions again',
    ]) {
      expect(asksToRepeat(text), text).toBe(true);
      const g = gate({ previousReply: B, earlierReplies: [A], founderText: text });
      expect(joined(run(g, [A])).trim(), text).toBe(A);
    }
  });
});

describe('a repeat never leaves a hole', () => {
  it('ends the reply where a repeated statement follows something of substance (the caller goes on from there)', () => {
    const reply =
      'Your 70% two-size share is strong evidence: order those first. ' +
      'Write down which parts of the code you wrote before the lab job started, with the dates. ' +
      'Then split the rest of the batch by the remaining 30%.';
    for (const chunks of chunkings(reply)) {
      const g = gate({ previousReply: B, founderText: 'How should I split the order?' });
      expect(joined(run(g, chunks)).trim()).toBe(
        'Your 70% two-size share is strong evidence: order those first.',
      );
      expect(g.cut).toBe('repeat');
    }
  });

  it('ends a numbered plan at the repeated step instead of showing steps two and three without one (02-15)', () => {
    const previous = 'First, call the three stores that reordered and ask what sold out.';
    const reply =
      'Here is the plan.\n\n1. First, call the three stores that reordered and ask what sold out.\n2. Price the bundle.\n3. Pitch it.';
    expect(isListItem('1. First, call the three stores')).toBe(true);
    const g = gate({ previousReply: previous, founderText: 'Give me the plan.' });
    const shown = joined(run(g, [reply])).trim();
    expect(shown).toBe('Here is the plan.');
    expect(shown).not.toMatch(/^2\./m);
    expect(g.cut).toBe('repeat');
  });

  it('takes an announcement ("Ask them:") with the repeat that follows it, never leaving it dangling (19-18)', () => {
    const previous = 'What did it cost you the last time the delivery was late?';
    const reply =
      'Good call on the vendor. Ask them:\n\nWhat did it cost you the last time the delivery was late?';
    for (const chunks of chunkings(reply)) {
      const g = gate({ previousReply: previous, founderText: 'I am meeting the vendor.' });
      const shown = joined(run(g, chunks)).trim();
      expect(shown).not.toMatch(/:\s*$/);
      expect(shown).toBe('Good call on the vendor.');
    }
  });

  it('only leaves out a repeat that comes before anything of substance', () => {
    const reply = `Okay. ${B} The new piece is a dated contribution list from your cofounder.`;
    const g = gate({ previousReply: B, founderText: 'And then?' });
    expect(joined(run(g, [reply])).trim()).toBe(
      'Okay. The new piece is a dated contribution list from your cofounder.',
    );
    expect(g.cut).toBeNull();
  });
});

describe('the whole-reply validator matches the gate', () => {
  it('cuts at a repeated statement after substance, and leaves a re-asked question out', () => {
    const reply =
      'Your numbers are strong. Write down which parts of the code you wrote before the lab job started, with the dates. More here.';
    expect(withoutRepeats(reply, `${A}\n\n${B}`)).toEqual({ text: 'Your numbers are strong.', dropped: 2 });
    const asked =
      'Fine. What did the office say about the disclosure form and the filing deadline? Then send the summary.';
    expect(withoutRepeats(asked, A).text).toBe('Fine. Then send the summary.');
  });

  it('reads every earlier reply it is given', () => {
    const checked = validateCoachResponse(
      {
        mode: 'coach',
        answer:
          'Bring the commit logs to the tech-transfer office and ask them to confirm the ownership dates in writing. ' +
          'Then agree the filing budget with your cofounder.',
        spoken: null,
        claims: [],
        uncertainty: [],
        challenge: null,
        next_actions: [],
        escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
        memory_candidates: [],
        follow_up_questions: [],
        rehearsal: null,
      },
      {
        evidenceKeys: new Set(),
        preRisk: { categories: [] },
        otherVentureNames: [],
        otherVentureCanaries: [],
        personaName: "Corin's vEIR",
        coverageThreshold: 0.6,
        previousReply: B,
        earlierReplies: [A],
        founderText: 'Done that. Next?',
      },
    );
    expect(checked.response.answer).toBe('Then agree the filing budget with your cofounder.');
    expect(checked.results.notes).toContain('repeated_sentences_removed:1');
  });
});

describe('call hand-backs (C10, C14)', () => {
  it('never says "How does that sound?", and says none after a goodbye or a wrap-up (26-05)', () => {
    expect(SPOKEN_HAND_BACKS).not.toContain('How does that sound?');
    expect(SPOKEN_HAND_BACKS).not.toContain('Sound right to you?');
    for (const text of [
      "Got it, I'll call them tomorrow.",
      'Okay, I have to go now, bye.',
      'Thanks, talk soon!',
    ]) {
      expect(spokenHandBackFor(text, 'turn-1'), text).toBeNull();
    }
    expect(spokenHandBackFor('How do I price the pilot?', 'turn-1')).not.toBeNull();
  });
});
