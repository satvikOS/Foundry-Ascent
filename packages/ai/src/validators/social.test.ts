import { describe, expect, it } from 'vitest';

import { directChoiceOf, socialTurnOf } from '../prompts/conversation-state.js';
import {
  CLOSING_FALLBACK,
  SPOKEN_HAND_BACKS,
  STRESSED_HAND_BACK,
  STRESSED_HAND_BACKS,
  asksAgain,
  asksForTheQuestion,
  asksToRepeat,
  NEWS_FALLBACK,
  endsWithHandBack,
  parksTheirNews,
  questionsAskedIn,
  questionsOf,
  reasksQuestion,
  spokenHandBackFor,
  withoutAgendaPush,
  withinSocialBudget,
  withoutRepeats,
} from './social.js';

describe('social turns (SM-19, social_turn_report)', () => {
  it('reads thanks, a wrap-up and a hello with nothing asked or told', () => {
    expect(socialTurnOf('Thank you, this is genuinely helpful')).toBe('thanks');
    expect(socialTurnOf('thanks!')).toBe('thanks');
    expect(socialTurnOf("Okay, thanks, that's helpful. Talk soon.")).toBe('closing');
    expect(socialTurnOf('I have to run, talk soon.')).toBe('closing');
    expect(socialTurnOf('Hi!')).toBe('greeting');
    // Something asked or told is no social turn.
    expect(socialTurnOf('Thanks! Should we price per library or per seat?')).toBeNull();
    expect(socialTurnOf("Thanks, we've decided to price per library for the pilot.")).toBeNull();
    expect(socialTurnOf('How should we price the pilot?')).toBeNull();
  });

  it('reads more social forms, a name said to them included', () => {
    for (const [text, kind] of [
      ['Thanks so much, Corin!', 'thanks'],
      ['Thank you for your help!', 'thanks'],
      ['Thanks, that makes sense.', 'thanks'],
      ['Appreciate it, really helpful.', 'thanks'],
      ['Cheers, this was super useful 🙏', 'thanks'],
      ['Okay, bye!', 'closing'],
      ["Great, I'll let you go. Have a good one!", 'closing'],
      ['Gotta run, thanks!', 'closing'],
      ["Thanks, I'll do that.", 'thanks'],
      // The matrix's wrap-ups (MX-P01, MX-0002, MX-0005, MX-0011, MX-0016, MX-0021, MX-0022).
      ["Cool, I've got to run. Thanks!", 'closing'],
      ['Cool, I have got to run. Thanks!', 'closing'],
      ["ngl cool, i've got to run. thanks! fr", 'closing'],
      ['okay, that helps. talk soon! no cap', 'closing'],
      ["I feel a lot better about this now. Alright, that's enough for today. Bye", 'closing'],
      ["phew. that takes some pressure off. alright, that's enough for today. bye! tbh", 'closing'],
      ['Phew. That takes some pressure off. that helps. Talk soon', 'closing'],
      ["Thanks, I'll let you know how it goes!", 'thanks'],
      ['Hey Corin, good morning!', 'greeting'],
      ["Hi, how's it going?", 'greeting'],
    ] as const) {
      expect(socialTurnOf(text), text).toBe(kind);
    }
  });

  it('news or a decision said with thanks or a goodbye is never a social turn', () => {
    for (const text of [
      'Thanks! We signed Hartwell.',
      'Thanks, we are hiring Noor.',
      'Thanks, my cofounder left.',
      'Thanks — we lost the pilot.',
      "Okay, we'll go with $900. Talk soon.",
      "Great, we'll price per library. Bye!",
      'Thanks, the dean said yes.',
      'Bye! Sending the contract tonight.',
      "Talk soon, I'll send the deck tomorrow.",
      'Hi! Hartwell signed the letter of intent.',
    ]) {
      expect(socialTurnOf(text), text).toBeNull();
    }
  });

  it('keeps a thanks reply to a short warm line, never the plan again', () => {
    const sm19 =
      "You're welcome. Let's keep moving. First, call the dean about the budget. Then book the second library for Tuesday and send both of them the one-page plan.";
    expect(withinSocialBudget(sm19, 'thanks')).toBe("You're welcome. Let's keep moving.");
    expect(withinSocialBudget('Glad it helped.', 'thanks')).toBe('Glad it helped.');
  });

  it('a wrap-up asks nothing new and stays short', () => {
    expect(withinSocialBudget('Good talking with you. What will you do first? Talk soon.', 'closing')).toBe(
      'Good talking with you. Talk soon.',
    );
    expect(withinSocialBudget('Anything else before you go?', 'closing')).toBe(CLOSING_FALLBACK);
  });
});

