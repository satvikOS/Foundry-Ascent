import { isEverydayWord, rewriteIdentity, textsContainOtherVenture, toSpeakable } from '@foundry/ai';
import {
  CallHeartbeatRequest,
  EndCallRequest,
  InterruptTurnRequest,
  StartCallRequest,
  type CallDetailResponse,
  type CallEndReason,
  type CallNoticeAcknowledgement,
  type CallHeartbeatResponse,
  type CallSummary,
  type EndCallResponse,
  type NextAction,
  type SpeechUnit,
  type StartCallResponse,
  type SttGrant,
} from '@foundry/contracts';
import {
  assignmentsRepo,
  callsRepo,
  personasRepo,
  principalsRepo,
  sessionsRepo,
  settingsRepo,
  turnsRepo,
  twinRepo,
  usageRepo,
  venturesRepo,
  type SqlExecutor,
} from '@foundry/db';
import { type z } from 'zod';

import { type PlatformKeyCache } from '../auth/keys.js';
import {
  checkAssignment,
  decideVentureAccess,
  requireAssignmentActive,
  requireVentureAccess,
} from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { type DirectoryCache } from '../internal/directory.js';
import { readOpener, type OpenerSubject } from '../orchestrator/continuity-prompt.js';
import {
  endsOnItsVerb,
  isVenting,
  readsAsSubject,
  topicWords,
  withoutDiscourseWords,
} from '../orchestrator/opener-topic.js';
import { chooseOpener } from '../orchestrator/continuity.js';
import { type DistillService } from './distill.js';
import { mentionsEir, personaNameClaimsEir, veirEirName } from '../internal/eir-names.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { signSpeechUnit, verifySpeechUnit } from '../orchestrator/speech-units.js';
import { warmTurnEngine } from '../orchestrator/warm-up.js';
import { SttGrantError } from '../ports.js';
import {
  CALL_LIMITS,
  STOP_REASON,
  callSecondsToday,
  callStopCause,
  callTimeLeft,
  newCallMaxSeconds,
  transcriptionCostUsd,
  type CallConditions,
  type CallStopCause,
} from './call-usage.js';
import { type FaceHooks, type FaceStopCause, faceStopCause } from './face.js';
import { speakableRun, speakableText } from './spoken-text.js';
import { DEFAULT_SPEECH_VOICE } from './voices.js';

/**
 * Voice calls (docs/architecture/calls.md §2). A call is a mode of a conversation: what is said becomes the
 * conversation's turns (`channel: 'voice'`, through the normal turn endpoint and its validators). This service
 * starts calls (admission, the speech-to-text grant and the signed intro), keeps them alive (heartbeats carry
 * the kill switches, consent and budgets), records barge-in, and ends them with a summary.
 */
export interface CallsService {
  /** Starts a call on an active conversation (founder/team, as themselves). */
  start(
    ctx: RequestContext,
    sessionId: string,
    input: z.input<typeof StartCallRequest>,
  ): Promise<StartCallResponse>;
  /** A fresh speech-to-text grant for a live call of the caller (reconnect, unmute). */
  sttGrant(ctx: RequestContext, callId: string): Promise<SttGrant>;
  /** Liveness every 15 s: time left, or `terminate` with the reason (the call is then ended). */
  heartbeat(
    ctx: RequestContext,
    callId: string,
    input: z.input<typeof CallHeartbeatRequest>,
  ): Promise<CallHeartbeatResponse>;
  /** Ends a call of the caller (idempotent) and summarizes it. */
  end(ctx: RequestContext, callId: string, input: z.input<typeof EndCallRequest>): Promise<EndCallResponse>;
  /** A call and, once it ended, its summary (venture members). */
  get(ctx: RequestContext, callId: string): Promise<z.infer<typeof CallDetailResponse>>;
  /** Barge-in: the founder spoke over a reply after hearing units 0…`heardSeq`. */
  interrupt(ctx: RequestContext, turnId: string, input: z.input<typeof InterruptTurnRequest>): Promise<void>;
  /**
   * The caller read the first-call privacy notice: stored with the person (their own value only), once.
   * Idempotent: a repeat returns the first time and is not audited again.
   */
  acknowledgeNotice(ctx: RequestContext): Promise<CallNoticeAcknowledgement>;
}

/** Language and audio format of speech-to-text (the browser streams 16 kHz mono PCM). */
export const STT_LANGUAGE = 'en-US';
export const STT_SAMPLE_RATE_HERTZ = 16_000;
/** Next actions listed in a call summary. */
export const SUMMARY_MAX_ACTIONS = 10;

type PersonaVoiceFacts = Pick<personasRepo.PersonaRecord, 'kind' | 'embodiment'>;

/**
 * The voice a call speaks with: the persona's own voice (an EIR persona's only while its consent covers
 * voice; the neutral guide needs none), else the platform voice. Null when an EIR persona has a voice of its
 * own that its consent no longer covers: a call never falls back to another voice.
 */
export function callVoiceFor(persona: PersonaVoiceFacts, consentAssets: readonly string[]): string | null {
  const own = persona.embodiment.voiceId;
  if (own === null) return DEFAULT_SPEECH_VOICE;
  return persona.kind === 'neutral_guide' || consentAssets.includes('voice') ? own : null;
}

/**
 * The cloned voice a new call speaks with, or `polly` (the persona's stock voice): the EIR's clone at the vendor
 * the API is wired to, only while cloned voices are on and the persona's voice is ready under voice consent.
 */
export function callVoiceVendor(args: {
  readonly clonedVoiceEnabled: boolean;
  readonly provider: { readonly id: 'elevenlabs' | 'fake' } | undefined;
  readonly twinVoice: { readonly ref: string } | null;
}): callsRepo.CallVoiceVendor {
  if (!args.clonedVoiceEnabled || args.provider === undefined || args.twinVoice === null) return 'polly';
  return args.provider.id;
}

/**
 * Whether a live call may still speak: its stock voice is approved, or it started with the EIR's cloned voice,
 * which falls back to the platform voice when the clone is withdrawn (the call goes on, never in another
 * person's voice).
 */
export function callCanSpeak(
  call: Pick<callsRepo.CallRecord, 'voiceId' | 'voiceVendor'>,
  persona: PersonaVoiceFacts,
  consentAssets: readonly string[],
): boolean {
  return call.voiceVendor !== 'polly' || voiceApproved(call.voiceId, persona, consentAssets);
}

/** Whether a call's voice is still approved: the platform voice always; an EIR's own voice under consent. */
export function voiceApproved(
  voiceId: string,
  persona: PersonaVoiceFacts,
  consentAssets: readonly string[],
): boolean {
  return (
    voiceId === DEFAULT_SPEECH_VOICE || persona.kind === 'neutral_guide' || consentAssets.includes('voice')
  );
}

export { mentionsEir, personaNameClaimsEir };

