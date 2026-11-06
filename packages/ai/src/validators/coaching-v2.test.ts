import { type CoachResponse as CoachResponseType } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import {
  deriveConversationState,
  founderMoves,
  preferencesOf,
  renderConversationState,
  statedPreferences,
  type StateTurn,
} from '../prompts/conversation-state.js';
import { conversationCraftRules } from '../prompts/craft.js';
import { validateCoachResponse, type ValidateCoachResponseOptions } from './coach-response.js';
import { inventedFigures, withoutExampleFigures } from './figures.js';
import { nameUsedRecently, withoutStockOpener, withoutVocativeName } from './openers.js';
import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';

/**
 * Coaching v2: the clusters live pilot 42124259353 left after the first round of fixes (canned openers 22.8 per 100
 * replies, unsourced figures 32 and proposed 11, name overuse in 15 runs; pitch rehearsal, conversation control and
 * recovery at 1.83 naturalness). Every case below is a paraphrased pattern, never transcript text.
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
    keepDropped: true,
    ...overrides,
  });
}

function run(g: SentenceGate, chunks: readonly string[]): GateUnit[] {
  const units: GateUnit[] = [];
  for (const chunk of chunks) units.push(...g.push(chunk).units);
  units.push(...g.end().units);
  return units;
}

const shown = (units: readonly GateUnit[]): string => units.map((u) => u.text).join('');
/** One chunk, and seven-character chunks (the model's stream). */
const chunkings = (text: string): string[][] => [[text], text.match(/.{1,7}/gs) ?? [text]];

describe('canned openers: the reply starts with its substance', () => {
  // Paraphrased: a verdict on the student's plan, a thank-you for the update, praise, "I hear you".
  const cases: readonly (readonly [string, string, string])[] = [
    [
      'We lined up two cafés for the pilot.',
      "That's a solid plan. Start with the café that has evening foot traffic.",
      'Start with the café that has evening foot traffic.',
    ],
    [
      'Here is where the survey is at.',
      'Thanks for the update. Forty replies is enough to see the split by year.',
      'Forty replies is enough to see the split by year.',
    ],
    [
      'Should we price per seat?',
      'Great question! Per seat fits how departments budget.',
      'Per seat fits how departments budget.',
    ],
    [
      'The landlord might say no.',
      'I hear you. Ask for a three-month trial clause first.',
      'Ask for a three-month trial clause first.',
    ],
    [
      'Can you look at the deck outline?',
      'I see. Slide two should carry the cost of the workaround.',
      'Slide two should carry the cost of the workaround.',
    ],
    [
      'Which segment first?',
      "Here's my honest read: start with the second-year societies.",
      'Start with the second-year societies.',
    ],
    [
      'We kept the price at $12.',
      "Perfect — that's what the two clubs already pay.",
      "That's what the two clubs already pay.",
    ],
    [
      'I talked to the lab manager.',
      "You're on the right track, Maya. The next call is the department head.",
      'The next call is the department head.',
    ],
  ];

  it('leaves the stock opener out of a reply written whole', () => {
    for (const [founder, reply, expected] of cases) {
      expect(withoutStockOpener(reply, { names: ['Maya'], founderText: founder }).text, reply).toBe(expected);
    }
  });

  it('leaves it out of a streamed reply, whatever the chunking, and counts it', () => {
    for (const [founder, reply, expected] of cases) {
      for (const chunks of chunkings(reply)) {
        const g = gate({ founderText: founder });
        expect(shown(run(g, chunks)).trim(), reply).toBe(expected);
        expect(g.trace.openersDropped, reply).toBeGreaterThan(0);
        expect(g.trace.dropped.some((d) => d.reason === 'opener')).toBe(true);
      }
    }
  });

  it('keeps a reply that is nothing but the line, and an answer the student asked for', () => {
    const only = gate({ founderText: 'We start Monday.' });
    expect(shown(run(only, ["That's a solid plan."])).trim()).toBe("That's a solid plan.");
    // "Does that sound like a solid plan?": the verdict is the answer.
    const asked = 'Does that sound like a solid plan?';
    expect(
      withoutStockOpener('That sounds like a solid plan. Book the room today.', { founderText: asked }).text,
    ).toBe('That sounds like a solid plan. Book the room today.');
    // "Should I raise prices?": "Absolutely." is the yes.
    expect(
      withoutStockOpener('Absolutely. Your cost went up a third.', { founderText: 'Should I raise prices?' })
        .removed,
    ).toBe(false);
  });

  it('answers small talk, thanks and news in kind', () => {
    expect(
      withoutStockOpener('Good, thanks! What are we working on?', { founderText: 'how are you?' }).removed,
    ).toBe(false);
    expect(withoutStockOpener("You're welcome. Good luck Friday.", { founderText: 'thanks!' }).removed).toBe(
      false,
    );
    expect(
      withoutStockOpener("That's big news. How did the dean react?", {
        founderText: 'We got the dean to say yes!',
      }).removed,
    ).toBe(false);
  });

  it('never touches a sentence that says something ("That\'s a key risk with the landlord…")', () => {
    const reply = "That's a key risk with the landlord, so ask before you sign.";
    expect(withoutStockOpener(reply, { founderText: 'Is the lease ok?' }).text).toBe(reply);
  });

  it('is gone from the prompt as a list (it primed the habit) and stated as what to do instead', () => {
    const craft = conversationCraftRules('text');
    expect(craft).not.toContain('"Thanks for"');
    expect(craft).not.toContain('"That\'s a"');
    expect(craft).toContain('Start with the substance');
  });
});

