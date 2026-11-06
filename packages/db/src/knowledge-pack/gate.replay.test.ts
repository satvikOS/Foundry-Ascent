import { describe, expect, it } from 'vitest';

import { EXCERPT_CHARS } from '../repositories/common.js';
import { asks, gateTokens, isCommonEnglish, selectReferences, vocabularyKeys } from './gate.js';
import { EVERYDAY_LINES, GENUINE_LINES } from './gate-replay.fixture.js';
import { knowledgePackEvalQuestions, loadKnowledgePack } from './pack.js';
import { packItems } from './render.js';
import { REFERENCE_VOCABULARY } from './vocabulary.js';

/*
 * The reference gate replayed on student lines (`gate-replay.fixture.ts`, written for this test in the style of a
 * pilot's real student turns; no transcript text). The coaching diagnosis (C1) traced fixation to library notes on
 * almost every turn: an everyday line must retrieve nothing, a genuine framework, case or stage question the item
 * it asks about.
 */

const pack = loadKnowledgePack();
const items = packItems(pack);
const TEXT = { limit: 2 } as const;

function keys(text: string, limit = 2): string[] {
  return selectReferences(text, { limit }).matches.map((m) => m.key);
}

describe('replay: everyday and genuine student lines', () => {
  it('has enough lines of each kind to measure a rate', () => {
    expect(EVERYDAY_LINES.length).toBeGreaterThanOrEqual(100);
    expect(GENUINE_LINES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(EVERYDAY_LINES).size).toBe(EVERYDAY_LINES.length);
  });

  it('at most 5 % of everyday or unrelated lines retrieve anything', () => {
    const retrieving = EVERYDAY_LINES.filter((line) => keys(line).length > 0);
    // The measured rate (2 of 129 when written: "growth stage investors", "activation rate in Mixpanel").
    expect(retrieving.length / EVERYDAY_LINES.length).toBeLessThanOrEqual(0.05);
  });

  it('at least 90 % of genuine framework, case and stage questions retrieve the item they ask about', () => {
    const right = GENUINE_LINES.filter((g) => keys(g.text).includes(g.key));
    expect(right.length / GENUINE_LINES.length).toBeGreaterThanOrEqual(0.9);
  });

  it('a genuine question retrieves the item it asks about first, and one item unless it asks for several', () => {
    for (const g of GENUINE_LINES) {
      const found = keys(g.text);
      if (found.length === 0) continue;
      expect(found[0], g.text).toBe(g.key);
    }
    expect(keys('What is design thinking?')).toEqual(['framework/F05']);
    expect(keys('How do I calculate CAC and payback for my subscription box?')).toEqual(['framework/F09']);
  });

  it('covers every framework, case and stage of the library with at least one genuine line', () => {
    expect(new Set(GENUINE_LINES.map((g) => g.key))).toEqual(new Set(items.map((i) => i.key)));
  });
});

describe('the pack’s rag_eval_questions', () => {
  const ragDocOf = new Map(items.filter((i) => i.ragDocId !== null).map((i) => [i.key, i.ragDocId ?? '']));

  it('Q01–Q04: the gate admits every expected document', () => {
    for (const q of knowledgePackEvalQuestions().filter((x) => x.expected_doc_ids.length > 0)) {
      const docs = keys(q.question).map((k) => ragDocOf.get(k));
      expect(docs, q.question_id).toEqual(expect.arrayContaining([...q.expected_doc_ids]));
    }
  });

  it('Q05 (abstention): only the case whose documented account states the gap, its limits first', () => {
    const q = knowledgePackEvalQuestions().find((x) => x.question_id === 'Q05');
    if (!q) throw new Error('Q05 missing');
    expect(q.expected_doc_ids).toEqual([]);
    const found = keys(q.question);
    expect(found[0]).toBe('case/SC01');
    // Nothing admitted reports an interview-to-sale conversion figure.
    for (const key of found) {
      const item = items.find((i) => i.key === key);
      for (const passage of item?.passages ?? []) {
        expect(passage.content).not.toMatch(/conversion rate/i);
      }
    }
    // The account the coach reads opens with what it does not establish: the grounded answer abstains.
    const account = items.find((i) => i.key === 'case/SC01')?.passages[0];
    expect(account?.epistemic).toBe('documented_account');
    expect(account?.content.slice(0, EXCERPT_CHARS - 1)).toMatch(
      /^Evidence limits: .*does not name that beachhead or disclose interview-to-sale conversion/,
    );
  });
});

