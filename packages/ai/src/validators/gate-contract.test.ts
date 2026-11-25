import { describe, expect, it } from 'vitest';

import { guidanceText, type PromptGuidance } from '../prompts/guidance.js';
import { IP_REFERRAL, SERVICE_OR_PRODUCT, SOCIAL, STEP_ONLY, TODAY, STEP } from '../testing/path-fixtures.js';
import { buildSupportIndex } from './citation-support.js';
import { validateCoachResponse } from './coach-response.js';
import { checkReplyContract, stepLine } from './reply-contract.js';
import { SentenceGate, type SentenceGateOptions } from './sentence-gate.js';
import { SPOKEN_MAX_WORDS } from './speech.js';

const BASE: SentenceGateOptions = {
  personaName: 'Thomas',
  mentor: true,
  otherVentureNames: [],
  otherVentureCanaries: [],
  founderText: 'Service, software, or both?',
  guidance: SERVICE_OR_PRODUCT,
  today: TODAY,
  callerContinues: true,
};

const ANSWER =
  'Both, in order: run it by hand as a paid service for your first three companies, then turn what repeats into software.';
/** The step as a model wrote it, and the one line the server writes. */
const OWN_NEXT =
  'Next: list 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names and two calls booked.';
const NEXT = stepLine(STEP, 'text', TODAY);
const SPOKEN_NEXT = stepLine(STEP, 'voice', TODAY);

/** Streams `text` in small chunks; returns what was shown, what was said, and after which chunk each unit came. */
function stream(text: string, options: Partial<SentenceGateOptions> = {}, size = 7) {
  const gate = new SentenceGate({ ...BASE, ...options });
  const shown: string[] = [];
  const said: string[] = [];
  let firstAt: number | null = null;
  for (let i = 0; i < text.length; i += size) {
    const out = gate.push(text.slice(i, i + size));
    for (const u of out.units) {
      firstAt ??= i + size;
      shown.push(u.text);
      if (u.spoken !== '') said.push(u.spoken);
    }
    if (out.cut !== null || gate.full || gate.spokenFull) break;
  }
  if (gate.cut === null && !gate.full && !gate.spokenFull)
    for (const u of gate.end().units) {
      shown.push(u.text);
      if (u.spoken !== '') said.push(u.spoken);
    }
  return { gate, text: shown.join(''), said: said.join(' '), firstAt };
}