/** The founder's first name for a greeting (null when the display name does not start with a plain name). */
export function greetingName(displayName: string): string | null {
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  return /^\p{L}[\p{L}'’-]{0,39}$/u.test(first) ? first : null;
}

/**
 * The name the vEIR introduces itself with: the persona's name, unless that name presents it as an EIR; then
 * "{EIR's first name}'s vEIR" for an EIR persona, or "your vEIR".
 */
export function introName(args: {
  readonly personaName: string;
  readonly personaKind: personasRepo.PersonaRecord['kind'];
  readonly eirDisplayName: string | null;
  readonly eirNames: readonly string[];
}): string {
  if (!personaNameClaimsEir(args.personaName, args.eirNames)) return args.personaName;
  const first = args.eirDisplayName?.trim().split(/\s+/)[0] ?? '';
  return args.personaKind === 'eir_persona' && first !== '' ? `${first}'s vEIR` : 'your vEIR';
}

/** The longest repeat-call greeting, in characters (about four seconds said; the lab heard 103–114 over two sentences). */
export const REPEAT_GREETING_MAX_CHARS = 90;

/** A small, stable hash (FNV-1a) choosing a greeting's phrasing per conversation. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A sentence as it continues one ("Last time you…" → "last time you…"; a name or "I" keeps its capital). */
function continuing(sentence: string): string {
  const first = /^\p{L}[\p{L}'’]*/u.exec(sentence)?.[0] ?? '';
  return first.length > 1 && /^\p{Lu}\p{Ll}/u.test(first) && isEverydayWord(first)
    ? `${first.toLowerCase()}${sentence.slice(first.length)}`
    : sentence;
}

/** The sentences of a short line. */
function sentencesOf(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((part) => part !== '');
}

/** A greeting sentence an opener may open with: the call's "Hi Maya" already greets. */
const OPENER_GREETING =
  /^(?:good to (?:have you (?:back|here)|talk again|see you(?: again)?)|welcome back|nice to hear from you(?: again)?|hi|hello|hey)\b[^.!?]*[.!]$/i;

/** A question without its trailing alternative ("Want to pick that up, or is something else on your mind?"). */
function withoutAlternative(sentence: string): string {
  return sentence.replace(/,\s+or\s+(?:is\s+)?(?:something|start|anything)\b[^?]*\?$/i, '?');
}

/** A time said at the end of a phrase ("… on Monday", "… this week", "… tomorrow"). */
const TIME_TAIL =
  /\s+(?:(?:on|by|this|next|last|before|after|until|till|in|at|from|over|during|for)\s+(?:the\s+)?(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\s+(?:morning|afternoon|evening|night))?|weekend|week|month|term|semester|quarter|year|morning|afternoon|evening|night|end of (?:the\s+)?(?:week|month|term|semester)|exams?|\d[\w:./-]*)|today|tomorrow|tonight|yesterday|soon|later)$/i;
/**
 * A plan or a question that ends on a second verb with "and" or "or" and nothing after it ("whether to give up on the
 * B2C market and focus"): cut before that verb's preposition, it is left without what it does. A name after "and" is
 * no verb ("your plan to call Noor and Sam"), nor is a plural or an activity ("sell pens and pencils", "rethink
 * pricing and marketing"); case matters, so no `i` flag.
 */
const JOINED_VERB =
  /^(?:(?:your|the|their|our)\s+(?:[\p{L}'’-]+['’]s\s+)?(?:plan|decision|goal|idea)\s+to|whether|how\s+to|what\s+to)\s.*\s(?:and|or)\s+(?!\p{Ll}[\p{L}'’-]*(?:[^su'’]s|ing)$)\p{Ll}[\p{L}'’-]*$/u;
/** Prepositions a long phrase can be cut before, keeping what it names ("the study room for the kickoff"). */
const CUT_BEFORE =
  /\s(?:for|with|at|on|about|before|after|during|by|in|from|via|over|between|across|around)\s/gi;

/**
 * Shorter forms of what an opener is about that still name it, longest first: itself, without a time or an adverb at
 * its ends ("… on Monday", "a short pilot instead" → "a short pilot": the voice suite on 9a2a41f), then cut before each
 * later preposition ("book the Harbour Hall study room for the pilot kickoff" → "book the Harbour Hall study room"),
 * while what is left names something. A greeting too long with the whole phrase says a shorter form instead of
 * dropping it (MX-0022, MX-0024). Only forms that read as a subject (`readsAsSubject`): a lone date, month or single
 * word, a plan without its verb, or one that ends on the founder's adverb, is none ("Hi Idris, want to carry on with
 * January?", lab run 39780304879); empty when no form does. A shorter form never cuts a plan or a question to its
 * verb, nor a fixed phrase ("your plan to break even" stays whole: the review of 1cac704).
 */
export function shorterSubjects(text: string): string[] {
  return candidateSubjects(text).filter(readsAsSubject);
}

/** {@link shorterSubjects} before each form is checked. */
function candidateSubjects(text: string): string[] {
  const out = [text.trim()];
  let current = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const timeless = withoutDiscourseWords(current.replace(TIME_TAIL, '').trim());
    // Never a plan or a question cut to its verb ("whether to hire later" is no "whether to hire": the review of
    // 1cac704).
    if (timeless === current || timeless === '' || endsOnItsVerb(timeless)) break;
    current = timeless;
    out.push(current);
  }
  const cuts = [...current.matchAll(CUT_BEFORE)].map((m) => m.index).reverse();
  for (const at of cuts) {
    const head = withoutDiscourseWords(current.slice(0, at));
    if (head.split(/\s+/).length < 2 || topicWords(head).length === 0) continue;
    // "your plan to call", "your plan to give up", "whether to hire" name no plan and ask nothing (the review of
    // e9e49fb heard "your plan to give up?" for a plan to give up on a product idea), nor does one cut after a verb
    // it joins ("whether to give up on the B2C market and focus").
    if (endsOnItsVerb(head) || JOINED_VERB.test(head)) continue;
    out.push(head);
  }
  return [...new Set(out)];
}

/** A greeting line and whether it says what the opener picks up (`carriesOpener`), or only invites. */
export interface CallGreeting {
  readonly text: string;
  readonly carriesOpener: boolean;
}

/**
 * The greeting of a call with someone the vEIR has met (wave 7): one sentence of at most
 * {@link REPEAT_GREETING_MAX_CHARS} characters, the name and what the conversation opens with in it ("Hi Maya,
 * where are things with the pilot pricing?"). Phrased around the opener's subject when it has one (shortened to fit,
 * never dropped: {@link shorterSubjects}), else the opener itself as one sentence ("Hi Maya, last time you planned
 * five interviews — how did they go?"), else an invitation. `subject`: chosen with the opener (null: it names
 * nothing, so none is read from it), or undefined to read it from the stored sentence (`readOpener`); an opener built
 * around a clause fragment is never said (LAB-R3b). An opener none of this fits is said whole rather than dropped (a
 * person's own words). The phrasing varies with `seed` (the conversation).
 */
