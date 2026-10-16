import {
  TEST_TURN_MAX_HISTORY,
  type CoachResponse,
  type EscalationCategory,
  type PersonaView,
  type RiskCategory,
  type TestTurnRequest,
  type TestTurnResponse,
} from '@foundry/contracts';

import { errorMessage, isApiError } from '@/lib/api/errors';
import { formatPercent, pluralize } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';

import { pendingDrafts } from './release-drafts';

/** A release the Test bench can talk to: the active one, or a draft waiting for approval. */
export interface BenchRelease {
  id: string;
  version: number;
  kind: 'active' | 'draft';
  /** "Active v3", "Draft v4". */
  label: string;
}

/** The releases a curator can try, newest draft first, then the active release. */
export function benchReleases(
  persona: Pick<PersonaView, 'activeRelease' | 'releases' | 'canCurate'>,
): BenchRelease[] {
  const drafts = pendingDrafts(persona).map((r): BenchRelease => ({
    id: r.id,
    version: r.version,
    kind: 'draft',
    label: `Draft v${String(r.version)}`,
  }));
  const active = persona.activeRelease;
  return active === null
    ? drafts
    : [
        ...drafts,
        {
          id: active.id,
          version: active.version,
          kind: 'active',
          label: `Active v${String(active.version)}`,
        },
      ];
}

/** One message and what came back, kept in the tab's memory only. */
export interface BenchExchange {
  id: string;
  text: string;
  result: TestTurnResponse;
}

/** The earlier exchanges sent with a message: the last few, the answer as it was shown (none when held back). */
export function benchHistory(exchanges: readonly BenchExchange[]): NonNullable<TestTurnRequest['history']> {
  return exchanges.slice(-TEST_TURN_MAX_HISTORY).map((e) => ({
    text: e.text,
    answer: e.result.response?.answer ?? null,
  }));
}

/** Evidence keys the answer cites, in its text or its claims. */
export function citedKeys(response: Pick<CoachResponse, 'answer' | 'claims'>): Set<string> {
  const keys = new Set<string>();
  for (const match of response.answer.matchAll(/\[(E\d+)\]/g)) if (match[1]) keys.add(match[1]);
  for (const claim of response.claims) for (const key of claim.evidence_ids) keys.add(key);
  return keys;
}

const RISK_WORDS: Record<Exclude<RiskCategory, 'cross_venture_request'>, string> = {
  ip_licensing: 'IP and licensing',
  legal: 'legal matters',
  securities_investment: 'securities and investment',
  medical_regulatory: 'medical or regulatory matters',
  safety_wellbeing: 'safety and wellbeing',
  conflict_harassment: 'conflict or harassment',
  prompt_injection: 'an attempt to change its instructions',
};

const IDENTITY_KINDS: Record<string, string> = {
  claims_eir: 'spoke as the EIR',
  endorsement: 'said the EIR approved or reviewed something',
};

