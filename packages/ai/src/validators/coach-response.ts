import {
  CoachResponse,
  type CoachMode,
  type EscalationCategory,
  type EscalationPriority,
  type EscalationProposal,
  type RiskCategory,
  type TurnChannel,
  type ValidatorResults,
} from '@foundry/contracts';

import { ESCALATION_ROUTES } from '../prompts/escalation.js';
import { truncate } from '../prompts/escape.js';
import { DEFAULT_PERSONA_NAME } from '../prompts/version.js';
import { normalizeForMatching, personNameRegExp, ventureNameRegExp } from '../risk/normalize.js';
import {
  RISK_ESCALATION_MAP,
  morePressing,
  primaryForcedCategory,
  type RequestedRoleValue,
} from '../risk/escalation-map.js';
import {
  IDENTITY_MARGIN_CHARS,
  rewriteIdentity,
  type IdentityFinding,
  type IdentityViolationKind,
} from './identity.js';
import { sanitizeMarkdown, sanitizePlainText } from './markdown.js';
import { SPOKEN_MAX_CHARS, SPOKEN_MAX_WORDS, clampWords, deriveSpoken, toSpeakable } from './speech.js';

export interface CoachResponseLimits {
  answerMaxChars: number;
  textMaxChars: number;
  memoryContentMaxChars: number;
  claimsMax: number;
  uncertaintyMax: number;
  nextActionsMax: number;
  memoryCandidatesMax: number;
  followUpQuestionsMax: number;
  rehearsalScoresMax: number;
  evidenceIdsPerItemMax: number;
  spokenMaxWords: number;
  spokenMaxChars: number;
}

export const DEFAULT_COACH_RESPONSE_LIMITS: Readonly<CoachResponseLimits> = {
  answerMaxChars: 6_000,
  textMaxChars: 600,
  memoryContentMaxChars: 2_000,
  claimsMax: 20,
  uncertaintyMax: 10,
  nextActionsMax: 8,
  memoryCandidatesMax: 3,
  followUpQuestionsMax: 5,
  rehearsalScoresMax: 6,
  evidenceIdsPerItemMax: 10,
  spokenMaxWords: SPOKEN_MAX_WORDS,
  spokenMaxChars: SPOKEN_MAX_CHARS,
};

export interface ValidateCoachResponseOptions {
  /** Evidence keys (`E1…En`) that were actually shown to the model for this turn. */
  evidenceKeys: ReadonlySet<string>;
  /** Deterministic pre-classifier result for the founder message (a `RiskClassification` fits). */
  preRisk: { categories: readonly RiskCategory[]; crisis?: boolean };
  /** Names of the other ventures in the tenant (never shown in results). */
  otherVentureNames: readonly string[];
  /** Per-venture canary strings of the other ventures (never shown in results). */
  otherVentureCanaries: readonly string[];
  /**
   * Display names of the members of the other ventures in the tenant (never shown in results). Any of
   * them in the output blocks the turn like a venture name: who belongs to which venture is venture data.
   */
  otherVentureMemberNames?: readonly string[];
  /** Persona display name, e.g. "Foundry Guide". */
  personaName: string;
  /** Minimum grounded share of `fact` claims before the answer is narrowed (platform setting, default 0.6). */
  coverageThreshold: number;
  /** Mode requested for the turn; the response's `mode` is corrected to it. */
  expectedMode?: CoachMode;
  /**
   * Auto mode (no `expectedMode`): the modes the model was allowed to choose from. A mode outside them is
   * corrected to the first allowed one.
   */
  allowedModes?: readonly CoachMode[];
  /** Names of real EIRs / program staff the coach must never speak as. */
  eirNames?: readonly string[];
  /**
   * Display name of the EIR a vEIR persona is built from ("Corin Halvorsen"). Optional: read from a
   * "<first name>'s vEIR" persona name and `eirNames` when omitted.
   */
  personaEirName?: string | null;
  /**
   * Display names of the founder and venture team the reply may address. "Thanks, Ruth." ending a reply
   * to a founder called Ruth addresses her; without it, an EIR named Ruth is read as signing off.
   */
  addressees?: readonly string[];
  /** Identity violation kinds that block the turn (others are rewritten). Default `['claims_eir']`. */
  blockOnIdentity?: readonly IdentityViolationKind[];
  /**
   * `voice` (a call): `spoken` is sanitised like the answer (and derived from it when missing) because
   * it is what the call says. `text` (default): `spoken` is always null.
   */
  channel?: TurnChannel;
  limits?: Partial<CoachResponseLimits>;
}