export function repeatGreetingOf(args: {
  readonly firstName: string | null;
  readonly opener: string | null;
  readonly subject?: OpenerSubject | null;
  readonly conversationStarted: boolean;
  readonly seed?: string;
}): CallGreeting {
  const hi = args.firstName === null ? 'Hi' : `Hi ${args.firstName}`;
  const seed = seedOf(args.seed ?? '');
  const rotate = (lines: readonly string[]): string[] =>
    lines.map((_, i) => lines[(seed + i) % lines.length] ?? '');
  const fits = (line: string): boolean =>
    line.length <= REPEAT_GREETING_MAX_CHARS && sentencesOf(line).length === 1;
  const read = args.opener === null ? null : readOpener(args.opener);
  const subject = args.subject !== undefined ? args.subject : read === 'fragment' ? null : read;
  // A subject that vents or speaks of the founder's private health is never said, nor the opener built around it.
  const forms =
    subject === null || isVenting(subject.text, args.firstName) ? [] : shorterSubjects(subject.text);
  // An opener chosen around words that are no subject was built around a fragment: neither is said.
  const fragment = read === 'fragment' || (subject !== null && forms.length === 0);
  const candidates: string[] = [];
  if (subject !== null) {
    for (const t of forms) {
      // "your plan to call facilities": "did you get to call facilities?"
      const plan = /^your plan to (.+)$/i.exec(t)?.[1];
      if (subject.kind === 'thread' && plan !== undefined) candidates.push(`${hi}, did you get to ${plan}?`);
      candidates.push(
        ...rotate(
          subject.kind === 'question'
            ? [`${hi}, where did you land on ${t}?`, `${hi}, any more thoughts on ${t}?`]
            : subject.kind === 'thread'
              ? [
                  `${hi}, how did ${t} go?`,
                  `${hi}, where are things with ${t}?`,
                  `${hi}, shall we pick up ${t}?`,
                ]
              : [`${hi}, shall we pick up ${t}?`, `${hi}, want to carry on with ${t}?`],
        ),
      );
    }
  }
  // The opener's own words, without the greeting the call's "Hi" already gives.
  let parts = args.opener === null || fragment ? [] : sentencesOf(args.opener);
  while (parts.length > 1 && OPENER_GREETING.test(parts[0] ?? '')) parts = parts.slice(1);
  const [first, second] = parts;
  const openerLines: string[] = [];
  if (parts.length === 1 && first !== undefined) {
    openerLines.push(`${hi}, ${continuing(first)}`, `${hi}, ${continuing(withoutAlternative(first))}`);
  }
  if (parts.length === 2 && first !== undefined && second !== undefined && /[.!]$/.test(first)) {
    const lead = `${hi}, ${continuing(first.replace(/[.!]$/, ''))} — `;
    openerLines.push(`${lead}${continuing(second)}`, `${lead}${continuing(withoutAlternative(second))}`);
  }
  const found = [...candidates, ...openerLines].find(fits);
  if (found !== undefined) return { text: found, carriesOpener: true };
  if (parts.length > 0) {
    // Nothing shorter says it: the opener whole (one long sentence, or after the greeting) rather than dropped.
    const whole = openerLines[0] ?? `${hi}. ${parts.join(' ')}`;
    return { text: whole, carriesOpener: true };
  }
  return {
    text: args.conversationStarted
      ? `${hi}, where would you like to pick up?`
      : `${hi}, what would you like to work on?`,
    carriesOpener: false,
  };
}

/** The repeat greeting's words ({@link repeatGreetingOf}). */
export function repeatGreeting(args: Parameters<typeof repeatGreetingOf>[0]): string {
  return repeatGreetingOf(args).text;
}

/**
 * The words a call opens with (plain text), the presence policy: on a first meeting the vEIR introduces itself
 * once ("Hi Maya, I'm Corin's vEIR, Corin's digital twin."; the neutral guide as the program's AI coach), then the
 * conversation's opener on a fresh conversation, or an invitation to continue one already under way. Later it
 * just greets, like anyone you have met, in one sentence with the opener in it ({@link repeatGreetingOf}). What a
 * vEIR is, the person read in the welcome. `carriesOpener`: the words say what the opener picks up (a call keeps
 * them as the conversation's first message only then).
 */
export function callIntro(args: {
  readonly firstName: string | null;
  readonly personaName: string;
  /** The EIR's first name for a vEIR ("Corin"); null for the neutral guide. */
  readonly eirFirstName: string | null;
  /** The person has never had a conversation with this vEIR in the venture. */
  readonly firstMeeting: boolean;
  readonly opener: string | null;
  /**
   * What the opener is about (`ChosenOpener.subject`): a repeat greeting is phrased around it. Null: it names
   * nothing; undefined: read from the opener's sentence.
   */
  readonly subject?: OpenerSubject | null;
  readonly conversationStarted: boolean;
  /** Varies a repeat greeting's phrasing (the conversation's id). */
  readonly seed?: string;
}): CallGreeting {
  if (!args.firstMeeting) {
    return repeatGreetingOf({
      firstName: args.firstName,
      opener: args.opener,
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      conversationStarted: args.conversationStarted,
      seed: args.seed ?? '',
    });
  }
  const hi = args.firstName === null ? 'Hi' : `Hi ${args.firstName}`;
  const hello =
    args.eirFirstName === null
      ? `${hi}, I'm ${args.personaName}, the program's AI coach.`
      : `${hi}, I'm ${args.personaName}, ${args.eirFirstName}'s digital twin.`;
  const next =
    args.opener ??
    (args.conversationStarted ? 'Where would you like to pick up?' : 'What would you like to work on?');
  return { text: `${hello} ${next}`, carriesOpener: args.opener !== null };
}

/**
 * What a call that opens a conversation keeps as its first message: what the intro said when it says the opener (the
 * vEIR's history then holds the greeting it gave), else the opener itself, never the bare invitation in its place
 * (MX-0022: "Hi Mina, what would you like to work on?" overwrote a plan to book the study room).
 */
export function openerKept(intro: CallGreeting | null, opener: string | null): string | null {
  return intro?.carriesOpener === true ? intro.text : opener;
}

/** The words of {@link callIntro}. */
export function callIntroText(args: Parameters<typeof callIntro>[0]): string {
  return callIntro(args).text;
}

/** Next actions of a call's replies without repeats (by their words), at most {@link SUMMARY_MAX_ACTIONS}. */
export function distinctActions(actions: readonly NextAction[]): NextAction[] {
  const seen = new Set<string>();
  const out: NextAction[] = [];
  for (const action of actions) {
    const key = action.action.normalize('NFKC').toLowerCase().replace(/\W+/gu, ' ').trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(action);
    if (out.length === SUMMARY_MAX_ACTIONS) break;
  }
  return out;
}

/** Whether `units` are units 0…`heardSeq` in order (none when the founder heard nothing). */
export function heardUnitsInOrder(units: readonly { readonly seq: number }[], heardSeq: number): boolean {
  return units.length === Math.max(0, heardSeq + 1) && units.every((unit, i) => unit.seq === i);
}

/**
 * The summary of a call as `ex` sees it: an assigned EIR, who reads only the turns sampled for review, sees
 * the count, actions and follow-ups of those turns (summaries never reveal turns a reader cannot open).
 */
async function summarize(ex: SqlExecutor, call: callsRepo.CallRecord): Promise<CallSummary> {
  const turns = await callsRepo.listCallTurns(ex, call.id);
  const followUps = await callsRepo.callFollowUps(ex, {
    ventureId: call.ventureId,
    turnIds: turns.map((t) => t.id),
  });
  return {
    turnCount: turns.length,
    durationSeconds: call.elapsedSeconds,
    memoryProposalIds: followUps.memoryProposalIds,
    memoryKeptIds: followUps.memoryKeptIds,
    nextActions: distinctActions(turns.flatMap((t) => t.nextActions)),
    escalationIds: followUps.escalationIds,
  };
}