function count(note: string): number {
  const value = Number(note.split(':')[1]);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/** Why a founder would not see the answer, in plain words (null when it was shown). */
export function heldBackReason(result: Pick<TestTurnResponse, 'blocked'>): string | null {
  switch (result.blocked?.reason) {
    case undefined:
      return null;
    case 'crisis_support':
      return 'A message like this gets the fixed support message with crisis lines instead of an AI answer.';
    case 'identity':
      return 'The answer spoke as the EIR, so the identity check held it back. A founder would see a short note instead.';
    case 'policy':
      return 'The answer touched something private, like another venture or the people in it, so the privacy check held it back.';
    case 'invalid_schema':
      return 'The answer could not be checked, so it was held back. A founder would be asked to try again.';
    default:
      return 'The answer was held back. A founder would be offered a person instead.';
  }
}

/**
 * What the checks did to one answer, in plain words a curator can act on: what was held back or rewritten,
 * how well the facts were sourced, which topics needed a person. Never the validator's codes.
 */
export function checkNotes(result: TestTurnResponse): string[] {
  const { validator } = result;
  const notes = validator.notes;
  const has = (code: string) => notes.some((n) => n === code || n.startsWith(`${code}:`));
  const crisis = has('no_model_call');
  /** What the checks changed or held back. */
  const changes: string[] = [];
  /** What they measured. */
  const info: string[] = [];
  const held = heldBackReason(result);
  if (held) changes.push(held);
  if (crisis) {
    changes.push('No AI model was asked. A founder is also offered a request to university support.');
  }
  for (const note of notes.filter((n) => n.startsWith('identity_rewritten:'))) {
    const [, n = '1', kinds = ''] = note.split(':');
    const what = kinds
      .split('+')
      .map((k) => IDENTITY_KINDS[k])
      .filter((k): k is string => k !== undefined);
    changes.push(
      `Rewrote ${pluralize(Number(n) || 1, 'phrase')} that ${what.length > 0 ? joinWords(what) : 'spoke for a person'}.`,
    );
  }
  if (has('stream_gate_blocked')) {
    changes.push('It stopped while writing, before the held-back sentence was shown.');
  }
  const unknown = notes.find((n) => n.startsWith('unknown_evidence_ids_removed:'));
  if (unknown) changes.push(`Removed ${pluralize(count(unknown), 'citation')} of sources it was not given.`);
  const downgraded = notes.find((n) => n.startsWith('facts_downgraded:'));
  if (downgraded) {
    const n = count(downgraded);
    changes.push(
      `${pluralize(n, 'statement')} given as fact had no source, so ${n === 1 ? 'it is' : 'they are'} shown as ${n === 1 ? 'an inference' : 'inferences'}.`,
    );
  }
  if (validator.narrowed)
    changes.push('Few facts were backed by sources, so the answer opens with a caution.');
  if (!crisis) {
    for (const note of notes.filter((n) => n.startsWith('escalation_forced:'))) {
      const label = ESCALATION_CATEGORY_LABELS[note.split(':')[1] as EscalationCategory] as
        string | undefined;
      changes.push(
        label
          ? `Suggested a person for ${label.toLowerCase()}, as the topic needs one.`
          : 'Suggested a person, as the topic needs one.',
      );
    }
  }
  if (has('mode_corrected')) changes.push('It answered in a mode this release allows.');
  if (
    has('html_removed') ||
    has('unsafe_links_removed') ||
    has('images_removed') ||
    has('plain_text_sanitized')
  ) {
    changes.push('Removed formatting or links that are not allowed.');
  }
  if (has('truncated') || has('items_dropped') || has('answer_truncated')) {
    changes.push('Trimmed parts that were too long.');
  }
  if (has('rehearsal_removed')) changes.push('Removed a rehearsal it was not asked for.');
  if (has('invalid_dates_cleared')) changes.push('Cleared next-step dates that were not valid.');
  if (has('empty_answer_replaced')) changes.push('The model gave no answer, so a short fallback was shown.');
  if (has('annotations_unavailable')) {
    changes.push('Sources and next steps could not be added this time, so the reply stands alone.');
  }
  if (notes.some((n) => /^stream_(interrupted|empty|structured_output)$/.test(n))) {
    changes.push('The reply broke off while it was written, so it was written again in one piece.');
  }

  const topics = validator.riskCategories
    .filter((c): c is Exclude<RiskCategory, 'cross_venture_request'> => c !== 'cross_venture_request')
    .map((c) => RISK_WORDS[c]);
  if (topics.length > 0 && !crisis) info.push(`The message touched on ${joinWords(topics)}.`);
  if (validator.groundingCoverage !== null) {
    info.push(`${formatPercent(validator.groundingCoverage)} of its factual statements cite a source.`);
  }
  if (result.response) {
    const available = result.evidence.length;
    const cited = [...citedKeys(result.response)].filter((k) => result.evidence.some((e) => e.key === k));
    info.push(
      available === 0
        ? 'Nothing in the knowledge library or lessons matched, so it cited no sources.'
        : `Cited ${pluralize(cited.length, 'source')} of ${pluralize(available, 'match', 'matches')} from the knowledge library and lessons.`,
    );
  }
  return changes.length === 0 ? ['Every check passed. Nothing was changed.', ...info] : [...changes, ...info];
}

/** What went wrong sending a test message, in words that say what to do. */
export function benchErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    switch (error.reason) {
      case 'consent_required':
        return 'This vEIR needs a consent in force that covers doctrine. Record one in Consent, then try again.';
      case 'persona_suspended':
        return 'This vEIR is suspended. Resume it to try a release.';
      case 'persona_retired':
        return 'This vEIR is retired, so it no longer answers.';
      case 'release_not_testable':
        return 'This release can’t be tried any more: it was approved or withdrawn. Choose a release again.';
      case 'mode_not_allowed':
        return 'This release doesn’t allow that mode. Choose another one.';
      default:
        break;
    }
  }
  return errorMessage(error);
}