describe("the founder's name: at most one reply in four", () => {
  it('is left out where it is said to them while one of the last three replies named them', () => {
    expect(nameUsedRecently('Maya', ['Good luck Friday.', 'Thanks, Maya.'])).toBe(true);
    expect(nameUsedRecently('Maya', ['a', 'b', 'c', 'Thanks, Maya.'])).toBe(false);
    expect(nameUsedRecently('Maya', ["Maya's survey is done."])).toBe(false);
    for (const [reply, expected] of [
      [
        "You're very welcome, Maya. Good luck with the pitch!",
        "You're very welcome. Good luck with the pitch!",
      ],
      ['Maya, the deck needs one slide on cost.', 'The deck needs one slide on cost.'],
      ['Thanks, Maya!', 'Thanks!'],
      ["Ask Maya's cofounder for the numbers.", "Ask Maya's cofounder for the numbers."],
    ] as const) {
      expect(withoutVocativeName(reply, 'Maya').text).toBe(expected);
    }
  });

  it('streams the same, and keeps the name when no recent reply used it', () => {
    const reply = "You're very welcome, Maya. Polish the cost slide tonight.";
    const recent = gate({ founderText: 'Thanks again', previousReply: 'Good luck, Maya.' });
    expect(shown(run(recent, [reply])).trim()).toBe("You're very welcome. Polish the cost slide tonight.");
    const fresh = gate({ founderText: 'Thanks again', previousReply: 'Good luck.' });
    expect(shown(run(fresh, [reply])).trim()).toBe(reply);
  });
});

describe('figures nobody gave', () => {
  const known = 'We sell 40 crates a week at $3.50 each; our workaround costs $2,500 a month.';

  it("excuses the founder's numbers and arithmetic on them, and tells proposed from stated", () => {
    expect(inventedFigures('That is $140 a week from the crates.', known)).toEqual({
      unsourced: [],
      proposed: [],
    });
    expect(inventedFigures('A deposit of $1,250 is half the workaround.', known).unsourced).toEqual([]);
    expect(inventedFigures('Ask if they would pay $2 a month.', known).unsourced).toEqual(['$2']);
    expect(inventedFigures('Stop if fewer than 15% reorder.', known).proposed).toEqual(['15%']);
  });

  it('leaves out an aside that offers a made-up figure as an example, never one with their numbers', () => {
    expect(
      withoutExampleFigures('Charge a small deposit (say, $5 a crate) and see who keeps them.', known).text,
    ).toBe('Charge a small deposit and see who keeps them.');
    expect(withoutExampleFigures('Anchor on the workaround (say $2,500 a month).', known).removed).toBe(0);
    expect(
      withoutExampleFigures('Aim for a fraction of that — e.g. $1 a crate — so it nudges.', known).text,
    ).toBe('Aim for a fraction of that so it nudges.');
  });

  it('is counted on the turn record, and asked of the prompt in plain words', () => {
    const out = validateCoachResponse(
      response('Ask if they would pay $2 a month. That is $140 a week now.'),
      opts({ knownFigures: known }),
    );
    expect(out.results.notes).toContain('invented_figure:1');
    expect(conversationCraftRules('text')).toContain(
      'Never a figure of your own in a price, threshold, target or example',
    );
  });
});