export type CoachResponseBlockReason = 'invalid_schema' | 'cross_venture' | 'identity';

export interface CoachResponseValidation {
  /** The validated response (a safe placeholder when blocked for schema or cross-venture reasons). */
  response: CoachResponse;
  results: ValidatorResults;
  blocked: boolean;
  blockReason?: CoachResponseBlockReason;
}

const PRIORITY_RANK: Readonly<Record<EscalationPriority, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Text kept past a field's limit for the identity check, so a sentence that crosses the limit is judged whole. */

const NO_ESCALATION: EscalationProposal = {
  required: false,
  category: null,
  priority: null,
  reason: null,
  requested_role: null,
};

export const NARROWING_NOTE_PREFIX = '> **Limited evidence:**';
/** Said first on a call when the answer was narrowed (the transcript carries the full note). */
export const SPOKEN_NARROWING_CAVEAT = "A quick caveat: some of this isn't backed by your records yet.";
export const EMPTY_ANSWER_FALLBACK =
  "I don't have enough to give you a reliable answer yet. Could you share a bit more detail about what you've observed so far?";
export const CROSS_VENTURE_BLOCK_ANSWER =
  "I can't share or discuss information about other ventures: every venture workspace on Foundry Ascent is private. Let's keep working on yours. What would be most useful to focus on next?";
export const INVALID_RESPONSE_ANSWER =
  "I couldn't produce a reliable answer this time. Please try again, or rephrase your question.";

function forcedReason(category: EscalationCategory): string {
  return `This touches a high-risk area (${category.replace(/_/g, ' ')}) that needs review by a qualified person.`;
}

function emptyResponse(
  mode: CoachMode,
  answer: string,
  escalation: EscalationProposal,
  channel: TurnChannel,
): CoachResponse {
  return {
    mode,
    answer,
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [],
    escalation,
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
    // The placeholders are fixed, safe text: a call may say them.
    spoken: channel === 'voice' ? deriveSpoken(answer) : null,
  };
}

