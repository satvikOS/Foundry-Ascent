import { describe, expect, it } from 'vitest';

import { deriveConversationState, renderConversationState } from '../prompts/conversation-state.js';
import {
  phrasingLedger,
  questionFrame,
  rephraseQuestion,
  renderPhrasingLedger,
  withVariedQuestions,
} from '../prompts/phrasing.js';
import { validateCoachResponse, type ValidateCoachResponseOptions } from './coach-response.js';
import { inventedFigures, withoutExampleFigures, withoutInventedFigures } from './figures.js';
import { withoutStockOpener } from './openers.js';
import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';

/**
 * Coaching v3 (owner round 3, 2026-11-06): the clusters pilot v3 (42143561959, Thomas v2, after coaching v2) still left:
 * canned openers 97, name overuse in 26 of 60 runs, unsourced figures 30, and the same question asked the same way
 * ("like a script"). Every case is a paraphrased pattern, never transcript text.
 */

function gate(overrides: Partial<SentenceGateOptions> = {}): SentenceGate {
  return new SentenceGate({
    personaName: 'Thomas',
    eirNames: ['Corin Halvorsen'],
    personaEirName: 'Corin Halvorsen',
    mentor: true,
    founderName: 'Maya',
    otherVentureNames: ['BenchTally'],
    otherVentureCanaries: ['ZX-CANARY-4471'],
    ...overrides,
  });
}

function run(g: SentenceGate, chunks: readonly string[]): GateUnit[] {
  const units: GateUnit[] = [];
  for (const chunk of chunks) units.push(...g.push(chunk).units);
  units.push(...g.end().units);
  return units;
}

const shown = (units: readonly GateUnit[]): string =>
  units
    .map((u) => u.text)
    .join('')
    .trim();
/** One chunk, and seven-character chunks (the model's stream). */
const chunkings = (text: string): string[][] => [[text], text.match(/.{1,7}/gs) ?? [text]];

function response(answer: string) {
  return {
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
}

function opts(overrides: Partial<ValidateCoachResponseOptions> = {}): ValidateCoachResponseOptions {
  return {
    evidenceKeys: new Set<string>(),
    preRisk: { categories: [] },
    otherVentureNames: ['BenchTally'],
    otherVentureCanaries: ['ZX-CANARY-4471'],
    personaName: 'Thomas',
    eirNames: ['Corin Halvorsen'],
    personaEirName: 'Corin Halvorsen',
    mentor: true,
    founderName: 'Maya',
    coverageThreshold: 0.6,
    ...overrides,
  };
}

describe('stock openers the v2 list missed (pilot v3: 97)', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    // A grade with a noun the old list did not hold, a tail, or two adjectives.
    [
      'I rewrote the ask so it ties the price to what they pay now.',
      'That’s a solid revision—tying the price to their current cost makes the ask concrete.',
      'Tying the price to their current cost makes the ask concrete.',
    ],
    [
      'If three of them come to every session, I’ll count it as working.',
      'That’s a clear and measurable signal. Run the sessions as planned and write the result down.',
      'Run the sessions as planned and write the result down.',
    ],
    [
      'I have two letters of support so far.',
      'That’s a solid start with the two letters. For the third, ask the pilot school’s head teacher.',
      'For the third, ask the pilot school’s head teacher.',
    ],
    // A grade of their move answering a report: no reaction to news, and it goes.
    [
      'I’ve drafted the agreement with my team.',
      'That’s a solid step forward. Next, get the store manager to sign the thresholds.',
      'Next, get the store manager to sign the thresholds.',
    ],
    // Thanks for a detail, not only for "the update".
    [
      'She spends about half an hour a day on it.',
      'Thanks for that detail. What did she do the last time it went wrong?',
      'What did she do the last time it went wrong?',
    ],
    // "I hear you want…" says what they said back with a stock frame.
    [
      'Just brainstorm with me.',
      'I hear you want ideas now, but ideas land better on one real problem.',
      'You want ideas now, but ideas land better on one real problem.',
    ],
  ];

  it.each(cases)('%s', (founderText, reply, expected) => {
    expect(withoutStockOpener(reply, { founderText, names: ['Maya'] }).text).toBe(expected);
    for (const chunks of chunkings(reply)) expect(shown(run(gate({ founderText }), chunks))).toBe(expected);
  });

  it('keeps what is substance, a reaction to news, and empathy when they struggle', () => {
    for (const [founderText, reply] of [
      // A judgement of their situation, not of their message.
      [
        'My parents pay supplier late fees every month.',
        'That’s a real pain point: the fees repeat every month.',
      ],
      ['Is now the moment to ask?', 'It’s a good time for that, before the term starts.'],
      // News gets a reaction to the news itself.
      ['We got our first paying customer today!', 'That’s big news. Who signed, and on what terms?'],
      // Stress: "I hear you're worried" is the empathy.
      [
        'I’m really stressed, the rent is due and nothing is working.',
        'I hear you’re worried about the rent. One step for this week: ask the landlord for a payment plan.',
      ],
    ] as const) {
      expect(withoutStockOpener(reply, { founderText }).text).toBe(reply);
    }
  });
});

