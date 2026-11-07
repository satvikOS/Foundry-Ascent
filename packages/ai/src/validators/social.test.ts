import { describe, expect, it } from 'vitest';

import { directChoiceOf, socialTurnOf } from '../prompts/conversation-state.js';
import {
  CLOSING_FALLBACK,
  askedBefore,
  asksToRepeat,
  NEWS_FALLBACK,
  parksTheirNews,
  questionsOf,
  asksOnly,
  reasksQuestion,
  stuckOn,
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
    expect(withoutRepeats(again, previous)).toMatchObject({
      text: 'With five yeses, run the two-library pilot in November.',
      dropped: 1,
    });
    expect(withoutRepeats(previous, previous)).toMatchObject({ text: '', dropped: 2 });
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
    expect(withoutRepeats(reply, previous)).toMatchObject({
      text: "That's a real risk: SSO can stall a library pilot for months. Ask their IT lead now what SSO they need.",
      dropped: 1,
    });
  });
});

describe('the same question two replies later, longer and reworded (production, 2026-11-07)', () => {
  // Synthetic wording, the call's shape: the first reply asked what the advisor said of the device class and payment;
  // after a vague answer and a short one, the third reply asked it again, longer, about the same advisor and class.
  const first =
    'Got it. Walk me through where you are with the regulatory route and reimbursement: what did the advisor session tell you about the device class and how clinics would pay?';
  const second = 'So there is a process, not a quick yes. Who sits in those approval layers?';
  const asked = [...questionsOf(first), ...questionsOf(second)];

  it('reads the reworded question as asked again', () => {
    expect(
      reasksQuestion(
        'But here is what matters: did the advisor actually say which device class the insole falls into, and whether monitoring time is reimbursable under existing codes?',
        asked,
      ),
    ).toBe(true);
  });

  it('keeps a question that builds on the subject without asking it again', () => {
    expect(reasksQuestion('Want me to draft the questions for your next advisor call?', asked)).toBe(false);
    expect(reasksQuestion('Which of the department heads controls the budget?', asked)).toBe(false);
  });

  it('after "I don\'t know", any question back on the same subject is asked again', () => {
    expect(stuckOn("I don't know.")).toBe(true);
    expect(stuckOn("I didn't do that.")).toBe(true);
    expect(stuckOn('you tell me')).toBe(true);
    expect(stuckOn('Department heads, mostly.')).toBe(false);
    const short = 'Did the advisor mention the class at all?';
    expect(reasksQuestion(short, asked)).toBe(false);
    expect(reasksQuestion(short, asked, { strict: true })).toBe(true);
    expect(
      reasksQuestion('Want me to draft the questions for your next advisor call?', asked, { strict: true }),
    ).toBe(false);
  });

  it('reads the same subject in other words: classification is the class, billing and payment are how they pay', () => {
    for (const reworded of [
      'So what did your advisor say about classification and payment?',
      'Has anyone told you what classification the insole gets and which billing code clinics would use?',
    ]) {
      expect(reasksQuestion(reworded, questionsOf(first), { strict: true }), reworded).toBe(true);
    }
    expect(reasksQuestion('So what did your advisor say about classification and payment?', asked)).toBe(
      true,
    );
  });

  it('reads a question from before the previous reply strictly: the founder has had their turn to answer it', () => {
    // After a vague answer and a short one (no "I don't know"), the first reply's question in other words.
    const before = askedBefore(second, [first]);
    expect(before.filter((q) => q.settled === true)).toHaveLength(1);
    expect(reasksQuestion('Did the advisor mention the class at all?', before)).toBe(true);
    expect(
      reasksQuestion(
        'Has anyone told you what classification the insole gets and which billing code clinics would use?',
        before,
      ),
    ).toBe(true);
    // A question on another subject, or one that builds on the answer, is still asked.
    expect(reasksQuestion('Which of the department heads controls the budget?', before)).toBe(false);
    expect(reasksQuestion('Want me to draft the questions for your next advisor call?', before)).toBe(false);
  });

  it('leaves the question out of the reply and keeps the teaching around it', () => {
    const reply =
      'That is normal at this stage. Did the advisor actually say which device class the insole falls into, and whether monitoring time is reimbursable under existing codes? Most foot-pressure monitors sit in a low-risk class, so the route is usually lighter.';
    const out = withoutRepeats(reply, `${first}\n\n${second}`, { strictQuestions: true });
    expect(out.dropped).toBe(1);
    expect(out.text).toBe(
      'That is normal at this stage. Most foot-pressure monitors sit in a low-risk class, so the route is usually lighter.',
    );
  });
});

describe('a reply that only asks (production, 2026-11-07)', () => {
  it('reads a reply of questions alone, and one with substance or a role-play line as more', () => {
    expect(
      asksOnly('So there is a process. Who sits in those layers, and what does each one sign off on?'),
    ).toBe(true);
    expect(asksOnly('Got it. What did the advisor tell you?')).toBe(true);
    expect(
      asksOnly(
        'Most clinics route a new device through a purchasing committee that meets monthly. I can draft your one-page case. Want that?',
      ),
    ).toBe(false);
    expect(asksOnly('**Investor:** What does a clinic pay you today?')).toBe(false);
    // A lead-in that only says the founder's answer back is no substance, however long.
    expect(
      asksOnly(
        "That's something—so there's a process, not a quick yes. Who are the people in those layers, and what does each one sign off on?",
      ),
    ).toBe(true);
    expect(
      asksOnly(
        'Okay, so department heads need to approve it... But here is what I need to know: did the advisor say which class the insole falls into?',
      ),
    ).toBe(true);
    expect(
      asksOnly(
        'So the usual route for a low-risk monitor is a lighter clearance, and clinics bill the monitoring time separately. Want the checklist?',
      ),
    ).toBe(false);
    expect(asksOnly('Here is the plan for this week.')).toBe(false);
  });
});