function normalizeEvidenceId(raw: string): string {
  return raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .trim()
    .toUpperCase();
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Escalation the pre-classifier forces for this turn, or null. Crisis implies safety_wellbeing.
 * Prompt injection and cross-venture requests never force one by themselves.
 */
export function forcedEscalationFor(preRisk: { categories: readonly RiskCategory[]; crisis?: boolean }): {
  riskCategory: RiskCategory;
  category: EscalationCategory;
  priority: EscalationPriority;
  requestedRole: RequestedRoleValue;
} | null {
  const categories =
    preRisk.crisis === true ? ['safety_wellbeing' as const, ...preRisk.categories] : [...preRisk.categories];
  const primary = primaryForcedCategory(categories);
  if (primary === null) return null;
  const route = RISK_ESCALATION_MAP[primary];
  return {
    riskCategory: primary,
    category: route.category,
    priority: route.priority,
    requestedRole: route.requestedRole,
  };
}

/**
 * Deterministic post-generation validator for coaching turns (system design §7 step 6):
 *
 * 1. schema (Zod) — invalid input is blocked with a safe placeholder response;
 * 2. mode corrected to the requested mode (in auto mode, to an allowed one); `rehearsal` only in
 *    rehearse mode;
 * 3. Markdown sanitised (no raw HTML, images, or non-https/mailto links), plain fields stripped;
 * 4. unknown evidence ids removed (claims, memory candidates, inline `[E#]` citations);
 * 5. `fact` claims without valid evidence downgraded to `inference`; grounding coverage computed;
 *    answer narrowed (explicit uncertainty note + uncertainty item) when coverage < threshold
 *    with ≥ 2 facts;
 * 6. identity: sentences claiming to be human, the EIR, or approving/endorsing are replaced;
 *    EIR impersonation blocks the turn by default. Each field is checked cut to its limit (plus a
 *    sentence of margin), so an over-long output cannot make the check expensive;
 * 7. length bounds and value ranges (dates, scores, confidence);
 * 8. escalation normalised and forced for pre-classified high-risk categories;
 * 9. cross-venture: any other venture name or canary anywhere in the output blocks the turn.
 *
 * `spoken` (what a call says aloud) goes through the same steps on the voice channel: it is
 * identity-checked as the model wrote it, made plain (no Markdown, links, URLs or citation keys),
 * derived from the identity-checked answer when the model gave none, identity-checked again as it will
 * be heard (names in any case, flattened sign-offs such as "Thanks. — Corin."), clamped to 70 words and
 * scanned for other ventures. On the text channel it is null.
 *
 * `results.notes` contains codes only — never response text, venture names or canaries.
 */
export function validateCoachResponse(
  raw: unknown,
  options: ValidateCoachResponseOptions,
): CoachResponseValidation {
  const limits: CoachResponseLimits = { ...DEFAULT_COACH_RESPONSE_LIMITS, ...options.limits };
  const personaName = options.personaName.trim() === '' ? DEFAULT_PERSONA_NAME : options.personaName;
  const threshold = clamp(options.coverageThreshold, 0, 1, 0.6);
  const channel: TurnChannel = options.channel ?? 'text';
  const notes: string[] = [];
  const results: ValidatorResults = {
    unknownEvidenceIdsRemoved: 0,
    factsDowngraded: 0,
    groundingCoverage: null,
    narrowed: false,
    escalationForced: false,
    identityViolation: false,
    crossVentureViolation: false,
    riskCategories: [...new Set(options.preRisk.categories)],
    notes,
  };
  const forced = forcedEscalationFor(options.preRisk);
  const forcedProposal: EscalationProposal = forced
    ? {
        required: true,
        category: forced.category,
        priority: forced.priority,
        reason: forcedReason(forced.category),
        requested_role: forced.requestedRole,
      }
    : NO_ESCALATION;

  // 1. Schema --------------------------------------------------------------------------------------
  const parsed = CoachResponse.safeParse(raw);
  if (!parsed.success) {
    notes.push(`invalid_schema:${parsed.error.issues.length}`);
    results.escalationForced = forced !== null;
    return {
      response: emptyResponse(
        options.expectedMode ?? options.allowedModes?.[0] ?? 'coach',
        INVALID_RESPONSE_ANSWER,
        forcedProposal,
        channel,
      ),
      results,
      blocked: true,
      blockReason: 'invalid_schema',
    };
  }
  const r: CoachResponse = structuredClone(parsed.data);

  // 2. Mode -----------------------------------------------------------------------------------------
  if (options.expectedMode !== undefined && r.mode !== options.expectedMode) {
    r.mode = options.expectedMode;
    notes.push('mode_corrected');
  } else if (options.expectedMode === undefined && options.allowedModes !== undefined) {
    const [firstAllowed] = options.allowedModes;
    if (firstAllowed !== undefined && !options.allowedModes.includes(r.mode)) {
      r.mode = firstAllowed;
      notes.push('mode_corrected');
    }
  }
  if (r.mode !== 'rehearse' && r.rehearsal !== null) {
    r.rehearsal = null;
    notes.push('rehearsal_removed');
  }

  // 3. Sanitise ---------------------------------------------------------------------------------------
  const md = sanitizeMarkdown(r.answer);
  r.answer = md.text;
  if (md.htmlRemoved > 0) notes.push(`html_removed:${md.htmlRemoved}`);
  if (md.unsafeLinksRemoved > 0) notes.push(`unsafe_links_removed:${md.unsafeLinksRemoved}`);
  if (md.imagesRemoved > 0) notes.push(`images_removed:${md.imagesRemoved}`);
  let plainChanged = 0;
  const plain = (value: string): string => {
    const out = sanitizePlainText(value);
    if (out.changed && value.includes('<')) plainChanged += 1;
    return out.text;
  };
  r.claims = r.claims.map((c) => ({ ...c, text: plain(c.text) })).filter((c) => c.text !== '');
  r.uncertainty = r.uncertainty.map((u) => ({ ...u, item: plain(u.item) })).filter((u) => u.item !== '');
  r.challenge = r.challenge === null ? null : plain(r.challenge) || null;
  r.next_actions = r.next_actions
    .map((a) => ({ ...a, owner: plain(a.owner) || 'founder', action: plain(a.action) }))
    .filter((a) => a.action !== '');
  r.memory_candidates = r.memory_candidates
    .map((m) => ({ ...m, title: plain(m.title), content: plain(m.content) }))
    .filter((m) => m.title !== '' && m.content !== '');
  r.follow_up_questions = r.follow_up_questions.map(plain).filter((q) => q !== '');
  if (r.escalation.reason !== null) r.escalation.reason = plain(r.escalation.reason) || null;
  if (r.rehearsal !== null) {
    r.rehearsal = {
      counterpart: plain(r.rehearsal.counterpart),
      line: plain(r.rehearsal.line),
      critique: plain(r.rehearsal.critique),
      scores: r.rehearsal.scores
        .map((s) => ({ criterion: plain(s.criterion), score: s.score, note: plain(s.note) }))
        .filter((s) => s.criterion !== ''),
    };
  }
  if (plainChanged > 0) notes.push(`plain_text_sanitized:${plainChanged}`);

  // Identity runs on text already cut to its limit (plus a sentence of margin, so a sentence that crosses
  // the limit is judged whole): an over-long output cannot make the check expensive.
  const identityFindings: IdentityFinding[] = [];
  const identityOptions = {
    personaName,
    ...(options.eirNames ? { eirNames: options.eirNames } : {}),
    ...(options.personaEirName !== undefined ? { personaEirName: options.personaEirName } : {}),
    ...(options.addressees ? { addressees: options.addressees } : {}),
  };
  const fixIdentity = (
    value: string,
    max: number,
    { checkHumanClaims = true, spoken = false } = {},
  ): string => {
    const rewrite = rewriteIdentity(truncate(value, max + IDENTITY_MARGIN_CHARS), {
      ...identityOptions,
      checkHumanClaims,
      spoken,
    });
    identityFindings.push(...rewrite.findings);
    return rewrite.text;
  };

  // Spoken text: plain sentences on a call (citation keys and Markdown removed), never on typed turns.
  // Identity is checked on the model's own lines first (a sign-off stands on its own line there) and
  // again on the flattened text in step 6, where "Best,\nCorin" has become "Best, Corin.".
  const modelSpoken = typeof r.spoken === 'string' ? r.spoken : '';
  if (channel === 'voice') {
    const speakable = toSpeakable(
      modelSpoken.trim() === '' ? '' : fixIdentity(modelSpoken, limits.spokenMaxChars, { spoken: true }),
    );
    r.spoken = speakable === '' ? null : speakable;
    if (speakable !== '' && speakable !== modelSpoken.trim()) notes.push('spoken_sanitized');
  } else {
    if (modelSpoken.trim() !== '') notes.push('spoken_removed');
    r.spoken = null;
  }

  // 4. Evidence ids ---------------------------------------------------------------------------------
  const keys = new Set([...options.evidenceKeys].map(normalizeEvidenceId));
  const filterIds = (ids: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const rawId of ids) {
      const id = normalizeEvidenceId(rawId);
      if (keys.has(id)) {
        if (!kept.includes(id)) kept.push(id);
      } else {
        results.unknownEvidenceIdsRemoved += 1;
      }
    }
    return kept.slice(0, limits.evidenceIdsPerItemMax);
  };
  r.answer = r.answer.replace(/ ?\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\](?!\()/gi, (whole, list: string) => {
    const ids = list.split(/[,;]/).map(normalizeEvidenceId);
    const kept = ids.filter((id) => keys.has(id));
    results.unknownEvidenceIdsRemoved += ids.length - kept.length;
    if (kept.length === ids.length) return whole;
    if (kept.length === 0) return '';
    return `${whole.startsWith(' ') ? ' ' : ''}[${[...new Set(kept)].join(', ')}]`;
  });
  const factsBefore = r.claims.filter((c) => c.kind === 'fact').length;
  r.claims = r.claims.map((c) => ({ ...c, evidence_ids: filterIds(c.evidence_ids) }));
  r.memory_candidates = r.memory_candidates.map((m) => ({ ...m, evidence_ids: filterIds(m.evidence_ids) }));
  if (results.unknownEvidenceIdsRemoved > 0)
    notes.push(`unknown_evidence_ids_removed:${results.unknownEvidenceIdsRemoved}`);
  // The answer's identity check comes before a spoken reply is derived from it, so a call never says a
  // sentence the transcript replaced (step 6 checks the rest).
  r.answer = fixIdentity(r.answer, limits.answerMaxChars);
  // A call needs something to say: the model's spoken reply, or else the answer made speakable (before
  // the limited-evidence note below is added to the answer).
  if (channel === 'voice' && (r.spoken ?? '') === '') {
    const derived = deriveSpoken(r.answer, limits.spokenMaxWords);
    r.spoken = derived === '' ? null : derived;
    notes.push('spoken_derived');
  }

  // 5. Facts, coverage, narrowing ------------------------------------------------------------------
  let grounded = 0;
  r.claims = r.claims.map((c) => {
    if (c.kind !== 'fact') return c;
    if (c.evidence_ids.length > 0) {
      grounded += 1;
      return c;
    }
    results.factsDowngraded += 1;
    return { ...c, kind: 'inference' as const };
  });
  if (results.factsDowngraded > 0) notes.push(`facts_downgraded:${results.factsDowngraded}`);
  if (factsBefore > 0) {
    results.groundingCoverage = Math.round((grounded / factsBefore) * 1000) / 1000;
    if (results.groundingCoverage < threshold && factsBefore >= 2) {
      results.narrowed = true;
      notes.push('narrowed');
      const note = `${NARROWING_NOTE_PREFIX} only ${grounded} of ${factsBefore} factual statements in this answer are backed by your venture records. Treat the rest as unverified until you can check them.`;
      r.answer = r.answer === '' ? note : `${note}\n\n${r.answer}`;
      r.uncertainty = [
        {
          item: 'Several statements in this answer are not backed by evidence from your venture records.',
          level: 'high' as const,
        },
        ...r.uncertainty,
      ];
      if (r.spoken) r.spoken = `${SPOKEN_NARROWING_CAVEAT} ${r.spoken}`;
    }
  }

  // 6. Identity (the answer and the model's own spoken lines were checked above) ------------------------
  const textMax = limits.textMaxChars;
  r.claims = r.claims.map((c) => ({ ...c, text: fixIdentity(c.text, textMax) }));
  r.uncertainty = r.uncertainty.map((u) => ({ ...u, item: fixIdentity(u.item, textMax) }));
  r.challenge = r.challenge === null ? null : fixIdentity(r.challenge, textMax);
  r.next_actions = r.next_actions.map((a) => ({ ...a, action: fixIdentity(a.action, textMax) }));
  r.memory_candidates = r.memory_candidates.map((m) => ({
    ...m,
    title: fixIdentity(m.title, 200),
    content: fixIdentity(m.content, limits.memoryContentMaxChars),
  }));
  r.follow_up_questions = r.follow_up_questions.map((q) => fixIdentity(q, textMax));
  if (r.spoken) r.spoken = fixIdentity(r.spoken, limits.spokenMaxChars, { spoken: true });
  if (r.escalation.reason !== null) r.escalation.reason = fixIdentity(r.escalation.reason, 400);
  if (r.rehearsal !== null) {
    r.rehearsal = {
      ...r.rehearsal,
      counterpart: fixIdentity(r.rehearsal.counterpart, 120, { checkHumanClaims: false }),
      line: fixIdentity(r.rehearsal.line, textMax * 2, { checkHumanClaims: false }),
      critique: fixIdentity(r.rehearsal.critique, textMax * 2),
      scores: r.rehearsal.scores.map((s) => ({ ...s, note: fixIdentity(s.note, textMax) })),
    };
  }
  let identityBlocked = false;
  if (identityFindings.length > 0) {
    results.identityViolation = true;
    const kinds = [...new Set(identityFindings.map((f) => f.kind))];
    notes.push(`identity_rewritten:${identityFindings.length}:${kinds.join('+')}`);
    const blockOn = new Set(options.blockOnIdentity ?? ['claims_eir']);
    identityBlocked = identityFindings.some((f) => blockOn.has(f.kind));
  }

  // 7. Length bounds and value ranges -----------------------------------------------------------------
  let truncated = 0;
  const bound = (value: string, max: number): string => {
    if (value.length <= max) return value;
    truncated += 1;
    return truncate(value, max);
  };
  r.answer = bound(r.answer, limits.answerMaxChars);
  if (r.answer.trim() === '') {
    r.answer = EMPTY_ANSWER_FALLBACK;
    notes.push('empty_answer_replaced');
  }
  const dropped = { claims: 0, other: 0 };
  if (r.claims.length > limits.claimsMax) dropped.claims = r.claims.length - limits.claimsMax;
  r.claims = r.claims
    .slice(0, limits.claimsMax)
    .map((c) => ({ ...c, text: bound(c.text, limits.textMaxChars) }));
  const cap = <T>(items: T[], max: number): T[] => {
    if (items.length > max) dropped.other += items.length - max;
    return items.slice(0, max);
  };
  r.uncertainty = cap(r.uncertainty, limits.uncertaintyMax).map((u) => ({
    ...u,
    item: bound(u.item, limits.textMaxChars),
  }));
  r.challenge = r.challenge === null ? null : bound(r.challenge, limits.textMaxChars) || null;
  let datesCleared = 0;
  r.next_actions = cap(r.next_actions, limits.nextActionsMax).map((a) => {
    let targetDate = a.target_date === null ? null : a.target_date.trim();
    if (targetDate !== null && !isValidIsoDate(targetDate)) {
      targetDate = null;
      datesCleared += 1;
    }
    return {
      owner: bound(a.owner, 80),
      action: bound(a.action, limits.textMaxChars),
      target_date: targetDate,
    };
  });
  r.memory_candidates = cap(r.memory_candidates, limits.memoryCandidatesMax).map((m) => ({
    ...m,
    title: bound(m.title, 200),
    content: bound(m.content, limits.memoryContentMaxChars),
    confidence: clamp(m.confidence, 0, 1, 0.5),
  }));
  r.follow_up_questions = cap(r.follow_up_questions, limits.followUpQuestionsMax).map((q) =>
    bound(q, limits.textMaxChars),
  );
  if (r.rehearsal !== null) {
    r.rehearsal = {
      counterpart: bound(r.rehearsal.counterpart, 120),
      line: bound(r.rehearsal.line, limits.textMaxChars * 2),
      critique: bound(r.rehearsal.critique, limits.textMaxChars * 2),
      scores: cap(
        r.rehearsal.scores.filter((s) => Number.isFinite(s.score)),
        limits.rehearsalScoresMax,
      ).map((s) => ({
        criterion: bound(s.criterion, 80),
        score: clamp(s.score, 1, 5, 1),
        note: bound(s.note, limits.textMaxChars),
      })),
    };
  }
  if (r.spoken) {
    const spoken = clampWords(r.spoken, limits.spokenMaxWords, limits.spokenMaxChars);
    if (spoken.truncated) notes.push('spoken_truncated');
    r.spoken = spoken.text === '' ? null : spoken.text;
  }
  if (channel === 'voice' && !r.spoken) {
    r.spoken = deriveSpoken(r.answer, limits.spokenMaxWords) || deriveSpoken(EMPTY_ANSWER_FALLBACK);
  }
  if (truncated > 0) notes.push(`truncated:${truncated}`);
  if (dropped.claims + dropped.other > 0) notes.push(`items_dropped:${dropped.claims + dropped.other}`);
  if (datesCleared > 0) notes.push(`invalid_dates_cleared:${datesCleared}`);

  // 8. Escalation -----------------------------------------------------------------------------------
  r.escalation = normalizeEscalation(r.escalation, notes);
  if (forced !== null) {
    const current = r.escalation;
    const keepModelChoice =
      current.required &&
      current.priority !== null &&
      PRIORITY_RANK[current.priority] < PRIORITY_RANK[forced.priority]; // the model escalated something more urgent
    if (!keepModelChoice) {
      const sameCategory = current.required && current.category === forced.category;
      const next: EscalationProposal = {
        required: true,
        category: forced.category,
        priority:
          current.priority !== null && sameCategory
            ? morePressing(current.priority, forced.priority)
            : forced.priority,
        reason: sameCategory && current.reason !== null ? current.reason : forcedReason(forced.category),
        requested_role:
          sameCategory && current.requested_role !== null ? current.requested_role : forced.requestedRole,
      };
      const changed =
        next.required !== current.required ||
        next.category !== current.category ||
        next.priority !== current.priority ||
        next.requested_role !== current.requested_role;
      if (changed) {
        results.escalationForced = true;
        notes.push(`escalation_forced:${forced.riskCategory}`);
      }
      r.escalation = next;
    }
  }

  // 9. Cross-venture ------------------------------------------------------------------------------------
  if (
    containsOtherVenture(
      r,
      options.otherVentureNames,
      options.otherVentureCanaries,
      options.otherVentureMemberNames ?? [],
    )
  ) {
    results.crossVentureViolation = true;
    notes.push('cross_venture_blocked');
    const escalation = forced !== null ? forcedProposal : NO_ESCALATION;
    return {
      response: emptyResponse(r.mode, CROSS_VENTURE_BLOCK_ANSWER, escalation, channel),
      results,
      blocked: true,
      blockReason: 'cross_venture',
    };
  }

  const final = CoachResponse.parse(r);
  if (identityBlocked) return { response: final, results, blocked: true, blockReason: 'identity' };
  return { response: final, results, blocked: false };
}