describe('the stored answer is what the gate released (the root of pilot v3’s openers and names)', () => {
  it('leaves out of a released answer what the gate left out of every unit: opener, name, made-up figure, form', () => {
    const founderText = 'I will send the survey to the landlords this week.';
    const reply =
      'That’s a smart move, Maya. Offer a $10 gift card for the first twenty replies. What’s the smallest group you could send it to first?';
    const g = gate({
      founderText,
      previousReply: 'Good luck with it, Maya.',
      pastReplies: ['What’s the smallest step you could take before Friday?'],
      knownFigures: founderText,
    });
    const said = shown(run(g, [reply]));
    expect(said).toBe(
      'Offer a gift card for the first twenty replies. Of the groups you could send it to first, which is the smallest?',
    );
    const stored = validateCoachResponse(
      response(reply),
      opts({
        founderText,
        previousReply: 'Good luck with it, Maya.',
        pastReplies: ['What’s the smallest step you could take before Friday?'],
        knownFigures: founderText,
        released: true,
      }),
    );
    expect(stored.response.answer).toBe(said);
    expect(stored.results.notes).toEqual(
      expect.arrayContaining(['stock_opener_removed', 'invented_figure_removed:1', 'question_rephrased:1']),
    );
  });
});

describe("the founder's name across conversations (pilot v3: overuse in 26 of 60 runs)", () => {
  it('counts the end of the last conversation too: a new conversation does not open on the name again', () => {
    const reply = 'Hi Maya, where did the landlord call land?';
    const past = ['Talk soon, Maya.', 'Send it tonight.', 'Good.'];
    expect(shown(run(gate({ founderText: 'Hi!', pastReplies: past }), [reply]))).toBe(
      'Hi, where did the landlord call land?',
    );
    // With nothing said for a while, the name is welcome.
    expect(
      shown(run(gate({ founderText: 'Hi!', pastReplies: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), [reply])),
    ).toBe(reply);
  });

  it('keeps one reply in four at most over a nine-reply conversation (the old window allowed replies 1, 5 and 9)', () => {
    const replies: string[] = [];
    let named = 0;
    for (let i = 0; i < 9; i += 1) {
      const g = gate({
        founderText: 'ok, next?',
        previousReply: replies.at(-1) ?? null,
        earlierReplies: replies.slice(0, -1),
      });
      const out = shown(run(g, [`Thanks, Maya. Step ${String(i + 1)} is the pricing page.`]));
      if (out.includes('Maya')) named += 1;
      replies.push(out);
    }
    expect(named * 4).toBeLessThanOrEqual(9);
  });
});

describe('question forms: a phrasing ledger and a rephrase, never a drop', () => {
  it('reads a question’s form without its lead-in, and no form for a short question or a quoted line', () => {
    expect(questionFrame('So, what’s the smallest step you could take this week?')).toBe(
      "what's the smallest",
    );
    expect(questionFrame('What is the smallest step you could take?')).toBe("what's the smallest");
    expect(questionFrame('Who pays?')).toBeNull();
    expect(questionFrame('“What’s the biggest problem with your invoices?”')).toBeNull();
  });

  it('says a recently used form another way, with the same substance', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      [
        'What’s the smallest step you could take this week to test that?',
        "what's the smallest",
        'Of the steps you could take this week to test that, which is the smallest?',
      ],
      [
        'What’s the one thing you want the judges to remember?',
        "what's the one",
        'Of the things you want the judges to remember, which matters most?',
      ],
      [
        'What’s the single biggest risk to the pilot right now?',
        "what's the single",
        'Of the risks to the pilot right now, which is the biggest?',
      ],
      [
        'So, what’s the first thing you’d change in the deck?',
        "what's the first",
        'So, of the things you’d change in the deck, which comes first?',
      ],
      ['How will you know the pilot worked?', 'how will you', 'How are you going to know the pilot worked?'],
      [
        'What will you say to the store manager?',
        'what will you',
        'What are you going to say to the store manager?',
      ],
      [
        'Do you have a written agreement with them?',
        'do you have',
        'Have you got a written agreement with them?',
      ],
      [
        'What’s your plan for the second cohort?',
        "what's your plan",
        'How are you planning to handle the second cohort?',
      ],
    ];
    for (const [question, form, expected] of cases) {
      expect(questionFrame(question)).toBe(form);
      expect(rephraseQuestion(question, new Set([form]))).toEqual({ text: expected, changed: true });
      // A form not used lately stands.
      expect(rephraseQuestion(question, new Set())).toEqual({ text: question, changed: false });
    }
  });

  it('leaves a question alone when no alternative is known, every alternative was used, or it asks two things', () => {
    const two = 'What’s the earliest date you could start, and who signs the order?';
    expect(rephraseQuestion(two, new Set(["what's the earliest"])).changed).toBe(false);
    const q = 'Who signs off on the budget there?';
    expect(rephraseQuestion(q, new Set([questionFrame(q) ?? '']))).toEqual({ text: q, changed: false });
    const h = 'How will you know the pilot worked?';
    expect(rephraseQuestion(h, new Set(['how will you', 'how are you'])).changed).toBe(false);
  });

  it('never asks two questions of one reply in the same form', () => {
    const reply = 'What’s the biggest cost you face? And what’s the biggest delay in delivery today?';
    expect(withVariedQuestions(reply, new Set())).toEqual({
      text: 'What’s the biggest cost you face? And of the delays in delivery today, which is the biggest?',
      rephrased: 1,
    });
  });

  it('keeps a compact ledger of its own forms and openings, here and at the end of the last conversations', () => {
    const ledger = phrasingLedger(
      [
        'Here is the draft. What’s the smallest group you could send it to?',
        'Good. What’s the smallest step before Friday?',
      ],
      ['How will you know the pilot worked this time?'],
    );
    expect(ledger.questions).toEqual([
      { form: "what's the smallest", count: 2, earlier: false },
      { form: 'how will you', count: 1, earlier: true },
    ]);
    const line = renderPhrasingLedger(ledger);
    expect(line).toContain('questions shaped "what\'s the smallest …" ×2, "how will you …" (also last time)');
    expect(line).toContain('Keep the substance consistent, but word this reply');
    expect(renderPhrasingLedger(phrasingLedger(['Fine.'], []))).toBe('');
  });

  it('is said in <conversation_state>, on a new conversation’s first message too', () => {
    const state = deriveConversationState([], 'Hi, I sent the survey.', {
      pastReplies: [
        'What’s the smallest group you could send it to?',
        'What’s the smallest step before Friday?',
      ],
    });
    expect(renderConversationState(state)).toContain(
      'questions shaped "what\'s the smallest …" ×2 (also last time)',
    );
  });
});

