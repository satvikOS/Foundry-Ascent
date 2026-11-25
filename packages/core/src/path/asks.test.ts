/** Broad ways to ask and to say the same thing, and near misses that are something else. Synthetic wording. */
import { describe, expect, it } from 'vitest';

import { choiceIn } from './choice.js';
import {
  asksMessage,
  asksOverview,
  asksRecall,
  asksWhenDone,
  isHardship,
  isSocial,
  ownWords,
  pivotOf,
  reportOf,
  saysFirstTime,
  timeSaid,
} from './kinds.js';

describe('a change of direction', () => {
  it.each<[string, string]>([
    [
      "I'm changing direction. No benches: an app with a quiz a day for grandparents instead.",
      'an app with a quiz a day for grandparents',
    ],
    ["I'm pivoting. No more candles, I'll rent lamps with a timer instead.", "I'll rent lamps with a timer"],
    ['We are pivoting to florists who pay for cold delivery.', 'florists who pay for cold delivery'],
    ["We're going in a different direction: kits for rowing clubs.", 'kits for rowing clubs'],
    [
      'New direction: repair kits for sailing clubs instead of lessons.',
      'repair kits for sailing clubs instead of lessons',
    ],
    ['We switched to selling refill pouches to salons.', 'selling refill pouches to salons'],
    ["I'm ditching the candles for a soap subscription.", 'a soap subscription'],
    [
      'We are dropping the student app and building a tool for salon owners.',
      'building a tool for salon owners',
    ],
    ['No more mugs: tote bags printed by campus artists instead.', 'tote bags printed by campus artists'],
    ['From now on we rent amps to schools.', 'we rent amps to schools'],
    ['We are now building a tracker for school kitchens.', 'building a tracker for school kitchens'],
    ["I've decided to pivot to dorm laundry pickup.", 'dorm laundry pickup'],
    ['We changed our idea to evening tutoring for nurses.', 'evening tutoring for nurses'],
    ['We changed the product to a thermos with a sensor.', 'a thermos with a sensor'],
    ['Pivoting to wedding photographers who need editing.', 'wedding photographers who need editing'],
    ['We agreed to pivot to a paid newsletter for lab managers.', 'a paid newsletter for lab managers'],
    ['I am abandoning the bike shop and starting a repair van.', 'a repair van'],
    ['We are moving away from students to selling to hotels.', 'selling to hotels'],
    ['We scrapped the app and now sell paper planners.', 'sell paper planners'],
    ['Pivot: cargo bikes for florists.', 'cargo bikes for florists'],
    ['We are shifting our focus to clinics that lose patients.', 'clinics that lose patients'],
    ["I'm giving up on the market stall and doing home delivery of plants.", 'home delivery of plants'],
    ['Change of direction: printed guides for hikers.', 'printed guides for hikers'],
    [
      'We are heading in a new direction. We will sell bread to cafes instead.',
      'We will sell bread to cafes instead',
    ],
    ['We switched direction. It is a key tracker for labs now.', 'It is a key tracker for labs now'],
    ['We pivoted to carts that sell soup at tram stops.', 'carts that sell soup at tram stops'],
    ['So, we decided to pivot to mending tents for outdoor clubs.', 'mending tents for outdoor clubs'],
    ['My team agreed to pivot to night shuttles for nurses.', 'night shuttles for nurses'],
    ['I am switching to renting cameras to film students.', 'renting cameras to film students'],
    ['We are no longer sure of it. We pivot to meal kits for rowers.', 'meal kits for rowers'],
  ])('%s', (message, idea) => {
    expect(pivotOf(message)).toMatchObject({ idea, back: null });
  });

  it.each<[string, 'first' | 'last' | 'named']>([
    ["I'm going back to the first idea.", 'first'],
    ["I'm going back to the reading benches. A school lends us its hall, so space is solved.", 'named'],
    ['We are back to the original idea.', 'first'],
    ["We're returning to the lunch boxes.", 'named'],
    ["I'm switching back to the candles.", 'named'],
    ['We went back to our old idea.', 'last'],
    ['Undo the pivot.', 'last'],
    ['The pivot was a mistake, we are going back.', 'last'],
    ['Back to the thermos jars.', 'named'],
    ['I have decided to go back to what we had first.', 'first'],
    ['Never mind the pivot, we keep the benches.', 'last'],
    ['We are reverting to the previous idea.', 'last'],
    ['Let us go back to the first plan.', 'first'],
    ["I'm moving back to renting kayaks.", 'named'],
  ])('back: %s', (message, back) => {
    expect(pivotOf(message)?.back).toBe(back);
  });

  it.each([
    'Should we pivot to florists?',
    'We chose to pivot a week ago. Remember the plan and say what is different.',
    'I moved to Rochester last year',
    'We pivoted, what do we do now',
    'Maybe we are pivoting',
    "I'm thinking of changing direction.",
    'We are not changing direction.',
    "I'm switching from email to calls.",
    "Change of plans: I'll email only two.",
    'I changed my major to chemistry.',
    "Let's get back to work.",
    'Okay back to it. What do I do about the porters?',
    "I'm going back to Boston on Friday.",
    'Going back to the first step, how do I write it?',
    'I went back to the customers and asked again.',
    'Can we go back to pricing?',
    'I dropped my phone and it broke.',
    "I'm dropping out of the class to focus on this.",
    'We are moving on to the next step.',
    'We are moving to a bigger kitchen.',
    'I changed the price to 450.',
    'I switched to a new laptop.',
    'We switched teams.',
    'What happens if we change direction?',
    'If nobody pays we pivot.',
    'I stopped selling on Sundays.',
    "I'm going to the library.",
    'No time this week, sorry.',
    "No, I didn't do it.",
    "I have no more questions, I'll email them instead.",
    "I'm going with the second option.",
    'I left the meeting and called them.',
    "I'm changing the landing page.",
    'The customer changed direction.',
    'We are leaving on Friday for break.',
  ])('%s changes nothing', (message) => {
    expect(pivotOf(message)).toBeNull();
  });

  it('a "no" before a thing is no missed commitment', () => {
    expect(reportOf('No benches: an app for grandparents instead.')).toBeNull();
    for (const message of ['No, I did not get to it.', 'Nope.', 'No time this week.'])
      expect(reportOf(message)?.state, message).toBe('not_yet');
  });
});