describe('conversation control', () => {
  it('reads the moves: practise, step out, later, start over, summary, a resend, a failure, a complaint, unsure', () => {
    const cases: readonly (readonly [string, string])[] = [
      ["Let's practise the investor Q&A, play a sceptical VC.", 'rehearse'],
      ['Can we go back to a simpler question?', 'step_out'],
      ['How did I do?', 'step_out'],
      ["Can we come back to that later? I'd rather do pricing.", 'defer'],
      ["Let's start over from scratch.", 'restart'],
      ['Can you give me a summary of what we decided?', 'summary'],
      ['Your last reply got cut off halfway.', 'lost_reply'],
      ['I got an error on my side, sending it again.', 'lost_reply'],
      ["Sorry, your message didn't come through.", 'lost_reply'],
      ['Our call dropped, where were we?', 'lost_reply'],
      ['You keep repeating the same advice.', 'complaint'],
      ['Your replies seem generic today.', 'complaint'],
      ['hmm', 'hesitant'],
      ["Let's talk about something else entirely.", 'topic_shift'],
      ['That was wrong, the grant is for teams of two.', 'repair'],
    ];
    for (const [text, move] of cases) expect(founderMoves(text), text).toContain(move);
    expect(founderMoves('I need to practice my pitch at some point')).not.toContain('rehearse');
  });

  // Review: each move injects a directive that takes over the reply, so everyday founder phrasing about their venture
  // must not read as a move about this conversation.
  it.each([
    ['We ran the ad campaign and it failed. What now?', 'lost_reply'],
    ['Something went wrong with our pilot launch.', 'lost_reply'],
    ['I got an error in the checkout flow we built.', 'lost_reply'],
    ['The sales call dropped the price objection on us.', 'lost_reply'],
    ["I'm sending it again to the investor tomorrow.", 'lost_reply'],
    ['Can you review my executive summary for the grant?', 'summary'],
    ['Our summary slide is weak, how do I fix it?', 'summary'],
    ['We rebuilt the onboarding from scratch, does it help retention?', 'restart'],
    ['I had to restart the server twice during the demo.', 'restart'],
    ['We need a fresh start with the brand.', 'restart'],
    ['The customer feedback was vague, that is vague to me too.', 'complaint'],
    ['this is slow', 'complaint'],
    ['The onboarding is so generic, how do we stand out?', 'complaint'],
    ['Are you vague with investors on purpose?', 'complaint'],
    ["Let's talk about pricing", 'topic_shift'],
    ['Could the hospital be a buyer for this?', 'rehearse'],
    ['We have a mock interview with the dean next week.', 'rehearse'],
    ['I want to drill down into churn.', 'rehearse'],
    ['I want to run through the numbers with you.', 'rehearse'],
    ['We will table it at the board meeting.', 'defer'],
    ['Later, though, we will need to hire.', 'defer'],
  ])('reads everyday phrasing as no move about the conversation: %s (not %s)', (text, move) => {
    expect(founderMoves(text)).not.toContain(move);
  });

  it('renders no conversation-control directive for everyday phrasing', () => {
    const history: StateTurn[] = [{ founderText: 'How should we price it?', answer: 'Per session first.' }];
    for (const text of [
      'We ran the ad campaign and it failed. What now?',
      'Can you review my executive summary for the grant?',
      'We rebuilt the onboarding from scratch, does it help retention?',
      'The customer feedback was vague, that is vague to me too.',
    ]) {
      const state = renderConversationState(deriveConversationState(history, text));
      expect(state, text).not.toMatch(
        /Something failed on their side|They want a summary|fresh start|unhappy with your replies/,
      );
    }
  });

  it('keeps the stated preferences, the new "no questions" among them, until they change', () => {
    expect(preferencesOf('Please stop asking me questions, just tell me.')).toContain('no questions');
    expect(preferencesOf('Yes or no answers only please')).toContain('yes/no answers');
    expect(preferencesOf('Too long, shorter please')).toContain('short answers');
    expect(
      statedPreferences(['Yes or no answers only please', 'We have 40 orders.'], 'Should I take more?'),
    ).toEqual(['yes/no answers']);
  });

  it('tells the coach how to keep them: yes/no with a reason, no bare "Yes." to a statement; no questions at all', () => {
    const state = renderConversationState(
      deriveConversationState(
        [{ founderText: 'Yes or no answers only. No more questions either.', answer: 'Understood.' }],
        'I can only make 20 of the 40.',
      ),
    );
    expect(state).toContain('Never a bare "Yes." to anything else.');
    expect(state).toContain('No questions at all');
  });

  it('enforces "no more questions" on the reply, streamed and whole', () => {
    const reply = 'Take the 20 you can make first. Which buyers are waiting longest?';
    const g = gate({ founderText: 'Should I take more orders?', noQuestions: true });
    expect(shown(run(g, [reply])).trim()).toBe('Take the 20 you can make first.');
    const whole = validateCoachResponse(
      response(reply),
      opts({ noQuestions: true, founderText: 'Should I take more?' }),
    );
    expect(whole.response.answer).toBe('Take the 20 you can make first.');
  });

  it('parks a topic for later, follows a change of subject, starts over and summarises on request', () => {
    const history: StateTurn[] = [
      {
        founderText: 'How should we price the tutoring sessions for first years?',
        answer: 'Per session first.',
      },
    ];
    const defer = renderConversationState(
      deriveConversationState(history, "Can we come back to that later? Let's do hiring."),
    );
    expect(defer).toContain('for later: drop it now; bring it back once, later');
    const shift = renderConversationState(
      deriveConversationState(history, "Let's talk about something else entirely."),
    );
    expect(shift).toContain('They changed the subject: follow them fully');
    expect(renderConversationState(deriveConversationState(history, 'Can we start over?'))).toContain(
      'fresh start',
    );
    expect(renderConversationState(deriveConversationState(history, 'Summarise what we decided.'))).toContain(
      'decisions and next steps of this conversation only',
    );
  });
});