function normalizeEscalation(escalation: EscalationProposal, notes: string[]): EscalationProposal {
  if (!escalation.required) {
    const clean =
      escalation.category === null &&
      escalation.priority === null &&
      escalation.reason === null &&
      escalation.requested_role === null;
    if (!clean) notes.push('escalation_fields_cleared');
    return NO_ESCALATION;
  }
  const category = escalation.category ?? 'other';
  const priority = escalation.priority ?? ESCALATION_ROUTES[category].priority;
  const requested = escalation.requested_role ?? ESCALATION_ROUTES[category].requestedRole;
  if (escalation.category === null || escalation.priority === null || escalation.requested_role === null) {
    notes.push('escalation_defaults_applied');
  }
  return {
    required: true,
    category,
    priority,
    reason:
      escalation.reason !== null && escalation.reason.trim() !== ''
        ? truncate(escalation.reason.trim(), 400)
        : forcedReason(category),
    requested_role: requested,
  };
}

/** Every human-readable string in a response, for leak scanning. */
export function responseStrings(r: CoachResponse): string[] {
  const out: string[] = [r.answer];
  for (const c of r.claims) out.push(c.text);
  for (const u of r.uncertainty) out.push(u.item);
  if (r.challenge !== null) out.push(r.challenge);
  for (const a of r.next_actions) out.push(a.owner, a.action);
  if (r.escalation.reason !== null) out.push(r.escalation.reason);
  for (const m of r.memory_candidates) out.push(m.title, m.content);
  out.push(...r.follow_up_questions);
  if (r.rehearsal !== null) {
    out.push(r.rehearsal.counterpart, r.rehearsal.line, r.rehearsal.critique);
    for (const s of r.rehearsal.scores) out.push(s.criterion, s.note);
  }
  if (r.spoken) out.push(r.spoken);
  return out;
}