describe('what is on record, asked for', () => {
  it.each([
    // The story.
    'Tell me the whole story so far, in order, and why we are where we are.',
    'Give me the full story.',
    'Walk me through our story so far',
    'How did we get here?',
    'how did we end up here',
    'Remind me how we got here, from the start.',
    'Why are we where we are?',
    'Recap everything we did so far',
    'give me a recap',
    'Can you give me a quick recap?',
    'What have we done so far?',
    'What has happened so far?',
    'Take me through the history of this',
    'Show me our timeline',
    'What did we try and what did we learn? Give me the journey.',
    'recap please',
    // Which idea.
    'Which of the two ideas are we on now, and what is my step?',
    'Which idea are we on?',
    'What idea are we working on right now?',
    'Are we still on the app?',
    'Which version are we building?',
    'What is our current idea?',
    'what are we building now',
    'Which of my three ideas are we on?',
    'What direction are we on?',
    'Which one are we doing?',
    // What it has and has not.
    'Remind me what BenchFox has and what it has not.',
    'What does BenchFox have and what does it lack? Remind me what we have.',
    'What have we proven so far?',
    'What do we know for sure?',
    'what is still missing',
    "What's missing?",
    'What are we still missing?',
    'What have I shown so far?',
    'What is the status of my venture?',
    'Where does my venture stand?',
    'What do we have so far?',
    'What is left to prove?',
    'what has BenchFox proven so far?',
  ])('%s', (message) => {
    expect(asksRecall(message)).toBe(true);
  });

  it.each([
    'Tell me a story about a founder who failed',
    'Which idea should I pick?',
    'Which of the two should I spend this week on?',
    'What should my pitch story be?',
    'How do I tell my story to investors?',
    'What is missing from my pitch deck slides?',
    'What do customers have to pay?',
    'What have customers to do with price?',
    'What does a lawyer have to check?',
    'What do I need to prove to an investor?',
    'How do I get to ten customers?',
    'Where should I stand at the fair?',
    'Is my status as a student a problem?',
    'What do I do next?',
    'What are we going to sell at the fair?',
    'Should we still build the app?',
    'Which version should I build first?',
    'Write the history of our company for the about page',
    'What did the customer say no to?',
    'What has the best margin?',
  ])('%s asks for something else', (message) => {
    expect(asksRecall(message)).toBe(false);
  });
});

