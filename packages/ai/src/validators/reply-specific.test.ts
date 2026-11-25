/**
 * A reply about them and nothing glued to it: the program's answer is never put after a whole answer of the model's own, the
 * template is the server's alone, the reply before is said again as it is, and who decides is named with what to bring. The
 * whole-reply check and the streamed gate give the same. Synthetic ventures and wording.
 */
import { describe, expect, it } from 'vitest';

import type { PromptGuidance } from '../prompts/guidance.js';
import { renderGuidance } from '../prompts/guidance.js';
import { statedPreferences } from '../prompts/conversation-state.js';
import { IP_REFERRAL, RECALL, SERVICE_OR_PRODUCT, STEP, STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { ownFactsUnit } from './own-facts.js';
import { bringWho, checkReplyContract, opensStep, rulesOnIt, withPick } from './reply-contract.js';
import { SentenceGate, type SentenceGateOptions } from './sentence-gate.js';
import { SPOKEN_MAX_WORDS } from './speech.js';

type Over = Partial<SentenceGateOptions>;
/** The reply as it is shown, streamed in small chunks. */
function streamed(reply: string, guidance: PromptGuidance, over: Over = {}): string {
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: 'How do I price it?',
    guidance,
    today: TODAY,
    callerContinues: true,
    ...over,
  });
  const out: string[] = [];
  const add = (units: readonly { readonly text: string; readonly spoken: string }[]): void => {
    for (const u of units) out.push(over.spoken === true ? `${u.spoken} ` : u.text);
  };
  add(gate.open().units);
  for (let i = 0; i < reply.length && gate.cut === null && !gate.spokenFull; i += 9)
    add(gate.push(reply.slice(i, i + 9)).units);
  add(gate.end().units);
  return out.join('').trim();
}
const whole = (
  reply: string,
  guidance: PromptGuidance,
  channel: 'text' | 'voice' = 'text',
  founderText = 'How do I price it?',
): string => checkReplyContract({ reply, guidance, channel, today: TODAY, founderText }).repaired ?? reply;
const both = (reply: string, guidance: PromptGuidance, founderText = 'How do I price it?'): string[] => [
  whole(reply, guidance, 'text', founderText),
  streamed(reply, guidance, { founderText }),
];

const PRICING: PromptGuidance = {
  ...SERVICE_OR_PRODUCT,
  firstTime: false,
  ask: {
    title: 'Set a first price',
    answer:
      'Price from what the customer uses now, not from your costs. Find what their current way costs them in money and time. Set your price below that cost and above what one sale costs you. Say it out loud to five buyers this week.',
    why: 'Customers judge a price against their alternative.',
    traps: [],
    evidenceKeys: ['E1'],
  },
  facts: ['sail lofts ask 90 dollars a patch', 'SailMend, which mends sails on the pier'],
};

describe('the program’s answer after a whole answer of the model’s own', () => {
  it.each([
    // The pick in other words.
    'Your number should start from what crews pay for a patch today, not from what thread runs you. Go a little under that and say it to five crews without a word more, then write down whether they pause.',
    // Their own facts.
    'Lofts ask 90 dollars a patch here, so go in just under it on the pier and watch who hesitates. If nobody does, the next crew hears a higher one, and you keep the first as it was.',
    // The thing itself.
    'Here is the line to say on the pier on Saturday: "Two days, sixty minutes from the dock, and you race on it Sunday. Shall I take the sail now?" Then stop and let them answer before you add anything.',
  ])('%s', (reply) => {
    for (const shown of both(reply, PRICING)) {
      expect(shown).toContain(reply);
      expect(shown).not.toContain('Price from what the customer uses now');
    }
  });

  it.each([
    'There is a lot going on around this at the moment and many teams are in it with you.',
    'Great things take time and I know you can do this if you keep at it every day this term.',
  ])('an answer of nothing still gets it: %s', (reply) => {
    for (const shown of both(reply, PRICING))
      expect(shown).toContain('Price from what the customer uses now');
  });

  it('what a person decides stays in the program’s words', () => {
    const reply =
      'You made it on your own time with your own hands and your own thread, so most people would say that the thing is yours to sell to anyone who asks for it on the pier.';
    for (const shown of both(reply, IP_REFERRAL, 'Who owns it?'))
      expect(shown).toContain('Assume the university may own part of it');
  });

  it('on a call one short answer that is about it is enough', () => {
    const reply = 'Start from what crews pay a loft today, and go just under it on Saturday.';
    for (const shown of [
      whole(reply, PRICING, 'voice'),
      streamed(reply, PRICING, { spoken: true, spokenWordBudget: SPOKEN_MAX_WORDS }),
    ])
      expect(shown).not.toContain('Price from what the customer uses now');
  });
});