describe('pitch rehearsal', () => {
  const inRoleReply = '**Investor:** "Thirty percent more time compared with what, exactly?"';

  it("starts the role-play when asked, with the counterpart's first line", () => {
    const state = renderConversationState(
      deriveConversationState([], 'Can you play a sceptical investor and let me pitch?'),
    );
    expect(state).toContain('They want to practise: play the person they name');
  });

  it('stays in character, reacting to the answer, and steps out after two or three exchanges', () => {
    const one: StateTurn[] = [{ founderText: 'Play a VC.', answer: inRoleReply }];
    const first = renderConversationState(
      deriveConversationState(one, 'Our pilot showed people stayed longer.'),
    );
    expect(first).toContain('You are role-playing: stay in character');
    expect(first).not.toContain('step out briefly');
    const two: StateTurn[] = [
      ...one,
      { founderText: 'We measured it.', answer: '**Investor:** "How many visitors?"' },
    ];
    const second = renderConversationState(deriveConversationState(two, 'About two hundred.'));
    expect(second).toContain('Your last 2 replies were all in character');
  });

  it('steps out at once when the student speaks to the coach, not the counterpart', () => {
    const one: StateTurn[] = [{ founderText: 'Play a VC.', answer: inRoleReply }];
    for (const text of [
      'Can we go back to a simpler question?',
      'Stop the role-play, I want real feedback now.',
      'How did I do?',
    ]) {
      expect(renderConversationState(deriveConversationState(one, text)), text).toContain(
        'They stepped out of the role-play: answer as yourself at once',
      );
    }
  });
});

describe('recovery and long sessions', () => {
  it('reads a resend as a resend, and a failure as something to make up for, never a restart', () => {
    const history: StateTurn[] = [
      {
        founderText: 'How do I find the budget owner at the hospital?',
        answer: 'Ask procurement who signs.',
      },
    ];
    expect(
      renderConversationState(
        deriveConversationState(history, 'How do I find the budget owner at the hospital?'),
      ),
    ).toContain('They sent the same message as last time');
    expect(
      renderConversationState(deriveConversationState(history, 'Your reply cut off halfway.')),
    ).toContain('never start over, recap everything or introduce yourself again');
    expect(
      renderConversationState(deriveConversationState(history, 'Your answers seem generic today.')),
    ).toContain('own it in a few plain words');
  });

  it('remembers the advice it already gave beyond the last two replies, and says not to give it again', () => {
    const history: StateTurn[] = [
      {
        founderText: 'Slide two?',
        answer: 'Lead slide two with the cost of the current workaround for clinics.',
      },
      { founderText: 'Slide three?', answer: 'Put the pilot result on slide three, in one number.' },
      { founderText: 'Slide four?', answer: 'Cut slide four; the team slide goes last.' },
      { founderText: 'Slide five?', answer: 'Keep the ask to one line.' },
    ];
    const state = deriveConversationState(history, 'And slide six?');
    expect(state.adviceGiven).toEqual([
      'Lead slide two with the cost of the current workaround for clinics.',
      'Put the pilot result on slide three, in one number.',
    ]);
    expect(renderConversationState(state)).toContain('Earlier in this conversation you already said');
  });
});

