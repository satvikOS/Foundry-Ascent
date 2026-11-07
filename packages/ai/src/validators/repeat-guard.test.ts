import { describe, expect, it } from 'vitest';

import { validateCoachResponse } from './coach-response.js';
import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';
import { announcedCountGap, asksToRepeat, isListItem, withoutRepeats, withoutUnits } from './social.js';

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
  it('leaves out only the repeated statement, never what follows it (no truncation)', () => {
    const reply =
      'Your 70% two-size share is strong evidence: order those first. ' +
      'Write down which parts of the code you wrote before the lab job started, with the dates. ' +
      'Then split the rest of the batch by the remaining 30%.';
    for (const chunks of chunkings(reply)) {
      const g = gate({ previousReply: B, founderText: 'How should I split the order?' });
      expect(joined(run(g, chunks)).trim()).toBe(
        'Your 70% two-size share is strong evidence: order those first. ' +
          'Then split the rest of the batch by the remaining 30%.',
      );
      expect(g.cut).toBeNull();
    }
  });

  it('never leaves out a safety line, and on a flagged turn never a referral, however often it was said', () => {
    const referral = 'Take the ownership question to the tech-transfer office before you file anything.';
    const safety = 'If you feel unsafe at any point, call or text 988 right away.';
    const earlier = `${referral} ${safety}`;
    const reply = `You already have the logs, good. ${referral} ${safety}`;
    // Unflagged: the referral said again goes, the safety line stays, and nothing after a repeat is cut.
    for (const chunks of chunkings(reply)) {
      const g = gate({ previousReply: earlier, founderText: 'I have the logs now.' });
      expect(joined(run(g, chunks)).trim()).toBe(`You already have the logs, good. ${safety}`);
      expect(g.cut).toBeNull();
    }
    expect(withoutRepeats(reply, earlier).text).toBe(`You already have the logs, good. ${safety}`);
    // Flagged (an IP question this turn): the referral stays too.
    for (const chunks of chunkings(reply)) {
      const g = gate({ previousReply: earlier, founderText: 'Who owns the patent?', keepReferrals: true });
      expect(joined(run(g, chunks)).trim()).toBe(reply);
    }
    expect(withoutRepeats(reply, earlier, { keepReferrals: true })).toMatchObject({
      text: reply,
      dropped: 0,
    });
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
    // A flagged turn is never cut short: the step goes, the rest of the plan stays.
    const flagged = gate({ previousReply: previous, founderText: 'Give me the plan.', keepReferrals: true });
    expect(joined(run(flagged, [reply])).trim()).toBe(
      'Here is the plan.\n2. Price the bundle.\n3. Pitch it.',
    );
    expect(flagged.cut).toBeNull();
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
  it('leaves out only the repeated statement and a re-asked question, and names what it left out', () => {
    const reply =
      'Your numbers are strong. Write down which parts of the code you wrote before the lab job started, with the dates. More here.';
    expect(withoutRepeats(reply, `${A}\n\n${B}`)).toEqual({
      text: 'Your numbers are strong. More here.',
      dropped: 1,
      removed: ['Write down which parts of the code you wrote before the lab job started, with the dates.'],
    });
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

describe('a streamed reply is stored as the gate released it', () => {
  it('removes exactly the units the gate left out, in order', () => {
    const reply = `Okay. ${B} The new piece is a dated contribution list.`;
    expect(withoutUnits(reply, [B])).toBe('Okay. The new piece is a dated contribution list.');
    expect(withoutUnits(reply, [])).toBe(reply);
    expect(withoutUnits(reply, ['not in it'])).toBe(reply);
  });

  it('is never edited for repeats again once released (the stored answer is what was shown and said)', () => {
    // Two short sentences the gate judged as one unit: as a unit it is new, while its second sentence alone repeats.
    const answer =
      'Right. Bring the commit logs to the tech-transfer office and ask them to confirm the dates.';
    const base = {
      evidenceKeys: new Set<string>(),
      preRisk: { categories: [] },
      otherVentureNames: [],
      otherVentureCanaries: [],
      personaName: "Corin's vEIR",
      coverageThreshold: 0.6,
      previousReply: A,
      founderText: 'And then?',
    };
    const raw = {
      mode: 'coach' as const,
      answer,
      spoken: null,
      claims: [],
      uncertainty: [],
      challenge: null,
      next_actions: [],
      escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
      memory_candidates: [],
      follow_up_questions: [],
      rehearsal: null,
    };
    expect(validateCoachResponse(raw, base).response.answer).not.toBe(answer);
    const released = validateCoachResponse(raw, { ...base, released: true });
    expect(released.response.answer).toBe(answer);
    expect(released.results.notes.some((n) => n.startsWith('repeated_sentences_removed'))).toBe(false);
  });

  it('loses what the gate took out inside a unit, the same way (coaching v3: pilot v3 stored 97 stock openers)', () => {
    // The gate left "That's a solid plan." and the name out of what was shown and said; the stored answer (what a
    // reload shows, the model's own history, the lab's transcript) did not, until v3.
    const answer = "That's a solid plan, Maya. Book the room for Thursday and send the two invites tonight.";
    const opts = {
      evidenceKeys: new Set<string>(),
      preRisk: { categories: [] },
      otherVentureNames: [],
      otherVentureCanaries: [],
      personaName: 'Thomas',
      coverageThreshold: 0.6,
      founderName: 'Maya',
      previousReply: 'Good luck with it, Maya.',
      founderText: "I'll book the room and send the invites.",
      released: true,
    };
    const raw = {
      mode: 'coach' as const,
      answer,
      spoken: null,
      claims: [],
      uncertainty: [],
      challenge: null,
      next_actions: [],
      escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
      memory_candidates: [],
      follow_up_questions: [],
      rehearsal: null,
    };
    const stored = validateCoachResponse(raw, opts).response.answer;
    expect(stored).toBe('Book the room for Thursday and send the two invites tonight.');
    const g = new SentenceGate({
      personaName: 'Thomas',
      founderName: 'Maya',
      previousReply: 'Good luck with it, Maya.',
      founderText: "I'll book the room and send the invites.",
      otherVentureNames: [],
      otherVentureCanaries: [],
    });
    const shownUnits = [...g.push(answer).units, ...g.end().units].map((u) => u.text).join('');
    expect(shownUnits.trim()).toBe(stored);
  });
});

describe('a reply that announces more steps than it gives', () => {
  it('finds a count announced and not given, and a numbered list that skips', () => {
    expect(announcedCountGap('Three steps:\n\n1. Call them.\n2. Price it.')).toEqual({
      announced: 3,
      given: 2,
    });
    expect(announcedCountGap('Here is the plan.\n\n2. Price it.\n3. Pitch it.')).toEqual({
      announced: 3,
      given: 2,
    });
    expect(announcedCountGap('Two things:\n- Call them.\n- Price it.')).toBeNull();
    expect(announcedCountGap('1. Call.\n2. Price.\n\nThen:\n1. Pitch.\n2. Close.')).toBeNull();
    expect(announcedCountGap('We have three options and I like the first.')).toBeNull();
  });
});

describe('escalation source telemetry (classifier, model or both)', () => {
  const raw = (required: boolean) => ({
    mode: 'coach' as const,
    answer: 'A lawyer should read that clause before you sign.',
    spoken: null,
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [],
    escalation: required
      ? {
          required: true,
          category: 'legal' as const,
          priority: 'P1' as const,
          reason: 'Contract terms.',
          requested_role: 'specialist' as const,
        }
      : { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
  });
  const base = {
    evidenceKeys: new Set<string>(),
    otherVentureNames: [],
    otherVentureCanaries: [],
    personaName: "Corin's vEIR",
    coverageThreshold: 0.6,
  };
  it('records where each escalation came from', () => {
    const notes = (required: boolean, categories: 'legal'[]) =>
      validateCoachResponse(raw(required), { ...base, preRisk: { categories } }).results.notes;
    expect(notes(false, ['legal'])).toContain('escalation_source:classifier');
    expect(notes(true, [])).toContain('escalation_source:model');
    expect(notes(true, ['legal'])).toContain('escalation_source:both');
    expect(notes(false, []).some((n) => n.startsWith('escalation_source'))).toBe(false);
  });
});