describe('their facts, always', () => {
  const told: PromptGuidance = {
    ...PRICING,
    prior: {
      fact: 'one loft pays 300 dollars a month',
      sentence: 'You have one loft paying 300 dollars a month. You do not have a second one who pays yet.',
      spoken: 'You have one loft paying 300 dollars a month. You do not have a second one who pays yet.',
      gap: 'You do not have a second one who pays yet.',
    },
    facts: ['one loft pays 300 dollars a month'],
  };
  const GENERIC =
    'Price from what the customer uses now, not from your costs. Find what their current way costs them in money and time, and go below it. Then say it to five buyers this week and listen.';

  it('an answer with none gets them once, streamed and whole, and the check holds still', () => {
    for (const shown of both(GENERIC, told)) {
      expect(shown.match(/You have one loft paying/g)).toHaveLength(1);
      expect(whole(shown, told)).toBe(shown);
    }
  });

  it('one that tells them is told only what is missing, and one that tells both, nothing', () => {
    const has = `${GENERIC} Your loft that pays 300 dollars a month is where to read it from.`;
    for (const shown of both(has, told)) {
      expect(shown).not.toContain('You have one loft paying');
      expect(shown.match(/You do not have a second one who pays yet\./g)).toHaveLength(1);
    }
    const all = `${has} A second one that pays is what you do not have yet.`;
    for (const shown of both(all, told))
      expect(shown).not.toContain('You do not have a second one who pays yet.');
  });

  it('are given to the model as facts to use, in place of one prior fact, and the answer as a method to apply', () => {
    const block = renderGuidance(told, 'text', { today: TODAY });
    expect(block).toContain("The program's answer, to apply to them and never to recite: Price from");
    expect(block).toContain('<facts>one loft pays 300 dollars a month</facts>');
    expect(block).toContain('name the people, places and numbers of their case');
    expect(block).not.toContain('<prior>');
    // In the size the one answer had before, however much there is.
    const full: PromptGuidance = {
      ...told,
      ask: {
        title: 'Set a first price',
        evidenceKeys: ['E1'],
        answer: 'a'.repeat(2000),
        why: 'b'.repeat(900),
        traps: ['c'.repeat(900)],
      },
      facts: ['d', 'e', 'f', 'g', 'h'].map((x) => x.repeat(400)),
    };
    const size =
      renderGuidance(full, 'text', { today: TODAY }).length -
      renderGuidance({ ...full, ask: null, facts: [] }, 'text', { today: TODAY }).length;
    expect(size).toBeLessThan(2250);
  });
});