describe('never the previous reply again (repeated_reply, LAB-M3, LAB-M10)', () => {
  const previous =
    "Ask three students what they'd give up to skip the group chat and the walking. That's the price signal you need before the pilot.";

  it('leaves out the sentences that repeat the previous reply, keeps the new ones', () => {
    const again = `Ask three students what they'd give up to skip the group chat and the walking. With five yeses, run the two-library pilot in November.`;
    expect(withoutRepeats(again, previous)).toEqual({
      text: 'With five yeses, run the two-library pilot in November.',
      dropped: 1,
    });
    expect(withoutRepeats(previous, previous)).toEqual({ text: '', dropped: 2 });
    // A short acknowledgement repeats safely.
    expect(withoutRepeats('Got it. Fair point.', 'Got it. Fair point.').dropped).toBe(0);
  });

  it('a founder who asks to hear it again may', () => {
    for (const text of [
      'Can you repeat that?',
      'Sorry, what was the first step?',
      'Say that again?',
      // A recall or "where were we?" names it again on purpose.
      'Do you remember what we talked about last time?',
      'Where were we?',
    ]) {
      expect(asksToRepeat(text), text).toBe(true);
    }
    expect(asksToRepeat('What should we repeat in the second pilot?')).toBe(false);
  });
});

describe('a spoken reply hands the turn back (spoken_no_handback)', () => {
  it('knows a reply that hands back: a question, or an invitation', () => {
    expect(endsWithHandBack('Price per library. Does Friday work?')).toBe(true);
    expect(endsWithHandBack('Price per library. Tell me how that sits with you.')).toBe(true);
    expect(endsWithHandBack('Set that up by Friday and talk about it after.')).toBe(false);
  });

  it('none for a social turn; a question about what would help for someone stressed', () => {
    expect(spokenHandBackFor("Okay, thanks, that's helpful. Talk soon.", 't1')).toBeNull();
    expect(spokenHandBackFor("I'm so stressed, nothing is working this week.", 't1')).toBe(
      STRESSED_HAND_BACK,
    );
    expect(SPOKEN_HAND_BACKS).toContain(spokenHandBackFor('How do we get the first ten users?', 't1'));
  });

  it('never hands back with a line the conversation already heard: four statement-ending call turns, four lines', () => {
    for (const [founder, pool] of [
      ['How do we get the first ten users?', SPOKEN_HAND_BACKS],
      ["I'm so stressed, nothing is working this week.", STRESSED_HAND_BACKS],
    ] as const) {
      const answers: string[] = [];
      const said: string[] = [];
      for (let turn = 0; turn < 4; turn += 1) {
        // The same seed every turn: only what was heard can change the line.
        const line = spokenHandBackFor(founder, 'same-turn-id', answers);
        expect(line).not.toBeNull();
        expect(pool as readonly string[]).toContain(line);
        said.push(line ?? '');
        answers.push(`Start with the two libraries that already count seats. ${line ?? ''}`);
      }
      expect(new Set(said).size).toBe(4);
    }
    // Short enough that a call's spoken budget always keeps room for one.
    for (const line of SPOKEN_HAND_BACKS) expect(line.split(/\s+/).length).toBeLessThanOrEqual(4);
    // Once every line was said, none rather than a repeat.
    expect(spokenHandBackFor('How do we get users?', 't', [SPOKEN_HAND_BACKS.join(' ')])).toBeNull();
  });
});

describe('a direct question is answered first (LAB-V3)', () => {
  it('reads a request to choose or give a view', () => {
    for (const text of [
      'Should we charge per branch or a flat campus fee?',
      'Per branch or flat fee?',
      'Just decide for me, per seat or per library?',
      'Which one would you pick?',
      "What's your honest take, should we hire now?",
    ]) {
      expect(directChoiceOf(text), text).toBe(true);
    }
    for (const text of [
      'We interviewed twelve librarians this week.',
      'How do we get the first ten users?',
    ]) {
      expect(directChoiceOf(text), text).toBe(false);
    }
  });
});

describe('the founder’s news is never parked for the vEIR’s agenda (LAB-R8)', () => {
  it('reads the lab’s deflections, and nothing else', () => {
    for (const sentence of [
      "Before we talk about that, let's finish the core seat-finding test: what did you learn from the five library staff interviews?",
      "One thing at a time — let's finish the student union question first, then we'll talk about Noor.",
      "Before you take that on, let's make sure core demand is solid.",
      "One thing at a time: before we talk about Noor, let's finish the core seat-finding test.",
      "Great. Before we get to that, let's wrap up pricing.",
      "Let's finish the student union question first.",
    ]) {
      expect(parksTheirNews(sentence), sentence).toBe(true);
    }
    for (const sentence of [
      'Before you sign, check the SSO clause.',
      'Congrats on Hartwell, that is a big step.',
      "Let's figure out what Noor works on first.",
      'What will Noor take on first?',
    ]) {
      expect(parksTheirNews(sentence), sentence).toBe(false);
    }
  });

  it('leaves the deflection out and keeps the rest; nothing else said is a short line about the news', () => {
    expect(
      withoutAgendaPush(
        "Congrats on bringing Noor in! One thing at a time — let's finish the student union question first, then we'll talk about Noor. What will Noor work on first?",
      ),
    ).toEqual({ text: 'Congrats on bringing Noor in! What will Noor work on first?', dropped: 1 });
    expect(withoutAgendaPush("Before we talk about that, let's finish the interviews first.").text).toBe('');
    expect(NEWS_FALLBACK).toMatch(/\?$/);
  });
});