describe('the gate holds a streamed reply to the contract', () => {
  it('drops the model’s own step talk as whole blocks, and writes the one step line', () => {
    for (const talk of [
      OWN_NEXT,
      'A good next step: build a landing page and collect emails.',
      'Next: build a landing page by Friday. One page. Done when it is live.',
      'Do it by Wednesday, December 2. Done when one sentence exists.',
      'Here’s what to do:\n\n1. Write 20 names from your network and campus offices. LinkedIn and the directory.\n2. Message five of them with the short note.',
    ]) {
      const out = stream(`${ANSWER}\n\n${talk}`);
      expect(out.text, talk).toBe(`${ANSWER}\n\n${NEXT}`);
      expect(out.gate.trace.rewritten).toBe(true);
    }
  });

  it('releases the answer unchanged, each sentence when it ends, and the step before the question', () => {
    const reply = `${ANSWER} A service pays you while you watch the workflow.\n\nWhich office do you know best?`;
    const out = stream(reply);
    expect(out.text).toBe(
      `${ANSWER} A service pays you while you watch the workflow.\n\n${NEXT}\n\nWhich office do you know best?`,
    );
    expect(out.gate.trace).toMatchObject({ contractAppended: true });
    // The first sentence came as soon as the next one had started (no later than without the contract).
    const plain = stream(reply, { guidance: null });
    expect(out.firstAt).toBe(plain.firstAt);
    expect(plain.text).toBe(reply);
  });

  it('never shows a deferral, and puts the answer and the step in place of questions alone', () => {
    const out = stream(
      "Before we pick a structure, I'd want to understand the market. What's your plan to reach someone like that?",
    );
    expect(out.text.startsWith('Both, in this order: do it by hand as a paid service')).toBe(true);
    expect(out.text.endsWith(NEXT)).toBe(true);
    expect(out.text).not.toMatch(/before we|your plan/i);
    expect(
      checkReplyContract({ reply: out.text, guidance: SERVICE_OR_PRODUCT, channel: 'text', today: TODAY }).ok,
    ).toBe(true);
  });

  it('moves a first-sentence question after the help and the step, and keeps one', () => {
    expect(stream(`Who is the office manager you know best? ${ANSWER}`).text).toBe(
      `${ANSWER}\n\n${NEXT}\n\nWho is the office manager you know best?`,
    );
    expect(stream(`${ANSWER} Which office do you know best? And who signs there?`).text).toBe(
      `${ANSWER}\n\n${NEXT}\n\nAnd who signs there?`,
    );
  });

  it('a reply that was only step talk is the program’s answer and the step', () => {
    const out = stream('One card. Done when the offer is on it, by Monday.');
    expect(out.text).toContain('Both, in this order: do it by hand as a paid service');
    expect(out.text.endsWith(NEXT)).toBe(true);
    expect(out.text).not.toContain('Monday.');
  });

  it('a paragraph left out leaves its break: the next one begins it', () => {
    const out = stream(
      `${ANSWER}\n\n${OWN_NEXT}\n\nA short note to send them says what you do and asks for ten minutes.`,
    );
    expect(out.text).toBe(
      `${ANSWER}\n\nA short note to send them says what you do and asks for ten minutes.\n\n${NEXT}`,
    );
  });

  it('what was shown is what the validator stores', () => {
    for (const reply of [
      `${ANSWER}\n\n${OWN_NEXT}`,
      'One card. Done when the offer is on it, by Monday.',
      `${ANSWER} Which office do you know best?`,
      'What do you want to build? Who is it for?',
    ]) {
      const shown = stream(reply).text;
      const kept = validateCoachResponse(
        {
          mode: 'coach',
          answer: shown,
          claims: [],
          uncertainty: [],
          challenge: null,
          next_actions: [],
          escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
          memory_candidates: [],
          follow_up_questions: [],
          rehearsal: null,
          spoken: null,
        },
        {
          evidenceKeys: new Set(['E1']),
          preRisk: { categories: [] },
          otherVentureNames: [],
          otherVentureCanaries: [],
          personaName: 'Thomas',
          mentor: true,
          coverageThreshold: 0.6,
          founderText: 'Service, software, or both?',
          guidance: SERVICE_OR_PRODUCT,
          today: TODAY,
          released: true,
        },
      );
      expect(kept.response.answer).toBe(shown.trim());
    }
  });

  it('never leaves the step out as something said before', () => {
    const earlier = `${ANSWER}\n\n${NEXT}`;
    const out = stream('Charge the first company half up front, because a deposit shows they mean it.', {
      guidance: STEP_ONLY,
      previousReply: earlier,
    });
    expect(out.text).toContain(NEXT);
    expect(out.gate.trace.repeatsDropped).toBe(0);
  });

  it('an item of a draft made better is never a repeat that ends the reply', () => {
    const page = '1. Who: office managers\n2. Problem: filing by hand\n3. Why me: [what I know]';
    const out = stream(`Here is your page with the new line in it:\n\n${page}`, {
      guidance: { ...STEP_ONLY, firstTime: false },
      previousReply: `Here is the page:\n\n${page}`,
    });
    expect(out.text).toContain(page);
    expect(out.gate.cut).toBeNull();
  });

  it('names who decides when a qualified person must', () => {
    const out = stream(
      'Assume the university may own part of it; ownership turns on who paid for the work, whose equipment you used and what you signed.',
      { guidance: IP_REFERRAL, founderText: 'Who owns it?' },
    );
    expect(out.text).toContain('A qualified person decides this: the university technology transfer office');
    expect(out.text).toContain('**Next:** Write a one-page invention history');
  });

  it('exempts social turns, role-play, an honest answer about the coach, and a thanks budget', () => {
    expect(stream('Good to see you. How was the exam?', { guidance: SOCIAL }).text).toBe(
      'Good to see you. How was the exam?',
    );
    expect(
      stream('Why should I fund you? Who pays?', { guidance: { ...STEP_ONLY, kind: 'rehearsal' } }).text,
    ).toBe('Why should I fund you? Who pays?');
    expect(
      stream("Yes, I'm Thomas, an AI mentor. Where were we?", { founderText: 'Are you a bot?' }).text,
    ).not.toContain('Next:');
    expect(
      stream('Any time. Talk soon.', { founderText: 'thanks!', replyBudget: { sentences: 2, words: 25 } })
        .text,
    ).toBe('Any time. Talk soon.');
  });

  it('never puts a step to a founder in distress', () => {
    const founderText = "I don't know why I even try anymore, I have nothing left to give";
    const reply =
      'That sounds heavy, and it makes sense that you are worn out. Is there someone you can talk to today?';
    expect(stream(reply, { founderText }).text).toBe(reply);
    expect(checkReplyContract({ reply, guidance: SERVICE_OR_PRODUCT, channel: 'text', founderText }).ok).toBe(
      true,
    );
  });

  it('reads the claims of each sentence as it streams', () => {
    const support = buildSupportIndex({
      evidence: [
        {
          key: 'E1',
          title: 'Service first',
          excerpt: 'Run the workflow by hand as a paid service before you write software.',
        },
      ],
      founderText: 'Service, software, or both?',
      guidanceText: guidanceText(SERVICE_OR_PRODUCT, TODAY),
    });
    const out = stream(
      `${ANSWER.slice(0, -1)} [E1]. About 70% of startups skip this. Post about it daily [E1].`,
      { support, evidenceKeys: new Set(['E1']) },
    );
    expect(out.text).toBe(`${ANSWER.slice(0, -1)} [E1]. Post about it daily.\n\n${NEXT}`);
    expect(out.gate.trace.supportEdits).toBe(2);
  });

  it('says what comes first at once, before the model wrote anything, and never a second time', () => {
    const lead = {
      text: '40 boxes x $3.50 left per box = $140 a month before other costs.',
      voice: '40 boxes times $3.50 left per box is $140 a month before other costs.',
    };
    const guidance: PromptGuidance = { ...STEP_ONLY, lead };
    const gate = new SentenceGate({ ...BASE, guidance });
    const first = gate.open();
    expect(first.units.map((u) => u.text)).toEqual([lead.text]);
    expect(gate.open().units).toEqual([]);
    const rest = [
      ...gate.push('You would make $140 a month at 40 boxes. ').units,
      ...gate.push('That pays for one fair a month, and no more than that for now. ').units,
      ...gate.end().units,
    ];
    expect(lead.text + rest.map((u) => u.text).join('')).toBe(
      `${lead.text}\n\nThat pays for one fair a month, and no more than that for now.\n\n${NEXT}`,
    );
    // A model that gives nothing more still leaves a whole reply.
    expect(stream('', { guidance }).text).toBe(`${lead.text}\n\n${NEXT}`);
    expect(stream('', { guidance, spoken: true }).said).toBe(`${lead.voice} ${SPOKEN_NEXT}`);
  });

  it('keeps what opens the reply when the model narrates or writes JSON', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      lead: { text: 'You have eight of the ten talks.', voice: 'You have eight of the ten talks.' },
    };
    for (const bad of [
      '{"answer": "Hi"}',
      'The founder is asking about talks. I need to figure out the mode.',
    ]) {
      const out = stream(bad, { guidance });
      expect(out.text.startsWith('You have eight of the ten talks.')).toBe(true);
      expect(out.text).not.toMatch(/founder is asking|answer"/);
      expect(out.gate.fallback).toBeNull();
    }
  });

  it('tells a first-time founder what a business word means, once', () => {
    const guidance: PromptGuidance = { ...STEP_ONLY, firstTime: true };
    const out = stream(
      'Write the value proposition from what people told you. A value proposition is never a slogan.',
      { guidance },
    );
    expect(out.text).toContain(
      'Write the value proposition (one sentence on who you help and how) from what people told you.',
    );
    expect(out.text.match(/one sentence on who you help/g)).toHaveLength(1);
    expect(
      stream('Write the value proposition from what people told you today.', {
        guidance: { ...STEP_ONLY, firstTime: false },
      }).text,
    ).not.toContain('(one sentence');
  });

  it('never rewrites a line written for them as if the coach said it', () => {
    const out = stream(
      'Your page, with the one line you gave me:\n\n5. **Why me**: I’m in the gym daily and run the swap group',
      {
        guidance: { ...STEP_ONLY, said: 'I run the campus swap group and I am in the gym daily' },
      },
    );
    expect(out.text).toContain('5. **Why me**: I’m in the gym daily and run the swap group');
    expect(out.text).not.toContain('AI mentor');
  });

  it('a list of the step’s own parts goes, though the answer names the first of them', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      kind: 'report',
      ask: {
        title: 'What they report',
        answer:
          'That is a clear commitment. Begin with this: write 20 names from your network and campus offices.',
        why: '',
        traps: [],
        evidenceKeys: [],
      },
    };
    const reply =
      'The names come first because they decide whose workflow you hear about, and a wrong list wastes the week.\n\n1. Write 20 names from your network and campus offices.\n2. Message five of them.';
    const { text } = stream(reply, { guidance });
    expect(text).not.toMatch(/^\d\. /m);
    expect(text.endsWith(NEXT)).toBe(true);
  });

  it('a story the server told is not told again with its dates', () => {
    const lead = {
      text: 'You started with this idea: soap.\n- November 2: you sold six soaps.',
      voice: 'You started with soap.',
    };
    const reply =
      'November 2: Sold soaps. Open step now: Hold three talks.\n\nThe soaps sold because you stood where people wash.';
    expect(stream(reply, { guidance: { ...STEP_ONLY, kind: 'recall', lead } }).text).toBe(
      `${lead.text}\n\nThe soaps sold because you stood where people wash.\n\n${NEXT}`,
    );
  });

  it('a sentence that leaned on one left out goes with it, and our labels and loose marks go', () => {
    const before =
      'Price it from what the office pays for the same work now, and never from your own costs or hours.';
    const out = stream(`${before} That’s how you learn whether the range holds.\n\n${ANSWER}`, {
      previousReply: `${before} Then tell five of them.`,
    });
    expect(out.text).toBe(`${ANSWER}\n\n${NEXT}`);
    // With what it leans on, it stays.
    const whole = `${ANSWER} That’s the only way to see the real work.`;
    expect(stream(whole).text).toBe(`${whole}\n\n${NEXT}`);
    expect(stream(`${ANSWER}\n\nWhy: A service shows you the work before you build.\n\n1.`).text).toBe(
      `${ANSWER}\n\nA service shows you the work before you build.\n\n${NEXT}`,
    );
  });

  it('under what the server opened with, no greeting, no stage again and no second plan', () => {
    const lead = {
      text: 'You are on stage 2 of 7, talking to customers. In this order:\n\n1. Write five questions.\n2. Then: hold three talks.',
      voice: 'You are on stage 2 of 7, talking to customers.',
    };
    const guidance: PromptGuidance = { ...STEP_ONLY, lead };
    const plan =
      'Good to see you. You’re at stage two: talk to customers. Here’s a three-week plan for it.\n\nWeek 1: Pin it down.\n- Monday: Write the page.\n- Friday: Run the talk.\n\nThe first talk is the one to worry about, because it changes your questions.';
    expect(stream(plan, { guidance }).text).toBe(
      `${lead.text}\n\nThe first talk is the one to worry about, because it changes your questions.\n\n${NEXT}`,
    );
  });

  it('leaves social turns without step talk, and adds none', () => {
    expect(stream('Glad you came back. Do it by Wednesday, December 23.', { guidance: SOCIAL }).text).toBe(
      'Glad you came back.',
    );
  });

  it('still blocks another venture’s name, whoever wrote the words', () => {
    const planted: PromptGuidance = {
      ...STEP_ONLY,
      step: { ...STEP, title: 'Call the team at Zephyrine about their price' },
    };
    const out = stream('Start with people, not code: they show you the work.', {
      guidance: planted,
      otherVentureNames: ['Zephyrine'],
    });
    expect(out.gate.blocked).toBe('cross_venture');
    expect(out.text).not.toContain('Zephyrine');
  });
});

