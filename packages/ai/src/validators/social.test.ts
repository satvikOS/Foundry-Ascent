import { describe, expect, it } from 'vitest';

import { directChoiceOf, socialTurnOf } from '../prompts/conversation-state.js';
import {
  CLOSING_FALLBACK,
  SPOKEN_HAND_BACKS,
  STRESSED_HAND_BACK,
  asksToRepeat,
  endsWithHandBack,
  spokenHandBackFor,
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
    for (const text of ['Can you repeat that?', 'Sorry, what was the first step?', 'Say that again?']) {
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
