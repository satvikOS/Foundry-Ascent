import { describe, expect, it } from 'vitest';

import {
  addsNothingTo,
  agreesWith,
  conversationGrounding,
  forgottenPrintOf,
  isCoachEcho,
  matchesForgotten,
  meaningSignature,
  sameMemoryContent,
  signatureCosine,
  type ForgottenPrint,
} from './memory-dedupe.js';

describe('sameMemoryContent', () => {
  it('matches the same statement however it is written, not one with another detail', () => {
    expect(sameMemoryContent('Libraries pay per room.', 'libraries pay per ROOM')).toBe(true);
    expect(
      sameMemoryContent(
        'Libraries want weekly occupancy reports for every study room during exams.',
        'Libraries want weekly occupancy reports for every study room during the exams.',
      ),
    ).toBe(true);
    expect(
      sameMemoryContent(
        'Maya will interview five library staff before Friday.',
        'Maya will interview ten library staff before Friday.',
      ),
    ).toBe(false);
    expect(sameMemoryContent('', '')).toBe(false);
  });
});

describe('addsNothingTo (a candidate restating a proposal of the same conversation)', () => {
  const turnProposal =
    'Maya asked: “I will interview five library staff about booking pain points before Friday.” ' +
    'More interviews about real past behaviour are planned.';

  it('recognises a restatement with other framing words and the founder named', () => {
    expect(
      addsNothingTo(
        'Maya plans to interview five library staff about booking pain points before Friday.',
        turnProposal,
      ),
    ).toBe(true);
    expect(
      addsNothingTo(
        'Maya plans to interview five library staff about booking pain points before Friday.',
        'The founder asked: “I will interview five library staff about booking pain points before Friday.”',
        ['Maya'],
      ),
    ).toBe(true);
  });

  it('keeps a candidate that adds a detail, a number, a negation, or is too short to tell', () => {
    expect(
      addsNothingTo(
        'Maya plans to interview ten library staff about booking pain points before Friday.',
        turnProposal,
      ),
    ).toBe(false);
    expect(
      addsNothingTo('Maya will not interview library staff about booking pain points.', turnProposal),
    ).toBe(false);
    expect(
      addsNothingTo(
        'Maya plans to interview five library staff about booking pain points before Friday and pay them.',
        turnProposal,
      ),
    ).toBe(false);
    expect(addsNothingTo('Maya plans interviews.', turnProposal)).toBe(false);
  });
});