describe('what the gate reads', () => {
  it('a company whose name is everyday English counts only when the company is meant', () => {
    expect(keys('Grove Street has cheaper rent, should we move there?')).toEqual([]);
    expect(keys('What did the Grove founders learn from early users?')).toEqual(['case/SC11']);
    expect(keys('Let us embrace change in the team this quarter.')).toEqual([]);
    expect(keys('How did Embrace fund its infant warmer?')).toEqual(['case/SC23']);
    expect(keys('I put the deck on Dropbox, can you look at it?')).toEqual([]);
    expect(keys('How did Dropbox grow?')).toEqual(['case/SC15']);
  });

  it('a case only by its company’s full name or a short form that is not everyday English', () => {
    expect(keys('Quincy is where my parents live, so I can store inventory there.')).toEqual([]);
    expect(keys('What happened with Quincy Apparel?')).toEqual(['case/SC17']);
    expect(keys('what happened with quincy apparel')).toEqual(['case/SC17']);
    // A name inside another word is not the name.
    expect(keys('How did Baroos grow?')).toEqual([]);
  });

  it('a framework term in a statement is the founder’s evidence, not a question about the method', () => {
    expect(keys('Our CAC went up to $40 this month.')).toEqual([]);
    expect(keys('Our CAC went up to $40 this month. Is that bad for a meal kit?')).toEqual([]);
    expect(keys('Our CAC went up to $40 this month, is that bad?')).toEqual(['framework/F09']);
    expect(keys('We launched our MVP last week and 20 people signed up.')).toEqual([]);
  });

  it('a question about the program itself draws on the program only', () => {
    expect(selectReferences('What are the program stage gates to leave validation?', TEXT)).toEqual({
      matches: [],
      reason: 'program',
    });
    expect(keys('Does the Ain curriculum cover customer discovery?')).toEqual([]);
  });

  it('one item per turn unless the founder asks for several or names several', () => {
    expect(keys('How did NONA use customer discovery interviews to choose a market?')).toEqual([
      'case/SC01',
      'framework/F04',
    ]);
    expect(keys('How did NONA use customer discovery interviews to choose a market?', 1)).toEqual([
      'case/SC01',
    ]);
    expect(keys('Any examples of companies doing pet care or dog walking?')).toEqual(['case/SC19']);
    expect(keys('Can you compare the lean canvas with design thinking?')).toEqual([
      'framework/F02',
      'framework/F05',
    ]);
    expect(selectReferences('What is design thinking?', { limit: 0 }).matches).toEqual([]);
  });

  it('reads sentences and words as a founder writes them', () => {
    expect(gateTokens('Warby Parker’s home try-on, TAM/SAM')).toEqual([
      'warby',
      'parker',
      'home',
      'try',
      'on',
      'tam',
      'sam',
    ]);
    expect(asks('how do i size the market')).toBe(true);
    expect(asks('We did five customer interviews last week.')).toBe(false);
    expect(asks('Explain the lean canvas.')).toBe(true);
  });
});

describe('the curated vocabulary', () => {
  const common = (text: string) => {
    const words = gateTokens(text);
    return words.length === 1 && isCommonEnglish(words[0] ?? '');
  };

  it('names every item of the library and nothing else', () => {
    expect(new Set(vocabularyKeys())).toEqual(new Set(items.map((i) => i.key)));
  });

  it('never lets one everyday English word name an item', () => {
    const offenders: string[] = [];
    for (const [key, vocab] of Object.entries(REFERENCE_VOCABULARY)) {
      for (const term of vocab.terms ?? []) if (common(term)) offenders.push(`${key} term ${term}`);
      for (const name of vocab.names ?? []) {
        if (vocab.everyday !== true && gateTokens(name).every((w) => isCommonEnglish(w))) {
          offenders.push(`${key} name ${name}`);
        }
      }
      for (const acronym of vocab.acronyms ?? []) {
        if (isCommonEnglish(acronym) && !(vocab.caseSensitive ?? []).includes(acronym)) {
          offenders.push(`${key} acronym ${acronym} (lowercase is common English)`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The list is the real thing: everyday words are in it, library vocabulary is not.
    for (const w of ['could', 'work', 'market', 'customer', 'design', 'station', 'grove', 'embrace']) {
      expect(isCommonEnglish(w), w).toBe(true);
    }
    for (const w of ['beachhead', 'desalination', 'cac', 'ltv', 'jtbd', 'semgrep']) {
      expect(isCommonEnglish(w), w).toBe(false);
    }
  });

  it('lists every case under its company’s full name, and marks a name that is everyday English', () => {
    for (const s of pack.scenarios) {
      const vocab = REFERENCE_VOCABULARY[`case/${s.scenario_id}`];
      expect(gateTokens(vocab?.names?.[0] ?? ''), s.scenario_id).toEqual(gateTokens(s.company));
      const everydayName = gateTokens(s.company).every((w) => isCommonEnglish(w) || w.length <= 1);
      if (everydayName) {
        expect(vocab?.everyday, s.company).toBe(true);
        expect(vocab?.nameCues?.length ?? 0, s.company).toBeGreaterThan(0);
      }
    }
  });
});

describe('what the coach reads first', () => {
  it('a framework summary opens with its limitations, a documented account with its evidence limits', () => {
    for (const f of pack.frameworks) {
      const summary = items.find((i) => i.key === `framework/${f.framework_id}`)?.passages[0]?.content ?? '';
      const excerpt = summary.slice(0, EXCERPT_CHARS - 1);
      expect(excerpt, f.framework_id).toContain(`Limitations: ${f.limitations}`);
      expect(summary.indexOf('Limitations:')).toBeLessThan(summary.indexOf(f.description));
    }
    for (const s of pack.scenarios) {
      const account = items.find((i) => i.key === `case/${s.scenario_id}`)?.passages[0]?.content ?? '';
      expect(account.slice(0, EXCERPT_CHARS - 1), s.scenario_id).toContain(
        `Evidence limits: ${s.outcome_limitations}`,
      );
      expect(account.startsWith('Evidence limits: ')).toBe(true);
    }
  });
});