const AI_PAUSED = 'AI coaching is paused by the program. Please try again later.';
const CALLS_PAUSED = 'Calls are paused by the program. You can keep chatting.';
const CALL_OVER = 'This call has ended.';

/** End reasons a client may give; the server's own causes (budget, time, switches) come from its checks. */
const CLIENT_END_REASONS: ReadonlySet<CallEndReason> = new Set(['user', 'navigated', 'error']);

/** The refusal for a request on a live call that has to stop for `cause` (the next heartbeat ends it). */
export function stopRefusal(cause: CallStopCause, now: Date): DomainError {
  const midnight = { retryAfterSeconds: secondsUntilUtcMidnight(now) };
  switch (cause) {
    case 'kill_switch':
      return new DomainError('ai_disabled', AI_PAUSED, { reason: cause });
    case 'calls_disabled':
      return new DomainError('ai_disabled', CALLS_PAUSED, { reason: cause });
    case 'session_closed':
      return new DomainError('session_ended', 'This conversation has ended.', { reason: cause });
    case 'access_revoked':
      return fail.forbidden(cause);
    case 'persona_unavailable':
    case 'voice_consent':
      return new DomainError('persona_suspended', 'This vEIR cannot take calls right now.', {
        reason: cause,
      });
    case 'stale_heartbeat':
    case 'max_duration':
      return fail.conflict(CALL_OVER, cause);
    case 'spend_cap':
      return new DomainError(
        'spend_cap_reached',
        'The daily AI budget has been reached. It resets at midnight UTC.',
        {
          reason: cause,
          ...midnight,
        },
      );
    case 'daily_call_minutes':
      return new DomainError(
        'rate_limited',
        'You have used today’s call minutes. Calls reset at midnight UTC.',
        {
          reason: cause,
          ...midnight,
        },
      );
  }
}

interface Started {
  readonly call: callsRepo.CallRecord;
  readonly ventureId: string;
  readonly personaId: string;
  /** Whether the conversation is standard (remembered); a temporary one opens with nothing picked up. */
  readonly standard: boolean;
  readonly personaName: string;
  readonly personaKind: personasRepo.PersonaRecord['kind'];
  readonly eirDisplayName: string | null;
  readonly firstName: string | null;
  /** The conversation's stored opener (`coaching_sessions.opener`), offered only before its first turn. */
  readonly opener: string | null;
  /**
   * What the opener is about, when it was chosen at call start (null: it names nothing); undefined for the stored
   * sentence (read from it).
   */
  readonly subject?: OpenerSubject | null;
  readonly conversationStarted: boolean;
  /** The caller started no other conversation of the venture: the vEIR introduces itself once. */
  readonly firstMeeting: boolean;
}