describe('isCoachEcho (the coach’s own advice is never kept as a fact about the venture)', () => {
  // Production, call 2: the founder's short replies, and the same advice in every answer.
  const call = conversationGrounding([
    {
      founder: 'Could you help with that?',
      answer:
        'The regulatory pathway is not yet determined. Book the advisor to settle classification first.',
    },
    { founder: 'hmm, maybe', answer: 'Book the advisor meeting before you spend on the redesign.' },
  ]);

  it('drops advice nothing of which came from the founder, citing the venture’s records or not', () => {
    expect(
      isCoachEcho(
        {
          title: 'Regulatory pathway not yet determined',
          content: 'The regulatory pathway is not yet determined.',
        },
        call,
      ),
    ).toBe(true);
    expect(
      isCoachEcho(
        { title: 'Advisor meeting', content: 'Book the advisor meeting to settle classification.' },
        call,
      ),
    ).toBe(true);
  });

  it('drops advice that only shares a topic word with what the founder said (review E1)', () => {
    const pricing = conversationGrounding([
      {
        founder: 'We are weighing per-library pricing for the pilot.',
        answer: 'Book the regulatory advisor before the pilot to settle classification and reimbursement.',
      },
    ]);
    expect(
      isCoachEcho(
        {
          title: 'Regulatory advisor before the pilot',
          content: 'Book the regulatory advisor before the pilot to settle classification and reimbursement.',
        },
        pricing,
      ),
    ).toBe(true);
    // The founder's own words in it are kept.
    expect(
      isCoachEcho(
        { title: 'Pilot pricing', content: 'The team is weighing per-library pricing for the pilot.' },
        pricing,
      ),
    ).toBe(false);
  });

  it('never reads a bare "sure", "ok" or a "right, but…" as agreeing to the advice (review E2, E3)', () => {
    const advice = 'Hire a regulatory consultant to map the classification before the pilot.';
    const note = {
      title: 'Regulatory consultant',
      content: 'Hire a regulatory consultant to map the classification before the pilot.',
    };
    for (const reply of [
      'sure',
      'ok',
      'Yes.',
      'Right, but we can’t afford a consultant.',
      'Okay but not yet',
    ]) {
      const grounding = conversationGrounding([
        { founder: 'What about the classification?', answer: advice },
        { founder: reply, answer: 'Understood.' },
      ]);
      expect(grounding.agreed, reply).toEqual([]);
      expect(isCoachEcho(note, grounding), reply).toBe(true);
    }
    expect(agreesWith('Sounds good, let’s do that.')).toBe(true);
    expect(agreesWith('Yes, let’s do it')).toBe(true);
    expect(agreesWith('I’ll book it this week.')).toBe(true);
    expect(agreesWith('Good idea, but later.')).toBe(false);
  });

  it('keeps the founder’s goal however the model words it (review E4: the production goal missed twice)', () => {
    const money = conversationGrounding([
      {
        founder: 'Honestly I just want to make a lot of money fast from this.',
        answer: 'That is a fair goal. What would make the pilot worth paying for?',
      },
    ]);
    const paraphrase = {
      title: 'Personal financial goal',
      content: 'The founder hopes to become wealthy quickly through the company.',
    };
    // Labelled by the model, it is the founder's whatever the words.
    expect(isCoachEcho(paraphrase, money, { source: 'founder_stated' })).toBe(false);
    // Unlabelled, a statement of what the founder wants is still theirs.
    expect(isCoachEcho(paraphrase, money)).toBe(false);
    expect(
      isCoachEcho(
        { title: 'Personal goal', content: 'Maya wants the startup to make her rich quickly.' },
        money,
        { speakers: ['Maya'] },
      ),
    ).toBe(false);
  });

  it('follows the model’s label, and checks the ones it can', () => {
    const note = { title: 'Weekly reports', content: 'Libraries receive weekly occupancy reports.' };
    const said = conversationGrounding([
      { founder: 'Libraries told us they want weekly occupancy reports.', answer: 'Good, that is a signal.' },
    ]);
    expect(isCoachEcho(note, said, { source: 'coach_advice' })).toBe(true);
    expect(isCoachEcho(note, said, { source: 'founder_stated' })).toBe(false);
    // "Agreed" needs an answer the founder explicitly took up, or the founder's own words.
    const proposed = conversationGrounding([
      { founder: 'How do we prove value?', answer: 'Send libraries weekly occupancy reports for a month.' },
      { founder: 'Sounds good, let’s do that.', answer: 'Great.' },
    ]);
    const unagreed = conversationGrounding([
      { founder: 'How do we prove value?', answer: 'Send libraries weekly occupancy reports for a month.' },
      { founder: 'sure', answer: 'Great.' },
    ]);
    const plan = {
      title: 'Occupancy reports',
      content: 'The team sends libraries monthly occupancy reports.',
    };
    expect(isCoachEcho(plan, proposed, { source: 'founder_agreed' })).toBe(false);
    expect(isCoachEcho(plan, unagreed, { source: 'founder_agreed' })).toBe(true);
    // Advice mislabelled as the founder's, with nothing of theirs in it, is still the coach's.
    expect(
      isCoachEcho({ title: 'Advisor', content: 'Book the advisor meeting to settle classification.' }, call, {
        source: 'founder_stated',
      }),
    ).toBe(true);
  });

  it('keeps advice the founder agreed to, and anything too short to judge', () => {
    const agreed = conversationGrounding([
      {
        founder: 'What should we do first?',
        answer: 'Run a two-week door-counter test in the main library.',
      },
      { founder: 'Sounds good, let’s do that.', answer: 'Great. Pick the start date.' },
    ]);
    expect(
      isCoachEcho(
        { title: 'Door-counter test', content: 'A two-week door-counter test runs in the main library.' },
        agreed,
      ),
    ).toBe(false);
    expect(agreed.agreed).toEqual(['Run a two-week door-counter test in the main library.']);
    expect(isCoachEcho({ title: 'Advisor', content: 'Advisor.' }, call)).toBe(false);
  });
});