describe('the template is the server’s alone', () => {
  const BODY =
    '1. Who: crews at the pier (seen / guess)\n2. Problem: [what goes wrong, how often] (seen / guess)\n3. Today: [what they do now] (seen / guess)\n4. Idea: mend sails at the pier (seen / guess)\n5. Why me: [what I know] (seen / guess)';
  const step = { ...STEP, title: 'Put the idea on one page', template: { title: 'Five lines', body: BODY } };
  const OPENS: PromptGuidance = {
    ...STEP_ONLY,
    firstTime: false,
    step,
    template: 'opens',
    lead: {
      text: `First, put SailMend on one page.\n\nHere it is to fill in:\n\n${BODY}`,
      voice: 'It is on your screen.',
    },
  };
  const MODEL =
    'Hello Rae, good to see that you are further along.\n\nHere is your page. The brackets are for you:\n\n1. **Who:** crews\n5. **Why me:** [What I know]\n\nThis lays out the work.\n\nCrews lose a race while they wait, so check that line first.';

  it('under a lead that holds it, the model’s lines, its announcements and its greeting go', () => {
    for (const shown of both(MODEL, OPENS, 'SailMend mends sails.')) {
      expect(shown.match(/Why me:/g)).toHaveLength(1);
      expect(shown).not.toMatch(/good to see|brackets are|lays out/);
      expect(shown).toContain('Crews lose a race while they wait');
    }
  });

  it('never half of it: what the model starts is given whole, when that is all it said', () => {
    const offer: PromptGuidance = { ...STEP_ONLY, firstTime: false, step, template: 'offer' };
    const half =
      'Let’s make it a one-pager. I’ll begin the first line, and you carry on.\n\n1. Who: crews at the pier';
    for (const shown of both(half, offer, 'What is the first line?')) {
      expect(shown).not.toContain('you carry on');
      expect(shown.match(/1\. Who:/g) ?? []).toHaveLength(shown.includes('5. Why me:') ? 1 : 0);
    }
    const said =
      'Crews lose a race while they wait for a loft, and that is the line to check before any other: ask six of them on Saturday what they did the last time a sail tore, and what it cost them in days and dollars.\n\n1. Who: crews\n2. Problem: torn sails';
    for (const shown of both(said, offer, 'What is the first line?')) expect(shown).not.toContain('1. Who:');
    expect(renderGuidance(offer, 'text', { today: TODAY })).toContain(
      '"Five lines" is on the card under your reply: never write its lines.',
    );
    expect(renderGuidance(offer, 'text', { today: TODAY })).not.toContain('[what goes wrong');
  });

  it('what is said of one of its lines goes whole, never to a scrap of it', () => {
    const reply =
      'Less, then. Fill the second line alone: what breaks? That is the seam. Good. Call it seen. No more tonight.\n\nOne race a week is enough to ask at, and it leaves your evenings for the exam.';
    for (const shown of both(reply, OPENS, 'That is too much.')) {
      expect(shown).not.toMatch(/That is the seam|Call it seen|No more tonight/);
      expect(shown).toContain('One race a week is enough');
    }
  });

  it('the part that fills it in goes with what hangs on it', () => {
    const reply =
      'Begin here: write the five lines in plain words. No jargon, and say them aloud to a friend. Here it is to fill in.\n\nCrews lose a race while they wait for a loft, so ask six of them on Saturday what it cost.';
    for (const shown of both(reply, OPENS, 'SailMend mends sails.')) {
      expect(shown).not.toMatch(/No jargon|Here it is to fill in\.\n/);
      expect(shown).toContain('Crews lose a race');
    }
  });

  it.each([
    ['Nah\n\nAsk six crews on Saturday what it cost them.', 'Nah'],
    [
      'I won’t call it ready, because no crew has paid.\n\nAsk six crews on Saturday what it cost them.',
      'call it ready',
    ],
  ])('under a verdict that was given, "%s" is not said over', (reply, gone) => {
    const given: PromptGuidance = {
      ...STEP_ONLY,
      lead: {
        text: 'I will not call it ready, because no crew has paid. Sell ten first.',
        voice: 'I will not call it ready. Sell ten first.',
      },
    };
    for (const shown of both(reply, given, 'Is it ready or nah?')) {
      expect(shown.replace(given.lead?.text ?? '', '')).not.toContain(gone);
      expect(shown).toContain('Ask six crews on Saturday');
    }
  });

  it('a list that is no template stays, and so does a template nobody serves', () => {
    const list =
      'Ask three crews on Saturday:\n\n1. **Ask**: what did you do the last time a sail tore?\n2. **Look** for the same answer twice.\n\nTwo alike is where you start, whatever the third one says.';
    for (const shown of both(list, OPENS, 'SailMend mends sails.'))
      expect(shown).toContain('2. **Look** for the same answer twice.');
    const free: PromptGuidance = { ...STEP_ONLY, firstTime: false, step };
    const line =
      'The page starts like this, out of your notes from the pier:\n\n1. Who: crews at the pier\n2. Problem: [what goes wrong, how often]';
    for (const shown of both(line, { ...free, said: 'crews at the pier' }, 'x'))
      expect(shown).toContain('1. Who: crews at the pier');
  });

  it('what only says again what opened the reply goes, to its last words', () => {
    const lead: PromptGuidance = {
      ...STEP_ONLY,
      firstTime: false,
      lead: {
        text: 'Here is the message.\n\n"Hi [name], could I ask you about the last time? It takes 15 minutes. Would [day] or [day] work?\nJo"',
        voice: 'Keep it to three lines.',
      },
    };
    const reply =
      'Here is your note, and the [brackets] are for you:\n\n"Hi [name], could I ask you about the last time? It takes 15 minutes. Would [day] or [day] work?"\n\nAsk the harbour crews first, because they answer on the dock.';
    for (const shown of both(reply, lead, 'Can you write the message?')) {
      expect(shown.match(/Would \[day\]/g)).toHaveLength(1);
      expect(shown).not.toContain('you should send');
      expect(shown).toContain('Ask the harbour crews first');
    }
  });
});

