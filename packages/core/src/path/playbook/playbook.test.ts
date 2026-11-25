import { classifyRisk } from '@foundry/ai';
import {
  EscalationCategory,
  PathCriterion,
  Play,
  PlaySource,
  RequestedRole,
  VentureStage,
} from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { PLAYBOOK, PLAYBOOK_VERSION } from './index.js';
import { CRITERION_COUNTED } from './phrases.js';
import {
  CLIENT_QUESTIONS,
  HELD_OUT_ASKS,
  NEAR_MISSES,
  PARAPHRASES,
  PROTOCOL_ASKS,
  SHORT_ASKS,
} from './test-fixtures.js';
import { decide } from '../engine.js';
import { phraseIntent } from '../match.js';
import { topicOf } from '../state.js';
import { fresh, input } from '../testing/inputs.js';

const { plays, criteria, intents, sources, stages } = PLAYBOOK;
const playIds = new Set(plays.map((p) => p.id));
const criterionIds = new Set(criteria.map((c) => c.id));
const intentIds = new Set(intents.map((i) => i.id));
const sourceIds = new Set(sources.map((s) => s.id));
const playOf = new Map(plays.map((p) => [p.id, p]));

/** Every text of a play a founder may read or hear. */
const textsOf = (p: Play): string[] => [
  p.title,
  p.answer,
  p.why,
  ...p.steps.flatMap((s) => [s.do, s.how]),
  p.doneWhen,
  ...(p.template === null ? [] : [p.template.title, p.template.body]),
  ...p.traps,
  ...(p.referral === null ? [] : [p.referral.who, p.referral.bring]),
];
const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const duplicates = (ids: readonly string[]): string[] => ids.filter((id, i) => ids.indexOf(id) !== i);