/** A unit vector in 1 024 dimensions from a seed (deterministic). */
function unitVector(seed: number, dim = 1024): number[] {
  let a = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    out.push((a / 4294967296) * 2 - 1);
  }
  const norm = Math.sqrt(out.reduce((n, v) => n + v * v, 0));
  return out.map((v) => v / norm);
}

/** `a` turned towards `b` until their cosine is `cos` (both unit vectors). */
function towards(a: readonly number[], b: readonly number[], cos: number): number[] {
  const dot = a.reduce((n, v, i) => n + v * (b[i] ?? 0), 0);
  const ortho = b.map((v, i) => v - dot * (a[i] ?? 0));
  const norm = Math.sqrt(ortho.reduce((n, v) => n + v * v, 0));
  const sin = Math.sqrt(1 - cos * cos);
  return a.map((v, i) => cos * v + (sin * (ortho[i] ?? 0)) / norm);
}

describe('meaningSignature (what a forgotten item is remembered by)', () => {
  it('estimates the cosine of two embeddings without keeping them', () => {
    const a = unitVector(1);
    const signature = meaningSignature(a);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(meaningSignature(a)).toBe(signature);
    expect(signatureCosine(signature, signature)).toBe(1);
    for (const cos of [0.95, 0.9]) {
      const near = signatureCosine(signature, meaningSignature(towards(a, unitVector(7), cos)));
      expect(Math.abs(near - cos)).toBeLessThan(0.08);
    }
    // Unrelated texts are far apart.
    expect(signatureCosine(signature, meaningSignature(unitVector(2)))).toBeLessThan(0.5);
    expect(signatureCosine(signature, 'zz')).toBe(-1);
  });
});

describe('matchesForgotten (forgetting an item is never undone by the same conversation)', () => {
  const goal = {
    type: 'preference',
    title: 'Personal goal',
    content: 'Maya wants the startup to make her rich quickly.',
  };
  const vector = unitVector(11);
  const print = (embedding: readonly number[] | null, sessionId = 'conversation-1'): ForgottenPrint => ({
    sessionId,
    ...forgottenPrintOf(goal, embedding),
  });

  it('matches the same words anywhere, and the same title from the same conversation', () => {
    expect(matchesForgotten(goal, null, 'conversation-2', [print(null)])).toBe(true);
    const retitled = { ...goal, content: 'Getting rich quickly is what Maya wants from the startup.' };
    expect(matchesForgotten(retitled, null, 'conversation-1', [print(null)])).toBe(true);
    expect(matchesForgotten(retitled, null, 'conversation-2', [print(null)])).toBe(false);
    expect(matchesForgotten(goal, null, 'conversation-1', [])).toBe(false);
  });

  it('matches a paraphrase by meaning: closely from the same conversation, near-exactly from another', () => {
    const paraphrase = {
      type: 'insight',
      title: 'Financial goal',
      content: 'The founder hopes to become wealthy fast.',
    };
    const close = towards(vector, unitVector(12), 0.9);
    expect(matchesForgotten(paraphrase, close, 'conversation-1', [print(vector)])).toBe(true);
    expect(matchesForgotten(paraphrase, close, 'conversation-2', [print(vector)])).toBe(false);
    const nearExact = towards(vector, unitVector(12), 0.98);
    expect(matchesForgotten(paraphrase, nearExact, 'conversation-2', [print(vector)])).toBe(true);
    // A different number is a different fact, however close the meaning.
    const priced = { ...paraphrase, content: 'The founder hopes to make 5 million fast.' };
    expect(matchesForgotten(priced, nearExact, 'conversation-1', [print(vector)])).toBe(false);
    expect(matchesForgotten(paraphrase, unitVector(13), 'conversation-1', [print(vector)])).toBe(false);
  });
});
