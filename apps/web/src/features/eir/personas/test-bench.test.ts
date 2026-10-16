import { TEST_TURN_MAX_HISTORY } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/errors';

import {
  benchErrorMessage,
  benchHistory,
  benchReleases,
  checkNotes,
  citedKeys,
  type BenchExchange,
} from './test-bench';
import { benchResult as answered, IDS, PASSED_CHECKS as PASSED, persona, RELEASE } from './test-fixtures';

const DRAFT_ID = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const OLD_DRAFT_ID = '2a3b4c5d-6e7f-4081-9a2b-3c4d5e6f7a8b';

describe('benchReleases', () => {
  it('offers drafts waiting for approval, newest first, then the active release', () => {
    const p = persona({
      releases: [
        { id: IDS.release, version: 2, status: 'approved', approvedAt: null, createdAt: RELEASE.createdAt },
        { id: OLD_DRAFT_ID, version: 1, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
        { id: DRAFT_ID, version: 3, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
      ],
      activeRelease: { ...RELEASE, version: 2 },
    });
    expect(benchReleases(p).map((r) => r.label)).toEqual(['Draft v3', 'Active v2']);
    // Nobody but curators can open drafts, so they are never offered to anyone else.
    expect(benchReleases({ ...p, canCurate: false }).map((r) => r.label)).toEqual(['Active v2']);
    expect(benchReleases({ ...p, activeRelease: null }).map((r) => r.id)).toEqual([DRAFT_ID, OLD_DRAFT_ID]);
  });
});

describe('benchHistory', () => {
  it('sends the last few exchanges, the answer as it was shown (none when held back)', () => {
    const exchanges: BenchExchange[] = Array.from({ length: TEST_TURN_MAX_HISTORY + 2 }, (_, i) => ({
      id: String(i),
      text: `Question ${String(i)}`,
      result: i === TEST_TURN_MAX_HISTORY + 1 ? answered({ status: 'blocked', response: null }) : answered(),
    }));
    const history = benchHistory(exchanges);
    expect(history).toHaveLength(TEST_TURN_MAX_HISTORY);
    expect(history[0]?.text).toBe('Question 2');
    expect(history.at(-1)).toEqual({ text: `Question ${String(TEST_TURN_MAX_HISTORY + 1)}`, answer: null });
    expect(history[1]?.answer).toContain('ten interviews');
  });
});

describe('checkNotes', () => {
  it('says every check passed, and what it could cite', () => {
    const response = answered().response;
    if (response === null) throw new Error('fixture');
    expect([...citedKeys(response)]).toEqual(['E1']);
    expect(checkNotes(answered())).toEqual([
      'Every check passed. Nothing was changed.',
      'Cited 1 source of 2 matches from the knowledge library and lessons.',
    ]);
  });

  it('puts identity rewrites, unsourced facts, narrowing and forced escalations in plain words', () => {
    const lines = checkNotes(
      answered({
        validator: {
          ...PASSED,
          identityViolation: true,
          factsDowngraded: 2,
          groundingCoverage: 0.25,
          narrowed: true,
          escalationForced: true,
          riskCategories: ['legal', 'prompt_injection'],
          notes: [
            'identity_rewritten:2:claims_eir+endorsement',
            'facts_downgraded:2',
            'unknown_evidence_ids_removed:1',
            'narrowed',
            'escalation_forced:legal',
            'html_removed:1',
          ],
        },
      }),
    );
    expect(lines).toEqual([
      'Rewrote 2 phrases that spoke as the EIR and said the EIR approved or reviewed something.',
      'Removed 1 citation of sources it was not given.',
      '2 statements given as fact had no source, so they are shown as inferences.',
      'Few facts were backed by sources, so the answer opens with a caution.',
      'Suggested a person for legal, as the topic needs one.',
      'Removed formatting or links that are not allowed.',
      'The message touched on legal matters and an attempt to change its instructions.',
      '25% of its factual statements cite a source.',
      'Cited 1 source of 2 matches from the knowledge library and lessons.',
    ]);
    // No validator code reaches the curator.
    expect(lines.join(' ')).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it('explains a held-back answer and crisis support', () => {
    expect(
      checkNotes(
        answered({
          status: 'blocked',
          response: null,
          blocked: { reason: 'identity', supportMessage: null },
          validator: { ...PASSED, identityViolation: true, notes: ['stream_gate_blocked'] },
        }),
      ),
    ).toEqual([
      'The answer spoke as the EIR, so the identity check held it back. A founder would see a short note instead.',
      'It stopped while writing, before the held-back sentence was shown.',
    ]);
    const crisis = checkNotes(
      answered({
        status: 'blocked',
        response: null,
        evidence: [],
        blocked: { reason: 'crisis_support', supportMessage: 'Call 988.' },
        validator: {
          ...PASSED,
          escalationForced: true,
          riskCategories: ['safety_wellbeing'],
          notes: ['crisis_support', 'no_model_call'],
        },
      }),
    );
    expect(crisis).toEqual([
      'A message like this gets the fixed support message with crisis lines instead of an AI answer.',
      'No AI model was asked. A founder is also offered a request to university support.',
    ]);
    expect(
      checkNotes(
        answered({ status: 'blocked', response: null, blocked: { reason: 'policy', supportMessage: null } }),
      )[0],
    ).toMatch(/privacy check held it back/);
  });
});

describe('benchErrorMessage', () => {
  const refusal = (code: 'forbidden' | 'conflict' | 'persona_suspended', reason: string) =>
    new ApiError({ status: 403, code, title: 'Refused', reason });

  it('says what to do for the bench’s own refusals', () => {
    expect(benchErrorMessage(refusal('forbidden', 'consent_required'))).toMatch(/Record one in Consent/);
    expect(benchErrorMessage(refusal('persona_suspended', 'persona_suspended'))).toBe(
      'This vEIR is suspended. Resume it to try a release.',
    );
    expect(benchErrorMessage(refusal('conflict', 'release_not_testable'))).toMatch(/Choose a release again/);
    expect(
      benchErrorMessage(new ApiError({ status: 429, code: 'rate_limited', title: 'Slow', retryAfter: 60 })),
    ).toMatch(/going a little fast/);
  });
});