describe('the reply before, in other words', () => {
  const guidance: PromptGuidance = {
    ...STEP_ONLY,
    firstTime: false,
    restate: {
      how: 'plain',
      reply: 'Sell to lofts first: 6 of 20 ordered there, against 11 of 60 crews. The share decides.',
    },
  };
  const before = {
    previousReply: 'Picture two piers: would you take 9 of 12 lofts or 10 of 50? Lofts order more often.',
  };

  it('is said as it is: a repeat of what was said, with its question, and nothing glued to it', () => {
    const reply = 'Picture two piers: would you take 9 of 12 lofts or 10 of 50? Lofts order more often.';
    const shown = streamed(reply, guidance, { founderText: 'Say that like a normal person.', ...before });
    expect(shown.startsWith(reply)).toBe(true);
    expect(shown).not.toContain('Here is how the step goes');
  });

  it('two short sentences are enough, and nothing is the reply before, in short', () => {
    for (const shown of both('Lofts buy more. Go there.', guidance, 'Say that like a normal person.'))
      expect(shown).toMatch(/^Lofts buy more\. Go there\.\n\n\*\*/);
    expect(whole('Okay.', guidance)).toContain('In short: Sell to lofts first');
  });

  it('the model is told what to say again, and how', () => {
    const block = renderGuidance(guidance, 'text', { today: TODAY });
    expect(block).toContain('They ask for your last reply again. Say it again in everyday words');
    expect(block).toContain('<last_reply>Sell to lofts first');
    expect(block).not.toContain('Write the answer to what they asked');
    expect(renderGuidance({ ...STEP_ONLY, rejected: true }, 'text')).toContain(
      'They reject your last reply.',
    );
  });
});

describe('who decides, named with what to bring in the same sentence', () => {
  it('never "Bring …" to nobody', () => {
    const answer =
      'Assume the university may own part of it until its technology transfer office says otherwise, and do not share it as yours yet.';
    for (const shown of both(answer, IP_REFERRAL, 'Who owns it?')) {
      expect(shown).not.toMatch(/(?:^|\. |\n)Bring (?:the|a|an|your) invention/);
      expect(shown).toContain('Bring the university technology transfer office the invention history page');
    }
    const none =
      'Assume the university may own part of it until you know, and do not share or sell it as yours yet: ownership turns on who paid for the work.';
    for (const shown of both(none, IP_REFERRAL, 'Who owns it?'))
      expect(shown).toMatch(
        /Talk to the university technology transfer office, [^.]*\. Bring them the invention history page/,
      );
  });

  it('the model’s own is put to them, once, and left alone when it says to whom', () => {
    expect(bringWho('Bring a one-page timeline and the papers.', IP_REFERRAL)).toBe(
      'Bring the university technology transfer office a one-page timeline and the papers.',
    );
    const put = bringWho('Bring a one-page timeline and the papers.', IP_REFERRAL);
    expect(bringWho(put, IP_REFERRAL)).toBe(put);
    expect(
      bringWho(
        'Bring your notes.',
        IP_REFERRAL,
        'This one is for the university technology transfer office.',
      ),
    ).toBe('Bring them your notes.');
    for (const same of [
      'Bring the papers to the office.',
      'Bring them the papers.',
      'Bringing the papers helps.',
    ])
      expect(bringWho(same, IP_REFERRAL)).toBe(same);
    expect(bringWho('Bring a pen.', STEP_ONLY)).toBe('Bring a pen.');
  });

  it.each([
    'Submit the provisional today, so the poster is safe.',
    'Yes, sign it.',
    'Go ahead and sign the form.',
    'It’s yours, because you made it.',
    'The university owns it.',
    'You should take the money.',
  ])('%s is a ruling nobody here gives', (unit) => {
    expect(rulesOnIt(unit, IP_REFERRAL)).toBe(true);
    expect(rulesOnIt(unit, SERVICE_OR_PRODUCT)).toBe(false);
  });
  it.each([
    'Do not file or wait on your own.',
    'Ask the office before you sign it.',
    'The university may own part of it.',
    'A provisional application holds a date for 12 months.',
  ])('%s is none', (unit) => {
    expect(rulesOnIt(unit, IP_REFERRAL)).toBe(false);
  });
});