describe('a call', () => {
  const voice = { spoken: true, spokenWordBudget: SPOKEN_MAX_WORDS, maxUnitChars: 280 } as const;

  it('keeps the step’s words free, and says it when the reply ran long', () => {
    const long = Array.from(
      { length: 9 },
      (_, i) => `Point ${String(i + 1)} is about how the paid service by hand runs for companies.`,
    ).join(' ');
    const out = stream(long, voice);
    expect(out.said).toContain(SPOKEN_NEXT);
    expect(out.said.split(/\s+/).length).toBeLessThanOrEqual(65);
    expect(out.text).toContain('Your next step:');
  });

  it('says who decides and what to bring, once, with the step last', () => {
    const out = stream(
      'Assume the university may own part of it until its office says otherwise. Ownership turns on who paid for the work, whose equipment you used and what you signed. Every lab has its own rules and its own history, and a lot of teams never look at any of it.',
      { ...voice, guidance: IP_REFERRAL, founderText: 'Who owns what I made in the lab?' },
    );
    expect(out.said.match(/A qualified person decides this/g)).toHaveLength(1);
    expect(out.said).toContain('Bring the invention history page');
    expect(out.said).toMatch(/Your next step: write a one-page invention history .* by Monday\.$/);
    expect(out.said.split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_MAX_WORDS + 35);
  });

  it('answers in speech when the model only asked', () => {
    const out = stream(
      "Before we get into that, who is your customer? What's your plan for finding them?",
      voice,
    );
    expect(out.said).toBe(
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code. Your next step: list 20 office managers who run admin by hand and message 5 of them by Thursday.',
    );
    expect(out.said.split(/\s+/).length).toBeLessThanOrEqual(65);
  });
});