describe('what to do, in few words', () => {
  it.each([
    'ok boss. orders pls',
    'orders please',
    'just tell me what to do',
    'tell me exactly what to do next',
    'what would u do if u were me rn',
    'What would you do in my place?',
    'What would you do first if this was yours?',
    'give me one thing to do',
    'Give me one thing to do before Monday that a chemist can do.',
    'Fine. One thing, what would it be?',
    'What should I be doing this week?',
    'what do i do tomorrow morning',
    'Please you tell me what I do tomorrow morning, small thing.',
    'idk what to do',
    'what now',
    'whats next',
    'where do i even begin',
    'What is my step?',
    'what are my steps this week',
    'Fine, and the least dumb?',
    'What is the smartest thing I can do now?',
    'what is the one thing I should do',
    'name me one thing to do',
    'give me my marching orders',
    'What should I focus on?',
    'where do we start',
    'I need a plan',
    'Okay, back to work.',
    'get me organised',
    'What do we do this week?',
    'tell me what i must do',
  ])('%s', (message) => {
    expect(asksOverview(message)).toBe(true);
  });

  it.each([
    'Okay back to it. What do I do about the porters?',
    'What would you do about the price?',
    'I have three orders from a bakery',
    'What do I do with what the teachers told me?',
    'What do I do if they say no?',
    'What would I do first for that?',
    'Give me one example of a pitch',
    'Tell me what a canvas is',
    'What is the smartest way to price it?',
    'How many orders do I need?',
    'They sent us their orders by email',
    'What would a customer do?',
  ])('%s is another ask', (message) => {
    expect(asksOverview(message)).toBe(false);
  });
});

describe('when it is enough, and the message to send', () => {
  it.each([
    "How will I know I've done enough?",
    'How do I know when I am done?',
    'when is it done?',
    'When am I done?',
    'How do I know it worked?',
    'What counts as done?',
    'what does done look like',
    'How much is enough?',
    'How do I know that is enough?',
  ])('%s', (message) => {
    expect(asksWhenDone(message)).toBe(true);
  });
  it.each(['How do I know if they like it?', 'When is the fair?', 'Is that good?', 'Are we done talking?'])(
    '%s is not',
    (message) => {
      expect(asksWhenDone(message)).toBe(false);
    },
  );

  it.each([
    'Can you write the message I should send them?',
    'Draft an email to the clubs',
    'write me a short text I can send',
    'What should I write to them?',
    'give me the exact message',
    'what do I say to them',
  ])('%s asks for the message', (message) => {
    expect(asksMessage(message)).toBe(true);
  });
  it.each(['I wrote the message', 'They sent a message', 'Is email better than a call?', 'Write my pitch'])(
    '%s does not',
    (message) => {
      expect(asksMessage(message)).toBe(false);
    },
  );
});

describe('who is told what stands on their path', () => {
  it.each([
    'You have no idea what you are talking about.',
    'this is useless',
    'hmm',
    'interesting',
    'right',
    'nah',
  ])('%s is no social turn', (message) => {
    expect(isSocial(message, 'Send it on Friday.')).toBe(false);
  });
  it.each(['ok', 'thanks!', 'got it', 'bye', 'cool', 'have a good weekend', 'hi'])('%s is', (message) => {
    expect(isSocial(message, 'Send it on Friday.')).toBe(true);
  });
  it('anger at the work is none of the hardships that get a person first', () => {
    for (const message of ['ugh', 'I hate this', 'I am sick of this', 'nothing works'])
      expect(isHardship(message), message).toBe(false);
    for (const message of [
      'My grandma is in the hospital',
      'I miss home',
      'ugh my roommate is driving me crazy',
    ])
      expect(isHardship(message), message).toBe(true);
  });
});