/**
 * Whether any other venture's distinctive name, member name or canary appears in any of `strings`
 * (the same matching as {@link containsOtherVenture}, for outputs that are not a `CoachResponse`, such
 * as recaps and distillations).
 */
export function textsContainOtherVenture(
  strings: readonly string[],
  otherVentureNames: readonly string[],
  otherVentureCanaries: readonly string[],
  otherVentureMemberNames: readonly string[] = [],
): boolean {
  if (
    otherVentureNames.length === 0 &&
    otherVentureCanaries.length === 0 &&
    otherVentureMemberNames.length === 0
  )
    return false;
  const text = strings.map(normalizeForMatching).join('\n');
  const compact = text.replace(/[\s\u200B-\u200D]+/g, '');
  for (const name of otherVentureNames) {
    const pattern = ventureNameRegExp(name);
    if (pattern?.test(text)) return true;
  }
  for (const name of otherVentureMemberNames) {
    const pattern = personNameRegExp(name);
    if (pattern?.test(text)) return true;
  }
  for (const canary of otherVentureCanaries) {
    const needle = normalizeForMatching(canary);
    if (needle.length < 4) continue;
    if (text.includes(needle) || compact.includes(needle.replace(/\s+/g, ''))) return true;
  }
  return false;
}

/**
 * Whether any other venture's distinctive name (whole phrase, case/whitespace-insensitive; names that are
 * common words are skipped, see `ventureNameProblem`), canary (substring,
 * case-insensitive, also with whitespace removed) or member's display name (whole phrase, names of two
 * or more words only) appears anywhere in the response.
 */
export function containsOtherVenture(
  response: CoachResponse,
  otherVentureNames: readonly string[],
  otherVentureCanaries: readonly string[],
  otherVentureMemberNames: readonly string[] = [],
): boolean {
  return textsContainOtherVenture(
    responseStrings(response),
    otherVentureNames,
    otherVentureCanaries,
    otherVentureMemberNames,
  );
}
