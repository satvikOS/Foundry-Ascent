import { describe, expect, it } from 'vitest';

import { guidanceText, type PromptGuidance } from '../prompts/guidance.js';
import { IP_REFERRAL, SERVICE_OR_PRODUCT, SOCIAL, STEP_ONLY, TODAY, STEP } from '../testing/path-fixtures.js';
import { buildSupportIndex } from './citation-support.js';
import { validateCoachResponse } from './coach-response.js';
import { checkReplyContract } from './reply-contract.js';
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
const NEXT =
  'Next: list 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names and two calls booked.';
const SERVER_NEXT =
  'Next: List 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names written down and two calls booked.';

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
  it('leaves out a next step that is not the path’s, however it is introduced', () => {
    const out = stream(`${ANSWER} A good next step: build a landing page and collect emails.\n\n${NEXT}`);
    expect(out.text).toBe(`${ANSWER}\n\n${NEXT}`);
    expect(out.gate.trace).toMatchObject({ contractEdits: 1, rewritten: true });
  });

  it('releases a good reply unchanged, each sentence when it ends', () => {
    const reply = `${ANSWER} A service pays you while you watch the workflow.\n\n${NEXT}\n\nWhich office do you know best?`;
    const out = stream(reply);
    expect(out.text).toBe(reply);
    expect(out.gate.trace).toMatchObject({ contractEdits: 0, contractAppended: false });
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
    expect(out.text.endsWith(SERVER_NEXT)).toBe(true);
    expect(out.text).not.toMatch(/before we|your plan/i);
    expect(out.gate.trace).toMatchObject({ contractAppended: true, rewritten: true });
    expect(
      checkReplyContract({ reply: out.text, guidance: SERVICE_OR_PRODUCT, channel: 'text', today: TODAY }).ok,
    ).toBe(true);
  });

  it('moves a first-sentence question after the help and the step', () => {
    const out = stream(`Who is the office manager you know best? ${ANSWER}\n\n${NEXT}`);
    expect(out.text).toBe(`${ANSWER}\n\n${NEXT} Who is the office manager you know best?`);
  });

  it('says the step before the question that ends the reply', () => {
    const out = stream(`${ANSWER} Which office do you know best?`);
    expect(out.text).toBe(`${ANSWER}\n\n${SERVER_NEXT}\n\nWhich office do you know best?`);
  });

  it('keeps one question, the last of a stack', () => {
    const out = stream(`${ANSWER}\n\n${NEXT} Which office do you know best? And who signs there?`);
    expect(out.text).toBe(`${ANSWER}\n\n${NEXT} And who signs there?`);
  });

  it('leaves another step out, with what done meant of it, and says the path’s', () => {
    const out = stream(`${ANSWER}\n\nNext: build a landing page by Friday. Done when it is live.`);
    expect(out.text).toBe(`${ANSWER}\n\n${SERVER_NEXT}`);
  });

  it('says the path’s day', () => {
    expect(stream(`${ANSWER}\n\n${NEXT.replace('Thursday', 'Friday')}`).text).toBe(`${ANSWER}\n\n${NEXT}`);
  });

  it('never leaves the step out as something said before', () => {
    const earlier = `${ANSWER}\n\n${NEXT}`;
    const out = stream(
      `Charge the first company half up front, because a deposit shows they mean it.\n\n${NEXT}`,
      {
        guidance: STEP_ONLY,
        previousReply: earlier,
      },
    );
    expect(out.text).toContain(NEXT);
    expect(out.gate.trace.repeatsDropped).toBe(0);
    // Without the path, the same line is a repeat, as before.
    const plain = stream(
      `Charge the first company half up front, because a deposit shows they mean it.\n\n${NEXT}`,
      {
        guidance: null,
        previousReply: earlier,
      },
    );
    expect(plain.gate.trace.repeatsDropped).toBeGreaterThan(0);
  });

  it('names who decides when a qualified person must', () => {
    const out = stream(
      'Assume the university may own part of it; ownership turns on who paid for the work, whose equipment you used and what you signed.',
      { guidance: IP_REFERRAL, founderText: 'Who owns it?' },
    );
    expect(out.text).toContain('A qualified person decides this: the university technology transfer office');
    expect(out.text).toContain('Next: Write a one-page invention history');
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
      `${ANSWER.slice(0, -1)} [E1]. About 70% of startups skip this. Post about it daily [E1].\n\n${NEXT}`,
      { support, evidenceKeys: new Set(['E1']) },
    );
    expect(out.text).toBe(`${ANSWER.slice(0, -1)} [E1]. Post about it daily.\n\n${NEXT}`);
    expect(out.gate.trace.supportEdits).toBe(2);
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
    expect(out.said).toContain(
      'Your next step: list 20 office managers who run admin by hand and message 5 of them, by Thursday.',
    );
    expect(out.said.split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_MAX_WORDS + 25);
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
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code. Your next step: list 20 office managers who run admin by hand and message 5 of them, by Thursday.',
    );
    expect(out.said.split(/\s+/).length).toBeLessThanOrEqual(75);
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
    expect(out.response.answer).toContain(SERVER_NEXT);
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
    expect((out.response.spoken ?? '').split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_MAX_WORDS);
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