describe('playbook: the contract', () => {
  it('parses every play, criterion and source', () => {
    for (const play of plays) expect(Play.safeParse(play).error, play.id).toBeUndefined();
    for (const c of criteria) expect(PathCriterion.safeParse(c).error, c.id).toBeUndefined();
    for (const s of sources) expect(PlaySource.safeParse(s).error, s.id).toBeUndefined();
  });

  it('has a version, seven stages in order and at least 70 plays', () => {
    expect(PLAYBOOK.version).toBe(PLAYBOOK_VERSION);
    expect(stages.map((s) => s.stage)).toEqual(VentureStage.options);
    expect(plays.length).toBeGreaterThanOrEqual(70);
  });

  it('gives every play, criterion, intent and source its own id', () => {
    for (const list of [plays, criteria, intents, sources]) {
      expect(duplicates(list.map((x) => x.id))).toEqual([]);
    }
    expect(duplicates(plays.map((p) => p.title))).toEqual([]);
  });

  it('resolves every reference', () => {
    for (const p of plays) {
      for (const id of p.next) expect(playIds, `${p.id} next`).toContain(id);
      expect(p.next, p.id).not.toContain(p.id);
      for (const id of p.criteria) expect(criterionIds, `${p.id} criteria`).toContain(id);
      for (const id of p.intents) expect(intentIds, `${p.id} intents`).toContain(id);
      for (const c of p.citations) expect(sourceIds, `${p.id} citations`).toContain(c.sourceId);
    }
    for (const c of criteria) {
      const play = playOf.get(c.playId);
      expect(play, c.id).toBeDefined();
      expect(play?.criteria, `${c.playId} produces ${c.id}`).toContain(c.id);
      expect(play?.stage, `${c.id} is tied to a play of its own stage`).toBe(c.stage);
    }
    for (const i of intents) {
      expect(playOf.get(i.playId)?.intents, `${i.playId} answers ${i.id}`).toContain(i.id);
    }
    const cited = new Set(plays.flatMap((p) => p.citations.map((c) => c.sourceId)));
    expect(sources.filter((s) => !cited.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  it('answers every play with at least one intent and cites at least one source', () => {
    for (const p of plays) {
      expect(p.intents.length, p.id).toBeGreaterThan(0);
      expect(p.citations.length, p.id).toBeGreaterThan(0);
    }
  });

  it('ties two to four criteria to each stage, each to its own play', () => {
    for (const { stage } of stages) {
      const own = criteria.filter((c) => c.stage === stage);
      expect(own.length, stage).toBeGreaterThanOrEqual(2);
      expect(own.length, stage).toBeLessThanOrEqual(4);
    }
    expect(duplicates(criteria.map((c) => c.playId))).toEqual([]);
  });

  it('holds the three Ain capstones as criteria', () => {
    expect(criteria.map((c) => c.playId)).toEqual(
      expect.arrayContaining(['ain-canvas-capstone', 'ain-pitch-capstone', 'ain-plan-capstone']),
    );
  });

  it('reaches every stage and every play from the first one', () => {
    const seen = new Set(['get-organized']);
    const queue = ['get-organized'];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const next of playOf.get(id)?.next ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    const reached = new Set([...seen].map((id) => playOf.get(id)?.stage));
    for (const { stage } of stages) expect(reached, stage).toContain(stage);
    // The rest are answers to an ask (their intent leads to them), not steps of the path.
    const pathPlays = criteria.map((c) => c.playId).filter((id) => !seen.has(id));
    expect(pathPlays).toEqual([]);
  });
});

describe('playbook: how it sounds', () => {
  it('says nothing it must never say', () => {
    const banned =
      /guarantee|will succeed|riskiest assumption|cheapest test|game[- ]changer|crush it|\bdelve\b|\bleverage\b|as an ai\b/i;
    for (const p of plays) for (const t of textsOf(p)) expect(t, p.id).not.toMatch(banned);
    for (const c of criteria) expect(`${c.title} ${c.evidence}`, c.id).not.toMatch(banned);
    for (const s of stages) expect(`${s.title} ${s.goal}`, s.stage).not.toMatch(banned);
  });

  it('is plain ASCII, with no emoji and no dashes for pauses', () => {
    for (const p of plays) {
      for (const t of textsOf(p)) {
        // eslint-disable-next-line no-control-regex
        expect(t, p.id).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
        expect(t, p.id).not.toMatch(/ -- /);
      }
    }
  });

  it('decides first: an answer never opens with a question or "it depends"', () => {
    for (const p of plays) {
      const first = sentences(p.answer)[0] ?? '';
      expect(first, p.id).not.toMatch(/\?$/);
      expect(p.answer, p.id).not.toMatch(
        /^(?:well|it depends|that depends|before we|before you|great question)/i,
      );
      expect(p.answer, p.id).not.toMatch(/\bbefore we\b/i);
    }
  });

  it('reads aloud: no signs, lists or links in an answer or a why', () => {
    for (const p of plays) {
      for (const t of [p.answer, p.why]) expect(t, p.id).not.toMatch(/[/=|*#[\]()<>_]|\n|https?:/);
    }
  });

  it('speaks to the founder', () => {
    for (const p of plays) expect(p.answer, p.id).toMatch(/\b(?:you|your|yours)\b/i);
  });

  it('uses short sentences', () => {
    for (const p of plays) {
      for (const t of [p.answer, p.why]) {
        const list = sentences(t);
        for (const s of list) expect(wordCount(s), `${p.id}: ${s}`).toBeLessThanOrEqual(34);
        expect(wordCount(t) / list.length, p.id).toBeLessThanOrEqual(18);
      }
      for (const s of p.steps)
        for (const line of sentences(s.how)) expect(wordCount(line), p.id).toBeLessThanOrEqual(30);
    }
  });

  it('is easy to read (Flesch-Kincaid grade 8 or lower, per answer)', () => {
    const syllables = (word: string): number => {
      const w = word.toLowerCase().replace(/[^a-z]/g, '');
      if (w.length <= 3) return w.length === 0 ? 0 : 1;
      return Math.max(
        1,
        (w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g) ?? []).length,
      );
    };
    for (const p of plays) {
      const ws = p.answer.split(/\s+/);
      const grade =
        0.39 * (ws.length / sentences(p.answer).length) +
        11.8 * (ws.reduce((n, w) => n + syllables(w), 0) / ws.length) -
        15.59;
      expect(grade, p.id).toBeLessThanOrEqual(8);
    }
  });

  it('names each step as an action that reads after "Next:" and before its day', () => {
    const verbs =
      /^(?:Answer|Ask|Book|Build|Call|Choose|Compare|Count|Do|Fill|Find|Get|Give|Have|Help|Hold|Launch|List|Make|Match|Meet|Name|Offer|Open|Put|Rewrite|Run|Score|Secure|Sell|Send|Serve|Set|Start|Submit|Test|Try|Win|Work out|Write)\b/;
    for (const p of plays) {
      expect(p.title, p.id).toMatch(verbs);
      expect(p.title.length, p.id).toBeLessThanOrEqual(70);
      // "…: stop or go on by Friday", "… before you build by Friday" and "…, not friends by Friday" do not read.
      expect(p.title, p.id).not.toMatch(/[:;?!.]$|:|\bbefore\b|, not [^,]*$|\bthis (?:month|week)\b/);
      // Something to see at the end of it, never a state of mind.
      expect(p.title, p.id).not.toMatch(
        /^(?:Know|Understand|Learn|Think|Get organi|Get unstuck|Prepare|Plan|Start the path|Check rivals|Handle|Sort out|See)\b/,
      );
      expect(p.title, p.id).not.toMatch(
        /\b(?:beachhead|persona|unit economics|value proposition|wizard of oz|concierge|bottom[- ]up|runway|validate|leverage)\b/i,
      );
      expect(p.doneWhen, p.id).not.toMatch(/\bexists?\b/);
    }
  });

  it('names what each counted criterion is a number of, after "2 of the 5"', () => {
    for (const c of criteria) {
      if (topicOf(c)?.counted !== true) continue;
      expect(CRITERION_COUNTED[c.id], c.id).toMatch(/^[a-z][a-z ]*s\b/);
    }
  });

  it('writes each step as an instruction, and something checkable at the end', () => {
    for (const p of plays) {
      for (const s of p.steps) {
        expect(s.do, p.id).toMatch(/^[A-Z][a-z]+/);
        expect(s.do, p.id).not.toMatch(/[.?!]$/);
        expect(s.do, p.id).not.toMatch(/^(?:You|We|It|There|The|A|An)\b/);
        expect(s.how.length, p.id).toBeGreaterThan(0);
        expect(s.minutes, p.id).not.toBeNull();
      }
      expect(p.doneWhen, p.id).toMatch(/\.$/);
      // Nothing a student with classes cannot fit in: at most 15 hours of work for one play.
      expect(
        p.steps.reduce((n, s) => n + (s.minutes ?? 0), 0),
        p.id,
      ).toBeLessThanOrEqual(900);
    }
  });

  it("leaves the founder's own details in brackets", () => {
    for (const p of plays) {
      if (p.template !== null) expect(p.template.body, p.id).toMatch(/\[[^\]]+\]/);
    }
  });
});

describe('playbook: nothing invented', () => {
  it('states no price, percentage, statistic or market figure', () => {
    // Whitelist: figures of a cited government page or of the programme. Empty today, and it should stay short.
    const allowed: readonly RegExp[] = [];
    const figure =
      /[$€£]\s?\d|\d[\d,.]*\s?(?:%|percent\b|per cent\b)|\b\d[\d,.]*\s?(?:k|m|bn|million|billion|thousand|dollars?|cents|bucks|usd)\b|\b(?:most|half|majority|nine out of ten) (?:of )?startups\b|\bstudies show\b|\bresearch shows\b|\bon average\b/i;
    for (const p of plays) {
      for (const t of textsOf(p)) {
        const left = allowed.reduce((s, re) => s.replace(re, ''), t);
        expect(left, p.id).not.toMatch(figure);
      }
    }
    for (const c of criteria) expect(`${c.title} ${c.evidence}`, c.id).not.toMatch(figure);
  });

  it('names a legal or immigration term in numbers only from a cited government page', () => {
    const legal = /\b\d+[- ]months?\b|\bone[- ]year clock\b|\b\d+ days\b/i;
    const withFigure = plays.filter((p) => p.referral !== null && legal.test(p.answer));
    for (const p of withFigure) {
      const kinds = p.citations.map((c) => sources.find((s) => s.id === c.sourceId)?.kind);
      expect(kinds, p.id).toContain('government');
    }
    expect(withFigure.map((p) => p.id)).toContain('patent-now-or-wait');
  });

  it('cites the programme by module and unit, never by who recorded it', () => {
    const programme = plays.flatMap((p) => p.citations).filter((c) => c.sourceId === 'ain-foundry');
    expect(programme.length).toBeGreaterThan(30);
    const topics =
      /^Module [123], Unit [12]: (?:Entrepreneurial Mindset, Part I{1,2}|Customer vs\. User|Business Model(?: Canvas)?|Legal Structure|Customer Discovery|The Pitch|Fundraising|Bootstrapping|Networking I{1,2})$/;
    for (const c of programme) expect(c.locator).toMatch(topics);
  });

  it('cites a book by author and year, with a public page', () => {
    for (const s of sources) {
      expect(s.url, s.id).not.toBeNull();
      expect(s.url, s.id).not.toMatch(/z-?lib|libgen|scribd|\.pdf$/i);
      if (s.kind === 'book') {
        expect(s.year, s.id).not.toBeNull();
        expect(s.authors.length, s.id).toBeGreaterThan(3);
      }
    }
  });
});

describe('playbook: referrals', () => {
  it('names a valid category, role, person and what to bring', () => {
    for (const p of plays) {
      if (p.referral === null) continue;
      expect(EscalationCategory.options, p.id).toContain(p.referral.category);
      expect(RequestedRole.options, p.id).toContain(p.referral.role);
      expect(p.referral.who.length, p.id).toBeGreaterThan(10);
      expect(p.referral.bring.length, p.id).toBeGreaterThan(20);
    }
  });

  it('sends every referral-required ask to a play with a referral that says the coach cannot decide', () => {
    const required = intents.filter((i) => i.referral === true);
    expect(required.length).toBeGreaterThanOrEqual(12);
    for (const i of required) {
      const play = playOf.get(i.playId);
      expect(play?.referral, i.id).not.toBeNull();
      expect(play?.answer, i.id).toMatch(
        /not a lawyer|not legal advice|cannot (?:tell|advise|give|choose)|not regulatory advice|lawyer|orientation|accountant/i,
      );
    }
  });

  it.each([
    ['valuation', 'securities_investment'],
    ['term-sheet', 'securities_investment'],
    ['friends-family-money', 'securities_investment'],
    ['student-ip', 'ip_licensing'],
    ['patent-now-or-wait', 'ip_licensing'],
    ['equity-split', 'legal'],
    ['cofounder-agreement', 'legal'],
    ['legal-structure', 'legal'],
    ['contracts-and-insurance', 'legal'],
    ['taxes', 'legal'],
    ['international-student', 'legal'],
    ['permits-food', 'legal'],
    ['regulated-data', 'legal'],
    ['biotech-path', 'medical_regulatory'],
    ['medical-rules', 'medical_regulatory'],
  ])('%s is referred (%s)', (id, category) => {
    expect(playOf.get(id)?.referral?.category).toBe(category);
  });
});

describe('playbook: intents', () => {
  const normal = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const isAsk = (i: (typeof intents)[number]): boolean => i.note !== true;
  // The phrases alone: what decides before meaning is asked.
  const match = (ask: string) => phraseIntent(PLAYBOOK, ask, isAsk);
  const playFor = (ask: string): string | null => match(ask)?.intent.playId ?? null;
  /** A first message when its meaning could not be asked: phrases, the risk rules, and the nearest words. */
  const decided = (ask: string) =>
    decide(
      input(
        ask,
        fresh({
          playbook: PLAYBOOK,
          near: 'unavailable',
          riskCategories: classifyRisk(ask).categories,
        }),
      ),
    );
  const playWithout = (ask: string): string | null => {
    const id = decided(ask).intent;
    return intents.find((i) => i.id === id)?.playId ?? null;
  };
  const shares = (asks: readonly (readonly [string, string])[]) => {
    const got = asks.map(([ask, play]) => [playWithout(ask), play] as const);
    return {
      right: got.filter(([found, play]) => found === play).length / asks.length,
      wrong: got.filter(([found, play]) => found !== null && found !== play).length / asks.length,
    };
  };

  it('has 8 to 40 phrases each, none of them in two intents', () => {
    for (const i of intents) {
      expect(i.phrases.length, i.id).toBeGreaterThanOrEqual(8);
      expect(i.phrases.length, i.id).toBeLessThanOrEqual(40);
    }
    expect(duplicates(intents.flatMap((i) => i.phrases.map(normal)))).toEqual([]);
  });

  it('answers each phrase with its own play', () => {
    const wrong = intents.flatMap((i) =>
      i.phrases
        .map((p) => p.replace(/\.\.\./g, 'it'))
        .filter(
          (p) =>
            (i.note === true ? phraseIntent(PLAYBOOK, p, (x) => x.note === true) : match(p))?.intent
              .playId !== i.playId,
        )
        .map((p) => `${i.id}: ${p} -> ${match(p)?.intent.id ?? 'none'}`),
    );
    expect(wrong).toEqual([]);
  });

  it("answers the client's 20 questions by a phrase, whatever the embedding says", () => {
    expect(CLIENT_QUESTIONS).toHaveLength(20);
    // What changed with a pivot is recalled from the record, not a play's to answer.
    const recalled = CLIENT_QUESTIONS.filter(([, play]) => play === 'after-a-pivot');
    const asked = CLIENT_QUESTIONS.filter(([, play]) => play !== 'after-a-pivot');
    expect(recalled).toHaveLength(1);
    expect(asked.map(([ask]) => [ask, playFor(ask)])).toEqual(asked);
  });

  it('answers the protocol and the live-test messages by a phrase or a rule', () => {
    for (const [ask, play] of PROTOCOL_ASKS) {
      const d = decided(ask);
      expect([d.matched, d.overview ? 'overview' : d.play?.id], ask).toEqual([
        d.intent === 'overview' ? 'rule' : 'phrase',
        play === 'get-organized' || play === 'start-from-zero' ? 'overview' : play,
      ]);
    }
  });

  it.each([
    ['paraphrases', PARAPHRASES, 0.6],
    ['short and spoken asks', SHORT_ASKS, 0.5],
    ['held-out asks', HELD_OUT_ASKS, 0.3],
  ] as const)('without meaning, answers %s seldom wrongly, and about half of them', (_, asks, least) => {
    const { right, wrong } = shares(asks);
    expect(right).toBeGreaterThanOrEqual(least);
    expect(wrong).toBeLessThanOrEqual(0.02);
  });

  it('keeps the asks of the tests out of the phrases', () => {
    const phrases = new Set(intents.flatMap((i) => i.phrases.map(normal)));
    const copied = [...PARAPHRASES, ...SHORT_ASKS, ...HELD_OUT_ASKS].filter(([ask]) =>
      phrases.has(normal(ask)),
    );
    expect(copied).toEqual([]);
  });

  it('names who decides without meaning: a phrase or a risk, for all but a few of the asks that need a person', () => {
    const required = new Set(intents.filter((i) => i.referral === true).map((i) => i.playId));
    const lost = [...CLIENT_QUESTIONS, ...PROTOCOL_ASKS, ...PARAPHRASES, ...SHORT_ASKS, ...HELD_OUT_ASKS]
      .filter(([, play]) => required.has(play))
      .filter(([ask, play]) => decided(ask).referral?.category !== playOf.get(play)?.referral?.category);
    expect(lost.length).toBeLessThanOrEqual(2);
  });

  it('leaves a near-miss to another intent', () => {
    expect(NEAR_MISSES.filter(([ask, play]) => playWithout(ask) === play)).toEqual([]);
  });

  it('covers every play by a held-out ask', () => {
    const asked = new Set(
      [...CLIENT_QUESTIONS, ...PROTOCOL_ASKS, ...PARAPHRASES, ...SHORT_ASKS].map(([, play]) => play),
    );
    expect(plays.map((p) => p.id).filter((id) => !asked.has(id))).toEqual([]);
  });
});