describe('a call', () => {
  const guidance: PromptGuidance = { ...STEP_ONLY, firstTime: false, matched: 'none' };
  it('no list of questions is read out, and one short answer is left', () => {
    const reply =
      'Ask about the last time a sail tore and stay quiet. What did you do? What was hard about it? What did it cost you? What else have you tried? Then write down their words.';
    const shown = streamed(reply, guidance, {
      spoken: true,
      spokenWordBudget: SPOKEN_MAX_WORDS,
      founderText: 'So what do I do with that?',
    });
    expect(shown).not.toMatch(/\?/);
    expect(shown).toContain('Ask about the last time a sail tore');
    expect(shown).toContain('write down their words');
  });

  it('a line to say, and one question at the end, stay', () => {
    const reply =
      'Open with the crew: "A crew loses its race for one torn seam." That is the story they keep. Which crew will you ask first?';
    const shown = streamed(reply, guidance, {
      spoken: true,
      spokenWordBudget: SPOKEN_MAX_WORDS,
      founderText: 'How do I open?',
    });
    expect(shown).toContain('A crew loses its race');
    expect(shown.match(/\?/g)).toHaveLength(1);
  });
});

describe('what is no answer, and no step of the model’s', () => {
  it.each([
    'Next, choose one group to ask.',
    'Next, we turn to the pass line.',
    'Next, we’ll see which price crews accept.',
    'It moves the weight: your next step is to ask the lofts.',
    'That prepares your next step: choose which tear comes first.',
  ])('%s is step talk', (unit) => {
    const reply = `Lofts pay for it already and crews do not, so the lofts are where you go with the first offer this week.\n\n${unit}`;
    for (const shown of both(reply, { ...STEP_ONLY, firstTime: false, matched: 'none' }))
      expect(shown).not.toContain(unit);
  });
  it('an order of its own keeps its "Next,"', () => {
    const reply =
      'First, show the torn sail. Next, show the price they pay a loft. Then say what you do, and stop there for a moment.';
    for (const shown of both(reply, { ...STEP_ONLY, firstTime: false, matched: 'none' }))
      expect(shown).toContain('Next, show the price');
    expect(opensStep('The next step in their process is approval.')).toBe(false);
  });

  it('its own name alone, "Yes." under a verdict, and a label’s lower case', () => {
    expect(
      streamed(
        'Thomas\n\nLofts pay for it already, so go to the lofts with the first offer this week and not to crews.',
        { ...STEP_ONLY, firstTime: false, matched: 'none' },
      ),
    ).toMatch(/^Lofts pay/);
    const lead: PromptGuidance = {
      ...STEP_ONLY,
      firstTime: false,
      lead: { text: 'Not yet. Nobody has paid.', voice: 'Not yet.' },
    };
    for (const shown of both(
      'Yes. Crews asked when they could start, and that is worth a call to each of them tonight.',
      lead,
    ))
      expect(shown).not.toMatch(/\bYes\./);
    for (const shown of both(
      'Both, in order: first by hand, then as software for what repeats.\n\nWhy: a service pays you while you learn how the work is really done.',
      SERVICE_OR_PRODUCT,
    ))
      expect(shown).toContain('A service pays you');
  });

  it('a recall gives the step’s own day, never another one of the notes', () => {
    const recall: PromptGuidance = { ...RECALL, step: { ...STEP, dueOn: '2026-11-26' } };
    const shown = whole(
      'Yes, you planned to list 20 office managers and message 5 of them by Monday, December 7.',
      recall,
      'text',
      'Did I have something to do?',
    );
    expect(shown).not.toContain('December 7');
  });

  it('a story the server told in dated lines is not told again in dated lines', () => {
    const lead: PromptGuidance = {
      ...RECALL,
      step: STEP,
      lead: {
        text: 'You started with sails.\n- November 2: two lofts paid.\n- November 9: you changed direction to covers.',
        voice: 'x',
      },
    };
    for (const shown of both(
      '- November 2: two of the lofts you met said that they pay for mending.\n\nCovers are what the lofts asked for, so that is where you are.',
      lead,
      'Remind me how we got here.',
    ))
      expect(shown.match(/November 2:/g)).toHaveLength(1);
  });

  it('"is a pilot the same as a sale?" answered no says No', () => {
    const g: PromptGuidance = { ...STEP_ONLY, choice: { kind: 'yes_no', options: ['yes', 'no'] } };
    const ask = 'Is a pilot the same as a sale?';
    expect(withPick('A pilot is not yet one, and it ends on a day.', g, ask)).toBe(
      'No. A pilot is not yet one, and it ends on a day.',
    );
    for (const same of ['No, it is a trial.', 'Yes, when they pay for it.', 'A pilot ends in a sale.'])
      expect(withPick(same, g, ask)).toBe(same);
    expect(withPick('Raise it, not all at once.', g, 'Should I raise the price?')).toBe(
      'Raise it, not all at once.',
    );
  });

  it('another page’s lines do not stand under what a person decides', () => {
    const lead: PromptGuidance = {
      ...IP_REFERRAL,
      ask: null,
      lead: { text: 'A relative offers 9,000 dollars. Do not name a percentage yet.', voice: 'x' },
      step: { ...STEP, template: { title: 'What to say', body: '"Thank you. I am getting advice first."' } },
    };
    const reply =
      'Let’s make this a one-pager to reply with.\n\n1. **Who**: crews\n2. **Problem**: torn sails\n\nAn order paid ahead lets them help today without any paper between you.';
    for (const shown of both(reply, lead, 'x')) {
      expect(shown).not.toMatch(/\*\*Who\*\*|on one page/);
      expect(shown).toContain('An order paid ahead');
    }
  });
});

