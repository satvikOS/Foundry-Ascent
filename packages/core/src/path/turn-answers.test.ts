/**
 * The answer fits the ask: either-or and yes-or-no first, both of two things asked, nothing twice, the step that acts on
 * what was picked, a finding read further. Real playbook, synthetic ventures and wording.
 */
import { type ArcEntry } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { hourlyBefore } from './calc.js';
import { ratesOf, settledWay } from './choice.js';
import { decide, guidanceOf, inTheirVoice, type Decision } from './engine.js';
import { withoutStutter } from './heard.js';
import { asksIfNeeded, asksIfNo, asksIfWorth, asksIn, asksMeaning, asksWhatTold, limitsIn } from './kinds.js';
import { newsOf, readFurther, readMeaning } from './news.js';
import { PLAYBOOK } from './playbook/index.js';
import { holdsAnswer, problemIn } from './reading.js';
import { askWhyStep, pickedChannel, wayOf } from './steps.js';
import { concrete, ideaNamed, priorFact, storyLines, type PriorSource } from './tell.js';
import { fresh, input, memory, NO_READS, storedStep, TODAY, VENTURE_ID } from './testing/inputs.js';
import { pathTurn, type PathTurnInput } from './turn.js';
import { type DecideInput } from './engine.js';

const VENTURE = {
  name: 'SailMend',
  stage: 'validation' as const,
  oneLiner: 'Mends sails on the pier in two days.',
  domain: 'services',
  currentGoal: 'Get a first loft to pay.',
};
const path = (over: Partial<pathRepo.PathRecord> = {}): pathRepo.PathRecord => ({
  ventureId: VENTURE_ID,
  stage: 'idea',
  intake: null,
  intakeBy: null,
  pivots: [],
  playbookVersion: 'x',
  version: 1,
  ...over,
});
const real = (over: Partial<DecideInput> = {}): Partial<DecideInput> =>
  fresh({ playbook: PLAYBOOK, venture: VENTURE, ...over });
const at = (message: string, over: Partial<DecideInput> = {}): Decision => decide(input(message, real(over)));
const turnOf = (
  message: string,
  over: Partial<PathTurnInput> = {},
  earlierMessages: string[] = [],
  earlierReplies: string[] = [],
) =>
  pathTurn({
    ...input(
      message,
      real({
        started: earlierReplies.length > 0,
        previousReply: earlierReplies.at(-1) ?? null,
        earlierMessages,
        ...over,
      }),
    ),
    continuity: {},
    earlierMessages,
    earlierReplies,
  });