describe('figures nobody gave, said by what they are (pilot v3: 30)', () => {
  const known = 'We sell 45 crates a week at $3.50 each.';
  it('takes the number out where the sentence reads as well without it', () => {
    for (const [reply, expected] of [
      [
        'Offer a small reward (a $10 gift card) for the first twenty sign-ups.',
        'Offer a small reward (a gift card) for the first twenty sign-ups.',
      ],
      ['Add a 10 percent discount if they commit by Friday.', 'Add a discount if they commit by Friday.'],
      [
        'Ask: would you pay $2/month for verified reviews?',
        'Ask: would you pay a monthly price for verified reviews?',
      ],
      ['Sell it at $30 per unit to the landlords.', 'Sell it at a set price per unit to the landlords.'],
      ['A $12 evening class is a clear win for them.', 'An evening class is a clear win for them.'],
    ] as const) {
      expect(withoutInventedFigures(reply, known)).toEqual({ text: expected, removed: 1 });
    }
    // An aside offering a range goes whole (validators/figures.ts `withoutExampleFigures`).
    expect(
      withoutExampleFigures('A small paid pre-order (even $5–$10) shows who is serious.', known).text,
    ).toBe('A small paid pre-order shows who is serious.');
  });

  it('never touches their numbers, arithmetic on them, or a figure the sentence needs', () => {
    for (const reply of [
      'At $3.50 a crate, 45 crates is $157.50 a week.',
      'Run the $2/month question right away.',
      'Ask if they would pay $2.',
    ]) {
      expect(withoutInventedFigures(reply, known).text).toBe(reply);
    }
    expect(inventedFigures('Ask if they would pay $2.', known).unsourced).toEqual(['$2']);
  });
});