describe('the whole-reply validator holds the same contract', () => {
  const raw = (answer: string, spoken: string | null = null) => ({
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
    spoken,
  });
  const options = {
    evidenceKeys: new Set<string>(),
    preRisk: { categories: [] },
    otherVentureNames: [],
    otherVentureCanaries: [],
    personaName: 'Thomas',
    mentor: true,
    coverageThreshold: 0.6,
    founderText: 'Service, software, or both?',
    guidance: SERVICE_OR_PRODUCT,
    today: TODAY,
  };

  it('repairs a typed reply, notes why, and leaves a good one alone', () => {
    const out = validateCoachResponse(raw('What do you want to build? Who is it for?'), options);
    expect(out.response.answer).toContain('Both, in this order');
    expect(out.response.answer).toContain(NEXT);
    expect(out.results.notes).toEqual(
      expect.arrayContaining(['reply_contract:question_only', 'reply_contract:missing_step']),
    );
    const good = `${ANSWER}\n\n${NEXT}`;
    const kept = validateCoachResponse(raw(good), options);
    expect(kept.response.answer).toBe(good);
    expect(kept.results.notes.filter((n) => n.startsWith('reply_contract'))).toEqual([]);
  });

  it('never cuts the step or who decides from what a call says', () => {
    const out = validateCoachResponse(raw('', 'What did you use? Who paid for it? What did you sign?'), {
      ...options,
      channel: 'voice',
      guidance: IP_REFERRAL,
      founderText: 'Who owns what I made in the lab?',
    });
    expect(out.response.spoken).toContain('Bring the invention history page');
    expect(out.response.spoken).toMatch(/Your next step: write a one-page invention history .* by Monday\.$/);
    expect(out.results.notes).not.toContain('spoken_truncated');
  });

  it('keeps the step in what a call says, within its words', () => {
    const long = Array.from(
      { length: 10 },
      (_, i) => `Point ${String(i + 1)} is how a paid service by hand runs.`,
    ).join(' ');
    const out = validateCoachResponse(raw(long), { ...options, channel: 'voice' });
    expect(out.response.spoken).toContain('Your next step: list 20 office managers');
    expect((out.response.spoken ?? '').split(/\s+/).length).toBeLessThanOrEqual(65 + 20);
  });

  it('never rewrites what a call already said, nor a crisis, an identity answer or a social turn', () => {
    const asked = raw('What do you want to build?');
    expect(
      validateCoachResponse(asked, { ...options, channel: 'voice', released: true }).response.answer,
    ).toBe('What do you want to build?');
    expect(
      validateCoachResponse(asked, { ...options, preRisk: { categories: [], crisis: true } }).response.answer,
    ).not.toContain('Next:');
    expect(
      validateCoachResponse(raw('Any time.'), { ...options, founderText: 'thanks!' }).response.answer,
    ).not.toContain('Next:');
    expect(
      validateCoachResponse(raw("Yes, I'm Thomas, an AI mentor."), {
        ...options,
        founderText: 'Are you an AI?',
      }).response.answer,
    ).not.toContain('Next:');
  });

  it('keeps a path report only with the founder’s own words', () => {
    const report = {
      step: 'done' as const,
      criteria: [
        { id: 'talk-to-users', quote: 'three told me it happens weekly' },
        { id: 'pay', quote: 'they paid me' },
      ],
      quote: 'I emailed the theatre society',
    };
    const out = validateCoachResponse(
      { ...raw(`${ANSWER}\n\n${NEXT}`), path_report: report },
      { ...options, founderText: 'ok so I emailed the Theatre Society and three told me it happens weekly' },
    );
    expect(out.response.path_report).toEqual({
      step: 'done',
      quote: 'I emailed the theatre society',
      criteria: [{ id: 'talk-to-users', quote: 'three told me it happens weekly' }],
    });
    expect(out.results.notes).toContain('path_report_unverified');
    const invented = validateCoachResponse(
      { ...raw(`${ANSWER}\n\n${NEXT}`), path_report: { ...report, criteria: [] } },
      { ...options, founderText: 'I will do it tomorrow' },
    );
    expect(invented.response.path_report).toBeNull();
  });

  it('leaves out citations and claims nothing supports', () => {
    const support = buildSupportIndex({
      evidence: [
        {
          key: 'E1',
          title: 'Service first',
          excerpt: 'Run the workflow by hand as a paid service before you write software.',
        },
      ],
      founderText: options.founderText,
      guidanceText: guidanceText(SERVICE_OR_PRODUCT, TODAY),
    });
    const out = validateCoachResponse(
      raw(`${ANSWER} Techstars will fund you. Hire a designer [E1].\n\n${NEXT}`),
      {
        ...options,
        evidenceKeys: new Set(['E1']),
        support,
      },
    );
    expect(out.response.answer).toBe(`${ANSWER} Hire a designer.\n\n${NEXT}`);
    expect(out.results.notes).toEqual(
      expect.arrayContaining(['citations_unsupported:1', 'claims_removed:1']),
    );
  });
});