const leadOf = (...args: Parameters<typeof turnOf>): string => turnOf(...args).prompt.lead?.text ?? '';
const known = (
  content: string,
  type: 'evidence' | 'milestone' | 'fact' | 'decision' | 'relationship' = 'evidence',
) => ({ ...NO_READS, memory: [memory({ type, title: 'What happened', content })] });
const play = (id: string) => {
  const found = PLAYBOOK.plays.find((p) => p.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe('what a message asks', () => {
  it.each([
    ['Am I ready to leave? Where do I go next?', ['Am I ready to leave', 'Where do I go next']],
    [
      'Who is my customer, and where do I find 10 such people this month?',
      ['Who is my customer', 'where do I find 10 such people this month'],
    ],
    ['Is that good, and what now?', ['Is that good', 'what now']],
    ['What share is that and is it enough?', ['What share is that', 'is it enough']],
  ])('%s asks two things', (text, asks) => {
    expect(asksIn(text)).toEqual(asks);
  });
  it.each([
    'How do I find ten people?',
    'Now or later, or not at all?',
    'I sold two, and what they paid was fair.',
    'Who pays and uses it?',
    'Should I do this or not?',
  ])('%s asks one, or none', (text) => {
    expect(asksIn(text)).toEqual([]);
  });

  it('what it sets itself', () => {
    expect(limitsIn('Where do I find 10 such people this month?')).toEqual(['10', 'this month']);
    expect(limitsIn('Give me something I can do in one evening.')).toEqual(['one evening']);
    expect(limitsIn('How can we reach 100 members?')).toEqual(['100']);
    expect(limitsIn('I sold 10 this month.')).toEqual([]);
    expect(limitsIn('How do I charge 10 dollars?')).toEqual([]);
  });

  it.each(['And if they say no?', 'What if nobody answers?', 'so if she refuses?'])('%s: a no', (text) => {
    expect(asksIfNo(text)).toBe(true);
  });
  it.each([
    'Is that really worth my two free hours?',
    'Why would I even bother?',
    "What's the point of that?",
  ])('%s: whether it is worth it', (text) => {
    expect(asksIfWorth(text)).toBe(true);
  });
  it.each(['What is a pilot, and do I need one now?', 'Do I really need that yet?'])(
    '%s: whether it is for now',
    (text) => {
      expect(asksIfNeeded(text)).toBe(true);
    },
  );
  it.each(['What did you tell me to do?', 'what was I supposed to do? what was it i was supposed to do'])(
    '%s: what it was told',
    (text) => {
      expect(asksWhatTold(text)).toBe(true);
    },
  );
  it.each([
    'So what does that mean for what I build?',
    'So what do I build?',
    'What did I learn?',
    'What mean this?',
  ])('%s: what it means', (text) => {
    expect(asksMeaning(text)).toBe(true);
  });
  it.each([
    'If they say no, I leave.',
    'Is it worth 40 dollars to them?',
    'They need it now.',
    'I told them what to do.',
  ])('%s: none of these', (text) => {
    for (const asks of [asksIfNo, asksIfWorth, asksIfNeeded, asksWhatTold, asksMeaning])
      expect(asks(text), asks.name).toBe(false);
  });

  it('a call that heard wood for would', () => {
    expect(withoutStutter('how much wood they pay')).toBe('how much would they pay');
    expect(withoutStutter('we sell wood to carpenters')).toBe('we sell wood to carpenters');
  });
});

describe('two things asked are two things answered', () => {
  it('both are listed, each with what the server adds, and what they set', () => {
    const { prompt } = turnOf('Who is my customer, and where do I find 10 such people this month?');
    expect(prompt.parts?.map((p) => p.ask)).toEqual([
      'Who is my customer',
      'where do I find 10 such people this month',
    ]);
    expect(prompt.parts?.every((p) => p.text.split(' ').length > 4)).toBe(true);
    expect(prompt.limits?.map((l) => l.said)).toEqual(['10', 'this month']);
    expect(prompt.limits?.some((l) => /\b10 talks this month\b/.test(l.text))).toBe(true);
  });
  it('one thing asked has neither', () => {
    const { prompt } = turnOf('Who is my customer?');
    expect([prompt.parts, prompt.limits]).toEqual([undefined, undefined]);
  });
});

describe('asked again, it goes on', () => {
  const ask = 'How do I get my first customers?';
  const answer = play('first-ten-customers').answer;
  it('what the conversation holds is not said again', () => {
    const { prompt } = turnOf('What is the way to land a first customer, then?', {}, [ask], [answer]);
    expect((prompt.more ?? []).length).toBeGreaterThan(1);
    for (const piece of prompt.more ?? []) expect(answer, piece).not.toContain(piece);
  });
  it('a first ask has nothing to go on from', () => {
    expect(turnOf(ask).prompt.more).toBeUndefined();
    expect(
      turnOf(ask, {}, ['How do I price it?'], ['Set it below what they pay today.']).prompt.more,
    ).toBeUndefined();
  });

  it('asked after a statement got the answer, it still opens with what answers it, and with them', () => {
    const told = 'Ines and I start next month and never talked about shares.';
    const { prompt } = turnOf(
      'How do my co-founder and I split the equity?',
      {
        reads: known(
          'Ines joined in May and sews all the sails; she works 20 hours a week on it.',
          'relationship',
        ),
      },
      [told],
      [`${play('equity-split').answer} Ines joined in May and sews all the sails, 20 hours a week.`],
    );
    expect(play('equity-split').answer.startsWith(prompt.more?.[0] ?? '?')).toBe(true);
    expect(prompt.prior?.sentence).toContain('Ines joined in May');
  });

  it('who to see and what to bring, asked for, is the answer however often it was said', () => {
    const own = 'Does the university own my invention?';
    const first = turnOf(own);
    const { prompt } = turnOf(
      'What do I bring to them when I go?',
      { previous: guidanceOf(PLAYBOOK, first.decision) },
      [own],
      [`${play('student-ip').answer} Bring UR Ventures ${play('student-ip').referral?.bring ?? ''}`],
    );
    expect(prompt.more).toBeUndefined();
    expect(prompt.ask?.answer ?? prompt.lead?.text).toMatch(/one-page timeline/);
  });
});

describe('a choice is answered first', () => {
  it('what a person decides: what can be said, and never the ruling', () => {
    const date = 'I show how the stitch works at a fair on December 19.';
    const text = leadOf(
      'Do I file for a patent right now, or hold off?',
      {},
      [date],
      ['Speak about the result.'],
    );
    expect(text).toMatch(/^Do not wait to ask, and do not file on your own\./);
    expect(text).toContain('December 19');
    expect(text).not.toMatch(/\b(?:you should file|file now)\b/i);
    const day = { texts: [], today: TODAY };
    expect(holdsAnswer(play('student-ip'), day)).not.toMatch(/\byou own\b|\bthe University owns it\b/i);
    expect(holdsAnswer(play('find-ten-people'), day)).toBeNull();
  });

  it('not again when it was given, nor on a question that is no choice', () => {
    const date = 'I show how the stitch works at a fair on December 19.';
    const first = leadOf('Do I file for a patent right now, or hold off?', {}, [date], ['x']);
    expect(leadOf('Do I file for a patent right now, or hold off?', {}, [date, 'y'], ['x', first])).not.toBe(
      first,
    );
    expect(leadOf('How does a patent work?')).toBe('');
  });

  it('whether a thing is for now, by their stage', () => {
    const { prompt, decision } = turnOf('What is a value proposition, and do I need one now?');
    expect(prompt.lead?.text).toMatch(/^Not yet\. It belongs to stage 3/);
    expect(decision.step?.view.playId).toBe('idea-on-a-page');
    const there = turnOf('What is a value proposition, and do I need one now?', {
      reads: { ...NO_READS, path: path({ stage: 'validation' }) },
    });
    expect(there.prompt.lead?.text).toMatch(/^Yes, now\./);
  });

  it('whether to leave the Center, and where to go', () => {
    const text = leadOf('Am I ready to move on from the Ain Center, and what comes after it?', {
      reads: known('Fourteen lofts pay 2,100 dollars a month; two left last quarter.', 'milestone'),
    });
    expect(text).toMatch(/^Not yet, by what you have told me\./);
    expect(text).toMatch(/strangers pay/);
    expect(text).toMatch(/Where next: /);
  });
});

describe('the step agrees with the answer', () => {
  const told = 'Fourteen of 20 repairs came from two harbour masters; posters brought six.';
  const ways = 'I could do posters, social posts or talk to harbour masters.';

  it('the way most buyers came is the way the step copies', () => {
    expect(settledWay([ways], [told])).toBe('talk to harbour masters');
    expect(settledWay([ways], ['We sold 20 repairs in May.'])).toBeNull();
    const d = at('Which marketing channel do I work on first?', {
      earlierMessages: [ways],
      reads: known(told),
    });
    expect(d.step?.view.title).toBe('Ask for 10 more orders through harbour masters');
    expect(`${d.step?.view.title ?? ''} ${d.step?.view.doneWhen ?? ''}`).not.toMatch(/three/);
    expect(at('Which marketing channel do I work on first?').step?.view.title).not.toMatch(/10 more orders/);
  });

  it('a way is named by whom it goes through', () => {
    expect(['talk to team captains', 'posting on boards', 'the two shops', 'ads'].map(wayOf)).toEqual([
      'team captains',
      'boards',
      'two shops',
      'ads',
    ]);
    const view = at('Which marketing channel do I work on first?').step?.view;
    if (view === undefined) throw new Error('no step');
    expect(pickedChannel(view, 'Talk to captains.').items[0]?.do).toBe(
      'List 10 more captains like the ones that worked',
    );
  });

  it('one thing after a weak result is to ask the ones it came from', () => {
    const reads = known('I asked 30 skippers and only 3 bought.', 'fact');
    const { prompt, decision } = turnOf(
      'Fine. One thing, what would it be?',
      { reads },
      ['x'],
      ['Some reply.'],
    );
    expect(decision.step?.view.title).toBe(
      'Ask the 3 who said yes why, and five of the 27 who did not what stopped them',
    );
    expect(prompt.lead?.text).toContain('ask the 3 who said yes');
    expect(prompt.orders).toBe(true);
    const good = at('Fine. One thing, what would it be?', {
      reads: known('I asked 30 skippers and 22 bought.', 'fact'),
    });
    expect(good.weak).toBeNull();
    const view = decision.step?.view;
    if (view === undefined) throw new Error('no step');
    expect(askWhyStep({ today: TODAY }, { part: 0, whole: 4 }, view)?.title).toBe(
      'Ask the 4 who did not what stopped them',
    );
    expect(askWhyStep({ today: TODAY }, { part: 4, whole: 4 }, view)).toBeNull();
  });

  it('go on or stop, of what nobody tried, is the first test', () => {
    expect(at('Should I keep going with this or stop?').step?.view.playId).toBe('smallest-test');
    expect(
      at('Should I keep going with this or stop?', {
        reads: known('I asked 30 skippers and only 3 bought.', 'fact'),
      }).step?.view.playId,
    ).toBe('quit-or-continue');
  });

  it.each(['Which slides, in what order?', 'What question will the judges hit me with?'])(
    '%s, on the way to a pitch, keeps the pitch’s step',
    (message) => {
      const first = at('I have a pitch competition, help me prepare');
      const d = at(message, {
        previous: guidanceOf(PLAYBOOK, first),
        started: true,
        previousReply: 'x',
        earlierMessages: ['I have a pitch competition, help me prepare'],
      });
      expect(first.step?.view.playId).toBe('pitch-competition');
      expect(d.play?.id).not.toBe('pitch-competition');
      expect(d.step?.view.playId).toBe('pitch-competition');
    },
  );

  it('a sum has its own play: an hour is pricing, a share lost is retention', () => {
    const reads = known(
      'The founder charges 200 dollars for a repair, which takes about eight hours.',
      'fact',
    );
    expect(at("What's my hourly rate at that?", { reads }).step?.view.playId).toBe('pricing');
    const lost = at('What share of my lofts did I lose in the second month?', {
      reads: known('16 lofts paid in the first month and 4 left in the second.', 'fact'),
    });
    expect(lost.step?.view.playId).toBe('retention');
  });

  it('a price they change is the play of it', () => {
    expect(at('Change it: the fee is 250 now, not 200.').step?.view.playId).toBe('pricing');
    expect(at('Change it: the fair is on Friday now, not Saturday.').step?.view.playId).not.toBe('pricing');
  });

  it('a step recalled after its day has a new one, and says the one it had', () => {
    const late = storedStep({
      playId: 'interview-script',
      criterionId: 'discovery-ten-conversations',
      dueOn: '2026-11-20',
    });
    const reads = { ...NO_READS, path: path({ stage: 'discovery' }), steps: [late] };
    expect(at('What did we decide last time?', { reads }).wasDue).toBe('2026-11-20');
    expect(turnOf('What did we decide last time?', { reads }).prompt.step?.wasDue).toBe('2026-11-20');
    expect(at('What should I do next?', { reads }).wasDue).toBeNull();
  });
});

describe('a finding is read, never told back', () => {
  const found = 'I talked to ten skippers. Seven of them said the wait is the problem, not the price.';

  it('what it means for what they build', () => {
    const lead = leadOf(
      'So what does that mean for what I build?',
      { reads: known(found) },
      [found],
      ['Seven of 10 (70%) said the wait is the problem.'],
    );
    expect(lead).toMatch(/^It changes what comes first/);
    expect(lead).toMatch(/does not show/);
    expect(lead).toContain('SailMend');
  });

  it('what is called too dear and bought holds for now', () => {
    const read = readMeaning('Skippers say it is too expensive but they buy anyway.', {
      customer: null,
      venture: '',
    });
    expect(read?.text).toMatch(/^What they do counts more than what they say/);
    expect(readMeaning('Skippers like it.', { customer: null, venture: '' })).toBeNull();
  });

  it('"is that good?" a moment after it was read says what would be enough', () => {
    const before = ['I offered 20 patches and 11 sold in one day.'];
    const first = leadOf(before[0] ?? '');
    const second = leadOf('Is that good, and what now?', {}, before, [first]);
    expect(second).toMatch(/not enough to decide on yet/);
    expect(second).not.toBe(first);
    expect(readFurther({ part: 11, whole: 20 }, ['My pass line is 10 of 20.']).text).not.toMatch(
      /no number was set/,
    );
  });

  it('friends’ praise is read as praise, when nothing is asked', () => {
    expect(
      newsOf({ message: 'I showed it to my friends and all of them said they would get one.', before: [] }),
    ).toMatchObject({
      kind: 'praise',
      means: expect.stringMatching(/^Your friends like it, and that does not show that it sells/) as string,
    });
    expect(newsOf({ message: 'My family loves the idea.', before: [] })?.kind).toBe('praise');
    for (const message of [
      'My friends love it. Is that enough?',
      'My friends bought three of them.',
      'My roommates never had the problem.',
      'I only told my roommates.',
    ])
      expect(newsOf({ message, before: [] })?.kind, message).not.toBe('praise');
    expect(at('I showed it to my friends and all of them said they would get one.').step?.view.playId).toBe(
      'friends-love-it',
    );
  });

  it('a share lost is read with whom to ask', () => {
    const text = leadOf('What share of my lofts did I lose in the second month?', {
      reads: known('16 lofts paid in the first month and 4 left in the second.', 'fact'),
    });
    expect(text).toMatch(/4 of (?:the )?16 lofts = 25%\. If that goes on/);
    expect(text).toMatch(/ask the 4 who left/);
  });

  it('a sum of another thing of theirs is kept apart from this one', () => {
    const asks =
      'So the loft pays 70 a month, and the loaves go for 5, so if I sell 100 loaves that is my second loft covered, right? My bakery is the other thing I run.';
    expect(leadOf(asks)).toMatch(
      /= \$500 .*Keep the two apart: that money is your bakery's, and it covers nothing of SailMend/,
    );
    const own = leadOf(
      'So the loft pays 70 a month, and the patches go for 5, so if I sell 100 patches that is my second loft covered, right?',
    );
    expect(own).toContain('$500');
    expect(own).not.toContain('Keep the two apart');
  });
});

describe('what they say back is answered', () => {
  const step = at('What should I do next?');
  const previous = guidanceOf(PLAYBOOK, step);

  it('a doubter gets the doubt, how far the numbers carry, and what would settle it', () => {
    const counts = 'In the north 6 of 20 boats ordered, and in the south 11 of 60 did.';
    const args: Parameters<typeof leadOf> = [
      'Convince a sceptic.',
      { reads: known(counts) },
      ['North or south?'],
      ['North.'],
    ];
    expect(leadOf(...args)).toMatch(
      /^The doubt is fair: 20 is a small group, and 2 fewer there would make the two equal/,
    );
    expect(leadOf('Now say that like a normal person.', args[1], ['North or south?'], ['North.'])).toMatch(
      /^Go with the north\./,
    );
    expect(ratesOf({ message: 'North or south?', earlier: [], told: [counts] })?.best).toMatchObject({
      part: 6,
      whole: 20,
    });
    expect(ratesOf({ message: 'North or south?', earlier: [], told: [] })).toBeNull();
  });

  it('a no, the worth of it, and what it was told', () => {
    const said = ['x'];
    expect(leadOf('And if they say no?', { previous }, said, ['Some reply.'])).toMatch(
      /^If they say no, thank them/,
    );
    expect(leadOf('What if nobody answers?', { previous }, said, ['Some reply.'])).toMatch(
      /^If they do not answer/,
    );
    expect(leadOf('Is that really worth my two free hours?', { previous }, said, ['Some reply.'])).toMatch(
      /^Yes, if it settles something\. It is about/,
    );
    expect(leadOf('What did you tell me to do?', { previous }, said, ['Some reply.'])).toMatch(
      /: put the idea on one page\./,
    );
  });

  it('how the others seem to do is told apart from their own numbers', () => {
    const text = leadOf(
      'Everyone else in the program seems to be flying.',
      { reads: known('3 lofts paid 80 dollars each.', 'milestone') },
      ['x'],
      ['Some reply.'],
    );
    expect(text).toMatch(/^What you see of the others is what they announce/);
    expect(text).toContain('3 lofts paid 80 dollars');
  });

  it('an answer they reject: what it left out of their own facts, and only then "your facts"', () => {
    const reads = known('Four lofts pay 25 dollars a month; two more are on a free trial.', 'milestone');
    const asks = ['How do I get my first customers?'];
    const prev = guidanceOf(PLAYBOOK, at(asks[0] ?? '', { reads }));
    const text = leadOf('That is textbook nonsense.', { reads, previous: prev }, asks, [
      'You have four lofts paying 25 dollars a month. Then list 50 more of the same kind by name, contact 5 a day, and ask for the order at the end of each talk.',
    ]);
    expect(text).toMatch(
      /^Fair, that was general\. From your own facts, then\. Start with the nearest: two more are on a free trial/,
    );
    expect(text).not.toContain('list 50 more');
    // All of it was said, the one fact stands once more, and not a second time.
    const all = [
      'Start with the nearest: two more are on a free trial. Ask them this week for the money, with the price and the day it starts. You have four lofts paying 25 dollars a month. Then list 50 more of the same kind by name, contact 5 a day, and ask for the order at the end of each talk.',
    ];
    const once = leadOf('That is textbook nonsense.', { reads, previous: prev }, asks, all);
    expect(once).toMatch(/four lofts pay/i);
    expect(
      leadOf('That is textbook nonsense.', { previous: guidanceOf(PLAYBOOK, at(asks[0] ?? '')) }, asks, [
        'Make a list.',
      ]),
    ).not.toContain('From your own facts');
  });

  it('a step not done moves, with the smaller one to do instead', () => {
    const now = storedStep({
      playId: 'interview-script',
      criterionId: 'discovery-ten-conversations',
      dueOn: '2026-11-20',
    });
    const text = leadOf("I didn't get to it. Midterms ate the week.", {
      reads: { ...NO_READS, path: path({ stage: 'discovery' }), steps: [now] },
    });
    expect(text).toMatch(/the step moves to/);
  });

  it('a smaller step fits the time they named, and the rest waits for what it waits for', () => {
    const text = leadOf(
      'That is too much before the exam. Give me something I can do in one evening.',
      { previous },
      ['x'],
      ['Some reply.'],
    );
    expect(text).toMatch(/so it fits one evening, and the rest waits until after your exam/);
  });

  it('one thing is for their idea, with no comma left over', () => {
    const text = leadOf(
      'Give me one thing to do before Monday.',
      { venture: { ...VENTURE, oneLiner: "Mends sails, which lofts' crews wait weeks for." } },
      ['x'],
      ['Some reply.'],
    );
    expect(text).toContain('So one thing, for SailMend');
    expect(text).not.toMatch(/,[:,]|It is for your idea/);
  });

  it('a plan says how each thing after the step starts', () => {
    expect(leadOf('Can you give me a plan for the next two weeks?')).toMatch(
      /\d\. Then: .+ It starts with this: .+/,
    );
  });
});

describe('a sum against the one before', () => {
  it('in what an hour brings', () => {
    const base = {
      earlier: ['One repair takes me eight hours and I charge 200 dollars.'],
      record: [] as string[],
    };
    expect(
      hourlyBefore({ ...base, message: 'The fee is 240 now, not 200. What does an hour change to?' }),
    ).toBe('Before: $200 / 8 hours = $25 an hour, so the change is $5 an hour more.');
    expect(hourlyBefore({ ...base, message: 'What does an hour bring?' })).toBeNull();
  });

  it('a record is read as they would say it', () => {
    expect(inTheirVoice('The founder changed the price from $200 to $240 per repair.')).toContain(
      'the price is $240 per repair now, not $200',
    );
    expect(inTheirVoice('You charge $240 for your repair.')).toBe('I charge $240 for my repair.');
  });
});

describe('a fact that stands beside an answer', () => {
  const source = (content: string, over: Partial<PriorSource> = {}): PriorSource => ({
    oneLiner: 'Sails mended by the yard.',
    reads: known(content),
    intake: null,
    earlier: [],
    message: 'How do I get lofts to pay for sails?',
    about: 'Will lofts pay for sails',
    said: '',
    venture: 'SailMend',
    applies: true,
    today: TODAY,
    ...over,
  });

  it.each([
    'Lofts are potential customers for mended sails.',
    'It seems that lofts may want mended sails.',
    'Founders should talk to lofts before paying themselves.',
    'You need to consult the office about paying themselves for sails.',
  ])('%s is none of theirs', (content) => {
    expect(priorFact(source(content))?.sentence ?? '').not.toContain(content.slice(0, 20).toLowerCase());
  });
  it.each([
    ['Two lofts pay 80 dollars a month for mended sails.', 'two lofts pay 80 dollars a month'],
    ['Ines said that her loft threw out six sails in May.', 'six sails in May'],
  ])('%s is', (content, said) => {
    expect(priorFact(source(content))?.sentence).toContain(said);
  });

  it('concrete: a number, a name, a day, a decision or words of theirs', () => {
    for (const yes of [
      'two lofts pay 80 dollars',
      'Ines joined in May and sews all the sails',
      'you decided to sell to lofts first',
    ])
      expect(concrete(yes), yes).toBe(true);
    for (const no of ['lofts are potential customers', 'the market is growing'])
      expect(concrete(no), no).toBe(false);
  });

  it('an idea is named, short, and their own problem is no order to us', () => {
    expect(ideaNamed('exam review packs written by students who took the course last term')).toBe(
      'your exam review packs',
    );
    expect(problemIn(["Guarantee me they can't take it away."])).toBe('');
    expect(problemIn(['Mending a sail here takes three weeks.'])).toContain('takes three weeks');
  });
});

describe('the story', () => {
  const entry = (id: string, kind: ArcEntry['kind'], on: string, title: string): ArcEntry =>
    ({ id, kind, on, title, detail: null, source: { kind: 'memory', id } }) as unknown as ArcEntry;
  it('the idea it opens with is no entry of it', () => {
    const start = 'SailMend is a bench that travels: one week in each harbour';
    expect(
      storyLines(
        [
          entry('1', 'result', '2026-10-01', 'SailMend is a bench that travels: one week in each harbour.'),
          entry('2', 'result', '2026-10-08', 'I asked nine harbour masters and seven said yes'),
        ],
        start,
      ).map((l) => l.on),
    ).toEqual(['2026-10-08']);
  });
});

describe('phrases that name a play', () => {
  it.each([
    ['What is a value proposition?', 'value-proposition'],
    ['How do I get from four lofts to ten?', 'first-ten-customers'],
    ['How do I get the film department to pay?', 'b2b-selling'],
    ['money bit. how??', 'pricing'],
    ['How much would they pay?', 'pricing'],
  ])('%s: %s', (message, id) => {
    expect(at(message).play?.id).toBe(id);
  });
});