describe('a question is never asked again in the next reply, in other words (item 20)', () => {
  const previous =
    "That's a real step. Do you have a written agreement on what success looks like and what happens if the pilot doesn't hit it?";

  it('reads the lab’s re-asked question, and leaves a follow-up that builds on it', () => {
    const asked = questionsOf(previous);
    expect(
      reasksQuestion('Is there a written success agreement, and what happens if the pilot misses?', asked),
    ).toBe(true);
    expect(reasksQuestion('Who signs the agreement on their side?', asked)).toBe(false);
    expect(reasksQuestion('A written agreement on success is still the thing to get.', asked)).toBe(false);
  });

  it('leaves the re-asked question out of a reply to the founder’s worry, and keeps the rest', () => {
    const reply =
      "That's a real risk: SSO can stall a library pilot for months. Is there a written success agreement, and what happens if the pilot misses? Ask their IT lead now what SSO they need.";
    expect(withoutRepeats(reply, previous)).toEqual({
      text: "That's a real risk: SSO can stall a library pilot for months. Ask their IT lead now what SSO they need.",
      dropped: 1,
    });
  });
});

describe('a question an earlier message asked is never asked again (voice suite: one question in five replies)', () => {
  const asked = questionsAskedIn([
    'Good start. Who signs off on that budget at each branch?',
    null,
    'That is a real signal. Get her to name a date for a trial.',
    'Nice. What price would the east library pay per term?',
  ]);

  it('reads the questions of every earlier message, not their statements', () => {
    expect(asked).toHaveLength(2);
  });

  it('the same question, articles and fillers aside, is asked again', () => {
    expect(asksAgain('Who signs off on that budget at each branch?', asked)).toBe(true);
    expect(asksAgain('So who signs off on the budget at each branch?', asked)).toBe(true);
    expect(asksAgain('What price would the east library pay per term?', asked)).toBe(true);
  });

  it('a question that differs by one word asks something else (differential audit, 2026-10-22)', () => {
    for (const question of [
      'What price would the west library pay per term?',
      'What price would the east library pay per year?',
      'Who signs off on that budget at the west branch?',
      'Who signs off on that budget at each branch this term?',
      'Who signed off on that budget at each branch?',
      'What price would the east library pay per term for sensors?',
    ]) {
      expect(asksAgain(question, asked), question).toBe(false);
    }
    const timing = questionsAskedIn([
      'How full is the main library before finals?',
      'How many students used the map in the first week?',
      'When does the Harbour Hall pilot start?',
    ]);
    for (const question of [
      'How full is the main library during finals?',
      'How many students used the map in the second week?',
      'When does the Harbour Hall pilot end?',
    ]) {
      expect(asksAgain(question, timing), question).toBe(false);
    }
  });

  it('the same words in another order ask something else (differential audit R5, 2026-10-22)', () => {
    const report = questionsAskedIn(['Good. Who at the library will you report to each week?']);
    expect(asksAgain('Who at the library will report to you each week?', report)).toBe(false);
    expect(asksAgain('So who at the library will you report to each week?', report)).toBe(true);
  });

  it('only questions count, and short ones never do', () => {
    expect(asksAgain('Who signs off on that budget at each branch.', asked)).toBe(false);
    expect(questionsAskedIn(['Why?', 'And then?', 'What now?'])).toEqual([]);
    expect(asksAgain('So who then?', questionsAskedIn(['So who then?']))).toBe(false);
  });
});

describe('the founder asks to hear the question again, or did not catch it (differential audit R2, 2026-10-22)', () => {
  it('in the ways a bad line makes people ask', () => {
    for (const text of [
      'sorry, what was the question?',
      'you broke up, what did you ask?',
      'huh?',
      'what was your question again',
      'can you repeat the question',
      'repeat the question please',
      'wait what did you ask me',
      'can you ask me that again',
      'sorry you cut out, what was the question?',
      'what did you ask?',
      'hang on, ask me that again',
      'pardon? what was your question',
      'say the question again pls',
      'remind me of your question',
      'sorry I was distracted, ask again?',
      'sorry what?',
      'i missed what you asked, say it again?',
      'remind me what you asked earlier',
      'Sorry, can you say that again?',
      'sorry, I lost you for a second',
      'the call froze, what was that?',
      'hello?',
    ]) {
      expect(asksForTheQuestion(text), text).toBe(true);
    }
  });

  it('never for an ordinary message', () => {
    for (const text of [
      'what next?',
      'the west library emailed back too!',
      "We've got two weeks before exams start.",
      'the DPO is called Hannah',
      'ok what else should i be thinking about',
      'Sam said yes to the weekly update!',
      'She said the trial can start in November.',
      'what do you mean by unit economics?',
      'I missed that meeting with the dean, what now?',
      'we cut out the second tier of pricing',
    ]) {
      expect(asksForTheQuestion(text), text).toBe(false);
    }
  });
});