export function createCallsService(
  kit: Kit,
  directory: DirectoryCache,
  keys: PlatformKeyCache,
  distill: Pick<DistillService, 'afterCallEnd'>,
  face: FaceHooks,
): CallsService {
  const { logger } = kit.deps;

  /**
   * A call that ends settles what was said in it: once the change commits, its conversation is distilled now,
   * however the call ended (hang-up, a server stop, replacement), as ending a chat does. The trigger never
   * fails the request.
   */
  function settleAfterCommit(scope: RequestScope, sessionId: string): void {
    scope.afterCommit(() => distill.afterCallEnd(scope.ctx, sessionId));
  }

  /** A call that ended (any path) ends its face: the database did at once; the vendor session ends after commit. */
  function closeFaceAfterCommit(scope: RequestScope, call: callsRepo.CallRecord): void {
    if (kit.deps.embodiment === undefined) return;
    scope.afterCommit(() => face.afterCallEnded(scope.ctx, { id: call.id, ventureId: call.ventureId }));
  }

  /** The caller's own call; anyone else's (or none) is reported as not found. */
  async function ownCall(scope: RequestScope, callId: string): Promise<callsRepo.CallRecord> {
    const call = await callsRepo.getCall(scope.tx, callId);
    if (call?.startedBy !== scope.ctx.principalId) {
      scope.deferAudit({
        action: 'call.access',
        outcome: 'denied',
        ventureId: call?.ventureId ?? null,
        objectType: 'call',
        objectId: callId,
        policyReason: call === null ? 'call_not_visible' : 'not_call_owner',
      });
      throw fail.notFound('Call');
    }
    return call;
  }

  async function conditions(scope: RequestScope, call: callsRepo.CallRecord): Promise<CallConditions> {
    const { tx, ctx } = scope;
    const settings = await settingsRepo.getPlatformSettings(tx);
    const session = await sessionsRepo.getSession(tx, call.sessionId);
    const access = decideVentureAccess(
      await venturesRepo.getVentureAccess(tx, { ventureId: call.ventureId, principalId: ctx.principalId }),
      ctx,
      'write',
    );
    const assignment = checkAssignment(await assignmentsRepo.resolveActiveAssignment(tx, call.ventureId));
    const persona = await personasRepo.getPersona(tx, call.personaId);
    const assets = persona === null ? [] : await personasRepo.personaConsentAssets(tx, call.personaId);
    const spendCap = await turnsRepo.spendCapState(tx, {
      globalUsd: settings.dailyUsdCapGlobal,
      principalUsd: settings.dailyUsdCapPerPrincipal,
    });
    return {
      aiEnabled: settings.aiEnabled,
      callsEnabled: settings.callsEnabled,
      sessionActive: session?.status === 'active',
      canWrite: access.allowed,
      personaAvailable:
        !(assignment instanceof DomainError) &&
        assignment.persona.id === call.personaId &&
        assignment.assignment.id === session?.assignmentId,
      voiceApproved: persona !== null && callCanSpeak(call, persona, assets),
      idleSeconds: call.idleSeconds,
      spendCapReached: spendCap !== null,
      timeLeft: callTimeLeft({
        elapsedSeconds: call.elapsedSeconds,
        maxSeconds: call.maxSeconds,
        usedSecondsToday: await callSecondsToday(tx, ctx.principalId),
        caps: settings,
      }),
    };
  }

  /**
   * Ends a live call for `cause` (audited with the change) and settles its conversation, unless `settle` is
   * false (a new call is starting in that same conversation: it is not over); returns the call as it now stands.
   */
  async function stop(
    scope: RequestScope,
    call: callsRepo.CallRecord,
    cause: CallStopCause | 'replaced',
    clientStats?: callsRepo.CallClientStats,
    settle = true,
  ): Promise<callsRepo.CallRecord> {
    const ended = await callsRepo.endCall(scope.tx, {
      callId: call.id,
      reason: cause === 'replaced' ? 'navigated' : STOP_REASON[cause],
      detail: cause,
      ...(cause === 'stale_heartbeat' ? { atLastHeartbeat: { graceSeconds: CALL_LIMITS.staleSeconds } } : {}),
      ...(clientStats === undefined ? {} : { clientStats }),
    });
    if (ended === null) return (await callsRepo.getCall(scope.tx, call.id)) ?? call;
    if (settle) settleAfterCommit(scope, call.sessionId);
    closeFaceAfterCommit(scope, call);
    await audit(scope, {
      action: cause === 'replaced' ? 'call.ended' : 'call.terminated',
      outcome: cause === 'replaced' ? 'succeeded' : 'blocked',
      ventureId: call.ventureId,
      objectType: 'call',
      objectId: call.id,
      policyReason: cause,
      metadata: { durationSeconds: ended.elapsedSeconds, reason: ended.endReason },
    });
    return ended;
  }

  /** What a call's intro is checked against (the tenant's EIR names and the other ventures; cached). */
  interface IntroGuards {
    readonly eirNames: readonly string[];
    readonly others: {
      readonly names: string[];
      readonly canaries: string[];
      readonly memberNames: string[];
    };
  }

  /**
   * The words a call opens with (`callIntro`), checked: the opener is a person-editable note, spoken only when it
   * names no EIR at all (no endorsement, review or presence claims) and passes the identity and cross-venture rules;
   * otherwise the greeting without it. Null when nothing can be said.
   */
  function introWords(started: Started, guards: IntroGuards): CallGreeting | null {
    const personaName = introName({
      personaName: started.personaName,
      personaKind: started.personaKind,
      eirDisplayName: started.eirDisplayName,
      eirNames: guards.eirNames,
    });
    const safe = (text: string): boolean =>
      rewriteIdentity(text, { personaName, eirNames: guards.eirNames, checkHumanClaims: true }).findings
        .length === 0 &&
      !textsContainOtherVenture(
        [text],
        guards.others.names,
        guards.others.canaries,
        guards.others.memberNames,
      );
    const opener = started.opener === null ? '' : toSpeakable(started.opener).trim();
    const eirFirstName =
      started.personaKind === 'eir_persona' ? (started.eirDisplayName?.trim().split(/\s+/)[0] ?? null) : null;
    const base = {
      firstName: started.firstName,
      personaName,
      eirFirstName: eirFirstName === '' ? null : eirFirstName,
      firstMeeting: started.firstMeeting,
      seed: started.call.sessionId,
      conversationStarted: started.conversationStarted,
    };
    const candidates = [
      ...(opener === '' || mentionsEir(opener, guards.eirNames) || !safe(opener)
        ? []
        : [
            callIntro({
              ...base,
              opener,
              // Chosen with the opener at call start (null: it names nothing), else read from the stored sentence.
              ...(started.subject === undefined ? {} : { subject: started.subject }),
            }),
          ]),
      callIntro({ ...base, opener: null }),
    ];
    return candidates.find((c) => c.text.length <= 600 && safe(c.text)) ?? null;
  }

  /**
   * A call's intro, signed (null when it cannot be produced; the call then simply starts listening). A call that
   * starts a conversation nobody has said anything in opens with what is true now: the opener is chosen again at
   * call start (the founder may have talked elsewhere since the conversation was created, e.g. a call from New chat
   * right after another call), and the conversation keeps what the intro said as its first message (its opener), so
   * the vEIR's history holds the greeting it gave: its first reply never greets again or re-asks it (wave 7;
   * production: "Hi Mina…" then "Hello Mina, nice to hear from you."). An intro that does not say the opener (only
   * "what would you like to work on?") never replaces a substantive one: the conversation keeps the opener. Chosen,
   * phrased and kept in one transaction, before the call responds. Drawn from the same conversation as the opener it
   * says, so deleting that conversation erases this copy too. Unchanged for a temporary conversation or one already
   * under way; on any failure the stored opener stands and the call still opens.
   */
  async function openCall(ctx: RequestContext, started: Started): Promise<SpeechUnit | null> {
    try {
      const { eirNames } = await directory.get(ctx.tenantId);
      const others = await directory.others(ctx.tenantId, started.ventureId);
      const guards: IntroGuards = { eirNames, others };
      let words: CallGreeting | null = null;
      if (started.standard && !started.conversationStarted) {
        try {
          const team = await directory.addressees(ctx.tenantId, started.ventureId);
          words = await kit.inRequest(ctx, async ({ tx }) => {
            const { opener: chosen } = await chooseOpener(tx, {
              ventureId: started.ventureId,
              persona: { id: started.personaId, name: started.personaName },
              principalId: ctx.principalId,
              guards: {
                eirNames,
                otherVentureNames: others.names,
                otherVentureCanaries: others.canaries,
                otherVentureMemberNames: others.memberNames,
              },
              now: kit.now(),
              sessionId: started.call.sessionId,
              team,
            });
            const opened: Started = {
              ...started,
              opener: chosen?.text ?? null,
              ...(chosen === null ? { subject: null } : { subject: chosen.subject }),
            };
            const intro = introWords(opened, guards);
            const keep = openerKept(intro, opened.opener);
            if (keep === started.opener) return intro;
            const stored = await sessionsRepo.setSessionOpener(tx, {
              sessionId: started.call.sessionId,
              opener: keep,
              sourceSessionId: chosen?.sourceSessionId ?? null,
              byPerson: chosen?.byPerson ?? false,
            });
            // Someone spoke in the conversation meanwhile: the stored opener stands.
            return stored ? intro : introWords(started, guards);
          });
        } catch (err) {
          logger.warn('call.opener_refresh_failed', {
            requestId: ctx.requestId,
            callId: started.call.id,
            error: err instanceof Error ? err.name : 'unknown',
          });
          words = null;
        }
      }
      words ??= introWords(started, guards);
      if (words === null) return null;
      const key = await keys.signingKey();
      return {
        text: words.text,
        sig: signSpeechUnit(key, {
          sessionId: started.call.sessionId,
          turnId: null,
          seq: 0,
          text: words.text,
        }),
      };
    } catch (err) {
      logger.warn('call.intro_failed', {
        requestId: ctx.requestId,
        callId: started.call.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return null;
    }
  }

  /**
   * Warms the turn engine for the call's first turn with the guard names that turn will use (warm-up.ts), read from the
   * directory the greeting just filled. Logs how long it took (numbers only); never rejects.
   */
  async function warmTurnFor(ctx: RequestContext, started: Started): Promise<void> {
    const began = performance.now();
    try {
      const { eirNames } = await directory.get(ctx.tenantId);
      const others = await directory.others(ctx.tenantId, started.ventureId);
      await warmTurnEngine({
        personaName: started.personaName,
        personaEirName: started.eirDisplayName,
        eirNames,
        addressees: await directory.addressees(ctx.tenantId, started.ventureId),
        founderName: started.firstName,
        otherVentureNames: others.names,
        otherVentureCanaries: others.canaries,
        otherVentureMemberNames: others.memberNames,
      });
      logger.info('call.turn_warm_up', {
        requestId: ctx.requestId,
        callId: started.call.id,
        ms: Math.round(performance.now() - began),
      });
    } catch (err) {
      logger.warn('call.turn_warm_up_failed', {
        requestId: ctx.requestId,
        callId: started.call.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  /** Mints a speech-to-text grant (already counted against the call). */
  async function mint(ctx: RequestContext, callId: string): Promise<SttGrant> {
    const issuer = kit.deps.sttGrants;
    if (issuer === undefined) {
      throw new DomainError(
        'speech_unavailable',
        'Speech recognition is not available on this server. You can type instead.',
        { reason: 'stt_not_configured' },
      );
    }
    try {
      const grant = await issuer.issue({
        languageCode: STT_LANGUAGE,
        sampleRateHertz: STT_SAMPLE_RATE_HERTZ,
        expiresInSeconds: CALL_LIMITS.sttGrantSeconds,
        requestId: ctx.requestId,
      });
      return {
        url: grant.url,
        expiresAt: grant.expiresAt,
        languageCode: STT_LANGUAGE,
        sampleRateHertz: STT_SAMPLE_RATE_HERTZ,
        mediaEncoding: 'pcm',
      };
    } catch (err) {
      logger.warn('call.stt_grant_failed', {
        requestId: ctx.requestId,
        callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
      throw new DomainError(
        'model_unavailable',
        'Speech recognition is temporarily unavailable. You can type instead.',
        {
          reason: 'stt_grant_failed',
          retryAfterSeconds: 5,
          cause: err instanceof SttGrantError ? err : undefined,
        },
      );
    }
  }

  /**
   * Meters speech-to-text: the microphone seconds a heartbeat added, at the Transcribe rate, in the usage
   * ledger (purpose `speech`, so the daily spend caps cover it). Never throws.
   */
  async function meterTranscription(
    ctx: RequestContext,
    usage: { readonly callId: string; readonly ventureId: string; readonly seconds: number },
  ): Promise<void> {
    try {
      await kit.system(
        (sx) =>
          usageRepo.recordUsage(sx, {
            tenantId: ctx.tenantId,
            ventureId: usage.ventureId,
            principalId: ctx.principalId,
            purpose: 'speech',
            modelId: `transcribe:streaming:${STT_LANGUAGE}`,
            inputTokens: usage.seconds,
            outputTokens: 0,
            costUsd: transcriptionCostUsd(usage.seconds),
            requestId: ctx.requestId,
          }),
        { transaction: false },
      );
    } catch (err) {
      logger.error('call.stt_usage_record_failed', {
        requestId: ctx.requestId,
        callId: usage.callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  return {
    start: async (ctx, rawSessionId, rawInput) => {
      const sessionId = requireId(rawSessionId, 'Session');
      const input = parseInput(StartCallRequest, rawInput);
      const started = await kit.inRequest(ctx, async (scope): Promise<Started> => {
        const { tx } = scope;
        const session = await sessionsRepo.getSession(tx, sessionId);
        if (session === null) throw fail.notFound('Session');
        await requireVentureAccess(scope, session.ventureId, 'write', {
          objectType: 'session',
          objectId: sessionId,
        });
        const ventureId = session.ventureId;
        const refuse = (error: DomainError): DomainError => {
          scope.deferAudit({
            action: 'call.refused',
            outcome: 'blocked',
            ventureId,
            objectType: 'session',
            objectId: sessionId,
            policyReason: error.reason ?? error.code,
          });
          return error;
        };
        if (session.status !== 'active') {
          throw refuse(
            new DomainError('session_ended', 'This conversation has ended. Start a new one to call.', {
              reason: `session_${session.status}`,
            }),
          );
        }
        const settings = await settingsRepo.getPlatformSettings(tx);
        if (!settings.aiEnabled) {
          throw refuse(new DomainError('ai_disabled', AI_PAUSED, { reason: 'kill_switch' }));
        }
        if (!settings.callsEnabled) {
          throw refuse(new DomainError('ai_disabled', CALLS_PAUSED, { reason: 'calls_disabled' }));
        }
        const active = await requireAssignmentActive(scope, ventureId);
        if (active.assignment.id !== session.assignmentId) {
          throw refuse(
            new DomainError(
              'assignment_inactive',
              'The coaching assignment for this venture changed. Start a new conversation to call.',
              { reason: 'assignment_changed' },
            ),
          );
        }
        const persona = await personasRepo.getPersona(tx, active.persona.id);
        if (persona === null) throw fail.notFound('Coach');
        const voiceId = callVoiceFor(persona, await personasRepo.personaConsentAssets(tx, persona.id));
        if (voiceId === null) {
          throw refuse(
            new DomainError(
              'persona_suspended',
              'This vEIR’s voice consent is not in force, so calls are paused.',
              {
                reason: 'voice_consent',
              },
            ),
          );
        }
        const spendCap = await turnsRepo.spendCapState(tx, {
          globalUsd: settings.dailyUsdCapGlobal,
          principalUsd: settings.dailyUsdCapPerPrincipal,
        });
        if (spendCap !== null) {
          throw refuse(
            new DomainError(
              'spend_cap_reached',
              spendCap === 'global'
                ? 'The daily AI budget for the platform has been reached. Coaching resumes tomorrow (UTC).'
                : 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
              { reason: `${spendCap}_daily_cap`, retryAfterSeconds: secondsUntilUtcMidnight(kit.now()) },
            ),
          );
        }

        // One live call per person, serialised with the person's turn admission: a call whose client went
        // away is closed, a call in this conversation (a reload or a second tab) or one the caller chose to
        // replace is ended, and any other live call is refused.
        await turnsRepo.lockTurnAdmission(tx, ctx.principalId);
        const previous = await callsRepo.getLiveCallOf(tx, ctx.principalId);
        let replaced: string | null = null;
        if (previous !== null) {
          // A call replaced in its own conversation (a reload, a second tab) leaves that conversation going.
          const elsewhere = previous.sessionId !== sessionId;
          if (previous.idleSeconds > CALL_LIMITS.staleSeconds) {
            await stop(scope, previous, 'stale_heartbeat', undefined, elsewhere);
          } else if (!elsewhere || input.replace === true) {
            await stop(scope, previous, 'replaced', undefined, elsewhere);
            replaced = previous.id;
          } else {
            throw refuse(
              fail.conflict(
                'You are already in a call in another conversation. End it to start this one.',
                'call_in_progress',
              ),
            );
          }
        }
        const maxSeconds = newCallMaxSeconds(await callSecondsToday(tx, ctx.principalId), settings);
        if (maxSeconds < CALL_LIMITS.minStartSeconds) {
          throw refuse(
            new DomainError(
              'rate_limited',
              'You have used today’s call minutes. Calls reset at midnight UTC.',
              {
                reason: 'daily_call_minutes',
                retryAfterSeconds: secondsUntilUtcMidnight(kit.now()),
              },
            ),
          );
        }
        // Speech-to-text where it runs and the person has grants left today; typed input otherwise.
        const transcribe =
          input.inputMode === 'transcribe' &&
          kit.deps.sttGrants !== undefined &&
          (await callsRepo.sttGrantsToday(tx, ctx.principalId)) < CALL_LIMITS.sttGrantsPerDay;
        // The EIR's cloned voice when it is on and ready under voice consent; the stock voice is its fallback.
        const voiceVendor = callVoiceVendor({
          clonedVoiceEnabled: settings.clonedVoiceEnabled,
          provider: kit.deps.clonedVoice,
          twinVoice:
            kit.deps.clonedVoice === undefined || !settings.clonedVoiceEnabled
              ? null
              : (await twinRepo.personaTwin(tx, persona.id)).voice,
        });
        const inserted = await callsRepo.startCall(tx, {
          tenantId: ctx.tenantId,
          ventureId,
          sessionId,
          personaId: persona.id,
          startedBy: ctx.principalId,
          provider: persona.embodiment.provider,
          inputMode: transcribe ? 'transcribe' : 'typed',
          voiceId,
          voiceVendor,
          maxSeconds,
        });
        const call = transcribe
          ? ((await callsRepo.recordSttGrant(tx, {
              callId: inserted.id,
              maxGrants: CALL_LIMITS.sttGrantsPerCall,
            })) ?? inserted)
          : inserted;
        await audit(scope, {
          action: 'call.started',
          outcome: 'succeeded',
          ventureId,
          objectType: 'call',
          objectId: call.id,
          metadata: {
            sessionId,
            provider: call.provider,
            inputMode: call.inputMode,
            voiceVendor: call.voiceVendor,
            maxSeconds,
            replacedCallId: replaced,
          },
        });
        const turnCount = await turnsRepo.countSessionTurns(tx, sessionId);
        const principal = await principalsRepo.getPrincipal(tx, ctx.principalId);
        return {
          call,
          ventureId,
          personaId: persona.id,
          standard: session.privacy === 'standard',
          personaName: persona.name,
          personaKind: persona.kind,
          // The vEIR introduces itself after its own EIR, never after the venture's reviewing EIR.
          eirDisplayName: await veirEirName(tx, persona),
          firstName: principal === null ? null : greetingName(principal.displayName),
          // The conversation's own opener, validated when it was created and replayed to the model as its first
          // message, so the call says exactly what the vEIR believes it opened with (none for temporary chats).
          opener: turnCount === 0 ? session.opener : null,
          conversationStarted: turnCount > 0,
          // A first meeting: nothing said yet here, and no earlier conversation. A call in a conversation already
          // under way picks it up instead of introducing the vEIR again.
          firstMeeting:
            turnCount === 0 &&
            !(await sessionsRepo.startedEarlierConversation(tx, {
              ventureId,
              principalId: ctx.principalId,
              exceptSessionId: sessionId,
            })),
        };
      });

      // The connections the call's first turn and its first spoken reply use (the Bedrock runtime and Titan, Polly) are
      // opened while the greeting is prepared, with free requests (LAB-P2: after idle gaps every AWS call paid a new
      // connection). Once the greeting is ready, the turn engine's own code is warmed for the first turn (warm-up.ts:
      // the first turn a process serves paid ~270 ms of first-run CPU before its model call). The host keeps the
      // process alive for both; neither holds the response or fails the call.
      let greetingReady = (): void => undefined;
      const greeted = new Promise<void>((resolve) => {
        greetingReady = resolve;
      });
      const warming = Promise.all([
        kit.deps.gateway.prewarm?.(),
        kit.deps.speech?.prewarm?.(),
        greeted.then(() => warmTurnFor(ctx, started)),
      ]).then(
        () => undefined,
        () => undefined,
      );
      if (kit.deps.afterResponse === undefined) void warming;
      else kit.deps.afterResponse(warming);
      let intro: SpeechUnit | null;
      try {
        intro = await openCall(ctx, started);
      } finally {
        greetingReady();
      }
      let sttGrant: SttGrant | null = null;
      if (started.call.inputMode === 'transcribe') {
        // The call works without it (typed input); the client can ask again through `stt-grant`.
        sttGrant = await mint(ctx, started.call.id).catch(() => null);
      }
      return { call: callsRepo.toCallView(started.call), sttGrant, intro };
    },

    sttGrant: async (ctx, rawCallId) => {
      const callId = requireId(rawCallId, 'Call');
      await kit.inRequest(ctx, async (scope) => {
        const call = await ownCall(scope, callId);
        if (call.status !== 'live') throw fail.conflict(CALL_OVER, 'call_not_active');
        // The same checks as a heartbeat: a grant opens a stream we cannot close, so none is minted for a
        // call that has to stop (the next heartbeat ends it).
        const cause = callStopCause(await conditions(scope, call));
        if (cause !== null) throw stopRefusal(cause, kit.now());
        if (kit.deps.sttGrants === undefined) return;
        if ((await callsRepo.sttGrantsToday(scope.tx, ctx.principalId)) >= CALL_LIMITS.sttGrantsPerDay) {
          throw new DomainError(
            'rate_limited',
            'Speech recognition reconnected too often today. You can type instead.',
            { reason: 'stt_grant_daily_limit', retryAfterSeconds: secondsUntilUtcMidnight(kit.now()) },
          );
        }
        const counted = await callsRepo.recordSttGrant(scope.tx, {
          callId,
          maxGrants: CALL_LIMITS.sttGrantsPerCall,
        });
        if (counted === null) {
          throw new DomainError('rate_limited', 'This call reconnected too often. Start a new call.', {
            reason: 'stt_grant_limit',
            retryAfterSeconds: 60,
          });
        }
        await audit(scope, {
          action: 'call.stt_granted',
          outcome: 'succeeded',
          ventureId: call.ventureId,
          objectType: 'call',
          objectId: callId,
          metadata: { grants: counted.sttGrants },
        });
      });
      return mint(ctx, callId);
    },

    heartbeat: async (ctx, rawCallId, rawInput) => {
      const callId = requireId(rawCallId, 'Call');
      const input = parseInput(CallHeartbeatRequest, rawInput);
      const beat = await kit.inRequest(
        ctx,
        async (
          scope,
        ): Promise<{
          response: CallHeartbeatResponse;
          micSeconds: number;
          ventureId: string;
          /** Whether the face (if any) has to stop, and why; undefined when no face is wired. */
          faceStop?: FaceStopCause | null;
          /** The video minutes a person may use a month (checked once the transaction is done). */
          faceMonthMinutes?: number;
        }> => {
          const call = await ownCall(scope, callId);
          const over = (reason: CallEndReason | null): typeof beat => ({
            response: { remainingSeconds: 0, action: 'terminate', reason },
            micSeconds: 0,
            ventureId: call.ventureId,
          });
          if (call.status === 'ended') return over(call.endReason);
          const state = await conditions(scope, call);
          const cause = callStopCause(state);
          if (cause !== null) return over((await stop(scope, call, cause)).endReason ?? STOP_REASON[cause]);
          const recorded = await callsRepo.recordHeartbeat(scope.tx, {
            callId,
            state: input.state,
            micOpenSeconds: input.micOpenSeconds,
          });
          if (recorded === null) return over('user');
          const result: typeof beat = {
            response: { remainingSeconds: state.timeLeft.seconds, action: 'continue', reason: null },
            // Only a call that was granted speech-to-text streams audio to Transcribe.
            micSeconds: recorded.call.inputMode === 'transcribe' ? recorded.micSecondsAdded : 0,
            ventureId: call.ventureId,
          };
          if (kit.deps.embodiment === undefined) return result;
          // The face's own switches: read here, applied (and metered) once this transaction is done.
          const settings = await settingsRepo.getPlatformSettings(scope.tx);
          const faceSettings = {
            facesEnabled: settings.facesEnabled,
            faceMinutesPerPrincipalMonth: settings.faceMinutesPerPrincipalMonth,
            faceMinutesPerCall: settings.faceMinutesPerCall,
          };
          const { twinFace } = await face.stopInputs(scope, call, faceSettings);
          return {
            ...result,
            // The platform's spend cap ends the whole call (above); the month's video minutes are read below.
            faceStop: faceStopCause({
              settings: faceSettings,
              provider: kit.deps.embodiment,
              twinFace,
              monthSecondsUsed: 0,
              spendCapReached: false,
              clientOff: input.face === 'off',
            }),
            faceMonthMinutes: settings.faceMinutesPerPrincipalMonth,
          };
        },
      );
      if (beat.micSeconds > 0) {
        await meterTranscription(ctx, { callId, ventureId: beat.ventureId, seconds: beat.micSeconds });
      }
      if (beat.faceStop !== undefined && beat.response.action === 'continue') {
        // The face's video minutes (the call's limit, the month's, read with the owner role) decide there too.
        const faceAction = await face.heartbeat(
          ctx,
          { id: callId, ventureId: beat.ventureId },
          { stopCause: beat.faceStop, monthMinutes: beat.faceMonthMinutes ?? 0 },
        );
        if (faceAction !== undefined) return { ...beat.response, face: faceAction };
      }
      return beat.response;
    },

    end: async (ctx, rawCallId, rawInput) => {
      const callId = requireId(rawCallId, 'Call');
      const input = parseInput(EndCallRequest, rawInput);
      return kit.inRequest(ctx, async (scope): Promise<EndCallResponse> => {
        const { tx } = scope;
        let call = await ownCall(scope, callId);
        if (call.status === 'live') {
          // A call that has to stop ends for the server's reason; otherwise for the client's, which can only
          // be one a client knows first-hand (it hung up, navigated away or failed).
          const cause = callStopCause(await conditions(scope, call));
          if (cause !== null) {
            call = await stop(scope, call, cause, input.clientStats);
          } else {
            const reason = CLIENT_END_REASONS.has(input.reason) ? input.reason : 'user';
            const ended = await callsRepo.endCall(tx, {
              callId,
              reason,
              detail: `client_${input.reason}`,
              ...(input.clientStats === undefined ? {} : { clientStats: input.clientStats }),
            });
            if (ended !== null) {
              settleAfterCommit(scope, call.sessionId);
              closeFaceAfterCommit(scope, call);
              await audit(scope, {
                action: 'call.ended',
                outcome: 'succeeded',
                ventureId: call.ventureId,
                objectType: 'call',
                objectId: callId,
                metadata: { reason, durationSeconds: ended.elapsedSeconds },
              });
            }
            call = ended ?? (await callsRepo.getCall(tx, callId)) ?? call;
          }
        }
        return { call: callsRepo.toCallView(call), summary: await summarize(tx, call) };
      });
    },

    get: async (ctx, rawCallId) => {
      const callId = requireId(rawCallId, 'Call');
      return kit.inRequest(ctx, async (scope) => {
        const call = await callsRepo.getCall(scope.tx, callId);
        if (call === null) throw fail.notFound('Call');
        await requireVentureAccess(scope, call.ventureId, 'read', { objectType: 'call', objectId: callId });
        return {
          call: callsRepo.toCallView(call),
          summary: call.status === 'ended' ? await summarize(scope.tx, call) : null,
        };
      });
    },

    interrupt: async (ctx, rawTurnId, rawInput) => {
      const turnId = requireId(rawTurnId, 'Turn');
      const input = parseInput(InterruptTurnRequest, rawInput);
      const callId = requireId(input.callId, 'Call');
      if (input.heardSeq > callsRepo.MAX_SPEECH_SEQ) {
        throw fail.validation('The request is not valid', [{ path: 'heardSeq', message: 'Too large' }]);
      }
      const heard = input.heard ?? null;
      if (heard !== null && !heardUnitsInOrder(heard, input.heardSeq)) {
        throw fail.validation('The request is not valid', [
          { path: 'heard', message: 'Must be the units 0…heardSeq, in order' },
        ]);
      }
      const verificationKeys = heard?.some((u) => u.sig !== undefined) ? await keys.verificationKeys() : [];
      await kit.inRequest(ctx, async (scope) => {
        const call = await ownCall(scope, callId);
        if (call.status !== 'live') throw fail.conflict(CALL_OVER, 'call_not_active');
        const turn = await callsRepo.getSpokenTurn(scope.tx, turnId);
        if (turn?.callId !== callId || turn.authorId !== ctx.principalId) throw fail.notFound('Turn');
        // What the founder heard, kept only as validated words: units signed for this turn, or whole sentences
        // of its stored spoken reply.
        let heardText: string | null = null;
        if (heard !== null && heard.length > 0) {
          const words: string[] = [];
          for (const unit of heard) {
            const verified =
              unit.sig === undefined
                ? turn.status === 'completed'
                  ? speakableRun(unit.text, turn.spoken)
                  : null
                : verifySpeechUnit(
                      verificationKeys,
                      { sessionId: call.sessionId, turnId, seq: unit.seq, text: unit.text },
                      unit.sig,
                    )
                  ? speakableText(unit.text)
                  : null;
            if (verified === null) {
              scope.deferAudit({
                action: 'turn.interrupt_refused',
                outcome: 'denied',
                ventureId: call.ventureId,
                objectType: 'turn',
                objectId: turnId,
                policyReason: unit.sig === undefined ? 'text_not_validated' : 'signature_invalid',
                metadata: { callId, seq: unit.seq },
              });
              throw fail.validation('Only the vEIR’s validated words can be recorded as heard', [
                { path: `heard.${String(unit.seq)}`, message: 'Not validated text of this reply' },
              ]);
            }
            words.push(verified);
          }
          heardText = words.join(' ').slice(0, callsRepo.MAX_HEARD_CHARS);
        }
        const marked = await callsRepo.markTurnInterrupted(scope.tx, {
          turnId,
          callId,
          authorId: ctx.principalId,
          heardSeq: input.heardSeq,
          heardText,
        });
        if (marked === null) throw fail.conflict('This conversation has ended.', 'session_not_active');
        await audit(scope, {
          action: 'turn.interrupted',
          outcome: 'succeeded',
          ventureId: call.ventureId,
          objectType: 'turn',
          objectId: turnId,
          metadata: { callId, heardSeq: marked.heardSeq, heardUnits: heard?.length ?? null },
        });
      });
    },

    acknowledgeNotice: async (ctx) =>
      kit.inRequest(ctx, async (scope) => {
        const acknowledged = await principalsRepo.acknowledgeCallNotice(scope.tx);
        if (acknowledged === null) {
          throw new DomainError('unauthenticated', 'Please sign in again.', {
            reason: 'principal_unavailable',
          });
        }
        if (acknowledged.firstTime) {
          await audit(scope, {
            action: 'call.notice_acknowledged',
            outcome: 'succeeded',
            objectType: 'principal',
            objectId: ctx.principalId,
          });
        }
        return { acknowledgedAt: acknowledged.acknowledgedAt };
      }),
  };
}