function response(answer: string): CoachResponseType {
  return {
    mode: 'coach',
    answer,
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
    evidenceKeys: new Set(['E1']),
    preRisk: { categories: [] },
    otherVentureNames: ['BrightLoop'],
    otherVentureCanaries: ['CANARY-7f3a91'],
    personaName: 'Thomas',
    eirNames: ['Corin Halvorsen'],
    personaEirName: 'Corin Halvorsen',
    mentor: true,
    coverageThreshold: 0.6,
    ...overrides,
  };
}

describe('review of coaching v2: empathy and names', () => {
  it('keeps "I hear you" on a distress turn, and thanks on a flagged turn; praise still goes', () => {
    const distress = "I'm exhausted and honestly thinking of giving up on everything.";
    expect(
      withoutStockOpener('I hear you. That is a lot to carry right now. Are you safe?', {
        founderText: distress,
      }),
    ).toEqual({
      text: 'I hear you. That is a lot to carry right now. Are you safe?',
      removed: false,
      onlyOpener: false,
    });
    expect(withoutStockOpener('Great question! Rest comes first.', { founderText: distress }).text).toBe(
      'Rest comes first.',
    );
    const flagged = 'Who owns the code my lab partner wrote?';
    const thanks = 'Thanks for being honest. The tech transfer office decides that.';
    expect(withoutStockOpener(thanks, { founderText: flagged, flagged: true }).removed).toBe(false);
    expect(withoutStockOpener(thanks, { founderText: flagged }).removed).toBe(true);
    // The same, written whole and streamed.
    const whole = validateCoachResponse(
      response('I hear you. That is a lot to carry right now.'),
      opts({ founderText: distress }),
    );
    expect(whole.response.answer).toBe('I hear you. That is a lot to carry right now.');
    const flaggedWhole = validateCoachResponse(
      response(thanks),
      opts({ founderText: flagged, preRisk: { categories: ['ip_licensing'] } }),
    );
    expect(flaggedWhole.response.answer.startsWith('Thanks for being honest')).toBe(true);
    for (const chunks of chunkings('I hear you. That is a lot to carry right now.')) {
      expect(shown(run(gate({ founderText: distress }), chunks)).trim()).toBe(
        'I hear you. That is a lot to carry right now.',
      );
    }
    expect(shown(run(gate({ founderText: flagged, keepReferrals: true }), [thanks])).trim()).toBe(thanks);
  });

  it.each(['Will', 'Mark', 'June', 'Grace', 'May', 'Hope', 'Bill'])(
    'never cuts a common word for a founder called %s, typed or spoken',
    (name) => {
      const word = name.toLowerCase();
      const text = `Okay, ${word} you send the deck? Sure, ${word} do. Right, ${word} it work?`;
      expect(withoutVocativeName(text, name)).toEqual({ text, removed: 0 });
      expect(withoutVocativeName(text, name, { spoken: true })).toEqual({ text, removed: 0 });
      // Said to them, the name still goes.
      expect(withoutVocativeName(`Thanks, ${name}. Send it Friday.`, name).text).toBe(
        'Thanks. Send it Friday.',
      );
      expect(withoutVocativeName(`Good luck ${name}!`, name).text).toBe('Good luck!');
    },
  );
});

describe('review of coaching v2: no past of his own, streamed and whole', () => {
  it('leaves a made-up anecdote out of the reply, and cuts "In my experience," keeping the advice', () => {
    const reply =
      'A founder I coached last year did exactly this. In my experience, five calls teach the most.';
    for (const chunks of chunkings(reply)) {
      expect(shown(run(gate({ founderText: 'How many interviews first?' }), chunks)).trim()).toBe(
        'Five calls teach the most.',
      );
    }
    const whole = validateCoachResponse(response(reply), opts({ founderText: 'How many interviews first?' }));
    expect(whole.response.answer).toBe('Five calls teach the most.');
    expect(whole.results.identityViolation).toBe(true);
  });
});