describe('who is new, what time they have, and what is only pasted', () => {
  it.each([
    "I don't know the business side at all.",
    'First company for me.',
    'I have zero business background.',
    "I'm new to business and I don't understand the money side.",
    'I am clueless about business',
  ])('%s', (message) => {
    expect(saysFirstTime(message)).toBe(true);
  });

  it('the time they say they have', () => {
    expect(timeSaid('I only have four hours a week for this.')).toEqual({
      minutes: 240,
      said: 'four hours a week',
    });
    expect(timeSaid("I've got my two hours back.")).toEqual({ minutes: 120, said: 'two hours' });
    expect(timeSaid('It takes two hours by bus')).toBeNull();
  });

  it('a pasted text reports nothing', () => {
    const pasted = `Here is the paragraph from my application, tell me what is wrong with it: ${'PierBot is a platform that helps harbours. '.repeat(5)}Three of the nine harbours have paid.`;
    expect(ownWords(pasted)).not.toContain('paid');
    expect(ownWords('Here is the plan: three of the nine paid.')).toContain('paid');
  });
});

describe('a choice they ask to have made', () => {
  const of = (message: string, told: string[] = [], earlier: string[] = []) =>
    choiceIn({ message, earlier, told });

  it.each<[string, string[]]>([
    ['One word. East or west?', ['east', 'west']],
    ['Should I sell this to the museum or to visitors?', ['museum', 'visitors']],
    ['Grants, angels or VC?', ['grants', 'angels', 'vc']],
  ])('%s', (message, options) => {
    const choice = of(message);
    expect(choice?.kind).toBe('either');
    expect(choice?.options.map((o) => o.toLowerCase().replace(/^(?:this to |to )?(?:the )?/, ''))).toEqual(
      options,
    );
  });

  it.each([
    'Could my cousin do that part?',
    'Is a pilot the same as a sale?',
    'Do I raise the price to 40? Yes or no.',
    'Is that really worth my two free hours this week?',
    'Should I drop the class?',
    'Can a friend run the stand?',
    'Are students the right group?',
  ])('%s is a yes or a no', (message) => {
    expect(of(message)).toMatchObject({ kind: 'yes_no', options: ['yes', 'no'] });
  });

  it.each([
    'Can you help me price it?',
    'Could you write it?',
    'What should I charge?',
    'Would you look at this?',
    'I could do that part.',
    'How do I do that?',
    'Should I incorporate or not?',
  ])('%s is none', (message) => {
    expect(of(message)?.kind ?? 'none').not.toBe('either');
    if (!message.startsWith('Should')) expect(of(message)).toBeNull();
  });

  it('"which of the two" takes its options from what they just listed', () => {
    expect(
      of('Which one should I do first?', [], ['I could do posters, radio or talk to coaches.']),
    ).toMatchObject({ kind: 'which', options: ['posters', 'radio', 'talk to coaches'] });
    expect(of('Which of the two should I spend this week on?')).toMatchObject({ kind: 'which', options: [] });
  });

  it('is decided by the record only when the record plainly decides', () => {
    const told = ['In the east market six of 20 stalls ordered; in the west market eleven of 60 did.'];
    expect(of('One word. East or west?', told)?.pick).toMatchObject({
      option: 'East',
      text: 'East: 6 of 20 (30%), against 11 of 60 (18%) for the other. Go by the share, not by the bigger number.',
    });
    // Too close, too few asked, or one of them never told: the reply picks, and says why.
    for (const other of [
      'In the east market six of 20 stalls ordered; in the west market seventeen of 60 did.',
      'In the east market two of 4 stalls ordered; in the west market one of 5 did.',
      'In the east market six of 20 stalls ordered.',
      'We like the east market.',
    ])
      expect(of('One word. East or west?', [other])?.pick, other).toBeNull();
  });

  it('which channel: the one most of the sales came through', () => {
    const choice = of(
      'Which channel do I start with, of these?',
      ['Nine of the 12 kits sold last month came from two coaches; posters brought none.'],
      ['I could do posters, radio or talk to coaches.'],
    );
    expect(choice?.pick?.text).toMatch(/^Talk to coaches first: 9 of 12 \(75%\) came that way\./);
  });
});