describe('a social turn', () => {
  it('what follows a step it dropped goes with it', () => {
    const social: PromptGuidance = { ...STEP_ONLY, kind: 'social' };
    const shown = streamed(
      'Got it, the pier on Saturday it is.\n\nNext step: walk the pier and stop at four boats.\n\nNote each reply, the odd ones too. Keep the best two.',
      social,
      { founderText: 'ok' },
    );
    expect(shown).toBe('Got it, the pier on Saturday it is.');
  });
});

describe('verdicts only buyers can give', () => {
  const g = (said: string): PromptGuidance => ({ ...STEP_ONLY, said });
  const of = (unit: string, said: string) => ownFactsUnit(unit, g(said)).text;
  it.each([
    'Your fee is right since it beats what a patch costs you.',
    'Your price looks fair for what they get.',
    'The fee of 300 dollars is reasonable.',
    'That is a clear signal of willingness to pay.',
    'That shows they would pay for it.',
    'Four crews paid in your last test, a line you set and beat.',
  ])('%s', (unit) => {
    expect(
      of(
        unit,
        'I charge 300 dollars and one takes nine hours. Four asked when they could start. 3 customers.',
      ),
    ).toBe('');
  });

  it('stand once buyers answered, or a line was set, and when they are hedged', () => {
    expect(of('Your price looks fair for what they get.', 'Nine lofts paid 30 dollars.')).not.toBe('');
    expect(of('It missed the target you set.', 'My target is 8 of 20. 3 paid.')).not.toBe('');
    for (const hedged of [
      'Ask five buyers whether your price is right.',
      'Nobody knows yet if the fee is fair.',
      'That does not show they would pay for it.',
      'Is the fee right?',
    ])
      expect(of(hedged, 'I charge 300 dollars.')).toBe(hedged);
    // Their own spending, or nobody paying, is no answer of a buyer's.
    expect(
      of('Your price looks fair for what they get.', 'I paid 60 dollars for the stall. Nobody paid.'),
    ).toBe('');
  });

  it('a pitch claims only what they showed', () => {
    const said = 'RootFinder finds tree roots near pipes. I talked to two city crews.';
    expect(of('So far we’ve run it at two piers and halved the wait.', said)).toBe(
      'So far [what you have shown: who, how many, what they did].',
    );
    const theirs = 'So far we talked to two city crews.';
    expect(of(theirs, said)).toBe(theirs);
    const blank = 'So far [number] crews used it.';
    expect(of(blank, said)).toBe(blank);
    const other = 'So far, so good is what judges hear.';
    expect(of(other, said)).toBe(other);
  });
});

describe('no more questions, when they say so', () => {
  it.each([
    "Don't waste my time with questions. How do I get to ten?",
    'Stop wasting my time with all these questions',
  ])('%s', (text) => {
    expect(statedPreferences([], text)).toContain('no questions');
  });
  it('a question about time is none', () => {
    expect(statedPreferences([], 'How do I stop wasting time on slides?')).not.toContain('no questions');
  });
});
