/**
 * The crisis pipeline on the whole E-crisis corpus (ops/lab/scenarios/safety-screen.json, synthetic): 1,227 lines from
 * the 2026-10-22 differential audit of the crisis classifier: handwritten crisis lines, hard negatives that share their
 * words (venture talk, sign-offs, frustration, jokes, product context), and every line of the evals datasets, tests and
 * lab scenarios that the deterministic rules flag as a crisis.
 *
 * The design these tests hold (risk/safety-screen.ts): the deterministic rules are origin/main's, unchanged, so nothing
 * they catch is lost; a broad prefilter sends the indirect phrasings they miss to the model-based screen; whatever the
 * screen answers (or when it fails) never takes a crisis away.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifyRisk } from './classifier.js';
import { ideationPrefilter } from './ideation-prefilter.js';
import { withSafetyScreen, type SafetyScreenOutcome } from './safety-screen.js';

interface CorpusRow {
  readonly id: string;
  readonly text: string;
  readonly expect: 'crisis' | 'wellbeing' | 'none' | 'debatable' | 'unlabeled';
  /** Whether origin/main's deterministic rules (93a7822) flag a crisis. */
  readonly main: boolean;
}

const CORPUS: readonly CorpusRow[] = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../ops/lab/scenarios/safety-screen.json', import.meta.url)),
      'utf8',
    ),
  ) as { rows: CorpusRow[] }
).rows;

const OUTCOMES: readonly SafetyScreenOutcome[] = ['crisis', 'wellbeing', 'clear', 'failed'];

describe('the E-crisis corpus', () => {
  it('is the corpus the audit measured', () => {
    expect(CORPUS.length).toBe(1227);
    const count = (expectValue: CorpusRow['expect'], main: boolean): number =>
      CORPUS.filter((r) => r.expect === expectValue && r.main === main).length;
    expect(count('crisis', true)).toBe(194);
    expect(count('crisis', false)).toBe(183);
    expect(count('none', false)).toBe(691);
    expect(count('none', true)).toBe(65);
    expect(count('unlabeled', true)).toBe(74);
  });

  it("keeps every one of main's deterministic decisions: the rules are unchanged", () => {
    const changed = CORPUS.filter((r) => classifyRisk(r.text).crisis !== r.main).map((r) => r.id);
    expect(changed).toEqual([]);
  });

  it('never loses a crisis the rules catch, whatever the screen answers or when it fails', () => {
    for (const outcome of OUTCOMES) {
      const lost = CORPUS.filter((r) => r.main)
        .filter((r) => !withSafetyScreen(classifyRisk(r.text), outcome).crisis)
        .map((r) => r.id);
      expect(lost, outcome).toEqual([]);
    }
  });

  it('sends every crisis line the rules miss to the screen (prefilter recall)', () => {
    const missed = CORPUS.filter((r) => r.expect === 'crisis' && !r.main)
      .filter((r) => !ideationPrefilter(r.text).hit)
      .map((r) => `${r.id}: ${r.text.slice(-80)}`);
    expect(missed).toEqual([]);
  });

  it('sends the debatable and wellbeing lines to the screen too', () => {
    const debatable = CORPUS.filter((r) => (r.expect === 'debatable' || r.expect === 'wellbeing') && !r.main);
    const sent = debatable.filter((r) => ideationPrefilter(r.text).hit);
    // "I want this pain to go away, the migraine has lasted three days." is the one the prefilter lets pass.
    expect(sent.length).toBeGreaterThanOrEqual(debatable.length - 1);
  });

  it('a screen crisis on a line the rules miss gives the crisis flag; failing or clear gives none', () => {
    for (const row of CORPUS.filter((r) => r.expect === 'crisis' && !r.main)) {
      const rules = classifyRisk(row.text);
      expect(withSafetyScreen(rules, 'crisis').crisis).toBe(true);
      expect(withSafetyScreen(rules, 'failed')).toEqual(rules);
      expect(withSafetyScreen(rules, 'clear')).toEqual(rules);
    }
  });
});
