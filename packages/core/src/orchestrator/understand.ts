import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_VOICE_SYSTEM_PROMPT,
  SUMS_SYSTEM_PROMPT,
  UNDERSTAND_JUDGE_WAIT_MS,
  UNDERSTAND_MAX_OUTPUT_TOKENS,
  UNDERSTAND_PARTS,
  UNDERSTAND_SCHEMAS,
  UNDERSTAND_SCHEMA_NAMES,
  exchangesInView,
  isModelGatewayError,
  readJudge,
  readParts,
  readRoute,
  readSums,
  routeSystemPrompt,
  sumsAgain,
  sumsDue,
  understandCacheHint,
  understandMessages,
  type ChatMessage,
  type GenerateStructuredResult,
  type HistoryTurn,
  type PromptCacheHint,
  type PromptContinuity,
  type RouteReading,
  type Understanding,
  type UnderstandContext,
  type UnderstandForm,
  type UnderstandPart,
  type UnderstandPlay,
  type UnderstandReadings,
} from '@foundry/ai';
import { type CoachMode, type TurnChannel } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { type Kit } from '../internal/kit.js';
import { type Meter } from '../internal/metered.js';
import { monthDay } from '../path/dates.js';
import { isRehearsal, isSocial } from '../path/kinds.js';
import { recordLines } from '../path/record-lines.js';
import { bare } from '../path/tell.js';
import { pathState, stageOrder, type PathSource } from '../path/state.js';
import { type Playbook } from '../path/types.js';

/**
 * Understand first (docs/architecture/understand.md): three short structured calls read the message against the venture's
 * record at once, before the path decides, and code keeps what it can check. It is off by default (`CORE_UNDERSTAND`). A
 * part that fails or is late leaves its fields empty, and a turn none of whose parts holds goes on by its rules.
 */
export interface UnderstandInput {
  readonly playbook: Playbook;
  readonly ventureId: string;
  readonly venture: PathSource['venture'];
  readonly reads: pathRepo.PathReads;
  readonly continuity: PromptContinuity;
  /** ISO date (YYYY-MM-DD). */
  readonly today: string;
  readonly message: string;
  /** The conversation as the founder heard it, oldest first, and the opener when it reaches back to it. */
  readonly history: readonly Pick<HistoryTurn, 'founderText' | 'answer'>[];
  readonly opener: string | null;
  readonly channel: TurnChannel;
}

export interface PreparedPart {
  /** How it is asked (its schema and bound). */
  readonly form: UnderstandForm;
  readonly system: string;
  readonly promptCache: PromptCacheHint;
  readonly messages: ChatMessage[];
}

export interface PreparedUnderstand {
  readonly context: UnderstandContext;
  /** The calls, by part; `sums` null: there is nothing to count and no figure asked for. */
  readonly parts: Readonly<Record<'route' | 'judge', PreparedPart>> & { readonly sums: PreparedPart | null };
}

interface Catalogue {
  readonly plays: readonly UnderstandPlay[];
  readonly system: string;
}
const CATALOGUES = new WeakMap<Playbook, Catalogue>();
const ASKS = /^(?:how|what|should|when|do|does|can|could|who|where|why|is|am|are|which|will|would|did)\b/iu;

/** The playbook as ROUTE is shown it: once per playbook, so the system prompt is the same text on every turn. */
export function understandCatalogue(playbook: Playbook): Catalogue {
  const known = CATALOGUES.get(playbook);
  if (known !== undefined) return known;
  const plays = playbook.plays.map((play): UnderstandPlay => {
    const phrases = playbook.intents
      .filter((i) => i.playId === play.id && i.note !== true)
      .flatMap((i) => i.phrases)
      .filter((phrase) => !/\.\.\.|…|\*/u.test(phrase));
    return {
      id: play.id,
      stage: play.stage,
      // A question says what it is asked for best.
      ask: phrases.find((p) => ASKS.test(p) && p.split(' ').length >= 4) ?? phrases[0] ?? play.title,
      title: play.title,
      text: [play.answer, ...play.steps.map((s) => `${s.do}. ${s.how}`), play.doneWhen, ...play.traps].join(
        ' ',
      ),
    };
  });
  const made = { plays, system: routeSystemPrompt(plays) };
  CATALOGUES.set(playbook, made);
  return made;
}

/** Everything the calls read and their answers are checked against. Pure. */
export function prepareUnderstand(input: UnderstandInput): PreparedUnderstand {
  const { playbook, venture, reads, continuity, today } = input;
  const { plays, system } = understandCatalogue(playbook);
  const { stage } = pathState(playbook, { ventureId: input.ventureId, venture, reads });
  const stages = stageOrder(playbook);
  const at = stages.indexOf(stage);
  const near = new Set(stages.slice(Math.max(0, at - 1), at + 2));
  const open = reads.steps.find((s) => s.status === 'now') ?? null;
  const step =
    open === null ? null : `${open.title}${open.dueOn === null ? '' : `, due ${monthDay(open.dueOn)}`}`;
  const founder = continuity.founderFirstName ?? '';
  const about = [
    venture.oneLiner.trim() === '' ? venture.name : `${venture.name}: ${bare(venture.oneLiner)}`,
    `Field: ${venture.domain}`,
    `Stage: ${stage}`,
    (venture.currentGoal ?? '').trim() === '' ? '' : `Goal: ${bare(venture.currentGoal ?? '')}`,
    founder === '' ? '' : `Founder: ${founder}`,
  ]
    .filter((t) => t !== '')
    .map((t) => `${t}.`)
    .join(' ');
  const said = input.history.map((t) => ({ founder: t.founderText, reply: t.answer ?? '' }));
  const history =
    said.length === 0 && (input.opener ?? '').trim() !== ''
      ? [{ founder: '', reply: input.opener ?? '' }]
      : exchangesInView(said);
  const context: UnderstandContext = {
    today,
    message: input.message,
    history,
    record: recordLines({ today, reads, continuity, message: input.message }),
    shown: [about, step ?? ''].join('. '),
    plays,
    stepCandidates: new Set(
      plays.filter((p) => stages.some((s) => s === p.stage && near.has(s))).map((p) => p.id),
    ),
  };
  const part = (form: UnderstandForm, prompt: string): PreparedPart => ({
    form,
    system: prompt,
    promptCache: understandCacheHint(prompt),
    messages: understandMessages(form, { context, venture: about, step, channel: input.channel }),
  });
  return {
    context,
    parts: {
      route: part('route', system),
      sums: sumsDue(context) ? part('sums', SUMS_SYSTEM_PROMPT) : null,
      // On a call JUDGE says what the reply opens on and no more.
      judge:
        input.channel === 'voice'
          ? part('judgeVoice', JUDGE_VOICE_SYSTEM_PROMPT)
          : part('judge', JUDGE_SYSTEM_PROMPT),
    },
  };
}

/**
 * Whether a message is read at all: never a crisis, role-play or one that is only social (nothing in it is asked, and the
 * rules know it). Cheap and sure, so it is asked before any call is made.
 */
export function understandDue(args: {
  readonly text: string;
  readonly crisis: boolean;
  readonly mode: CoachMode | null;
  readonly counterpart: string | null;
  readonly conversationMode: string | null;
  readonly previousReply: string | null;
}): boolean {
  if (args.crisis || isRehearsal(args)) return false;
  return !isSocial(args.text, args.previousReply);
}

/** How long a cut-off call may take to end, to be metered, before the host stops waiting for it. */
const CANCEL_GRACE_MS = 1_000;
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** How a part ended: `ok`, `late`, `cancelled`, `skipped` (not asked) or the gateway's code. */
interface PartOutcome {
  readonly code: string;
  readonly ms: number | null;
  readonly modelId: string | null;
  readonly fallbackUsed: boolean;
}
const SKIPPED: PartOutcome = { code: 'skipped', ms: null, modelId: null, fallbackUsed: false };

/** Time SUMS needs to be asked once more. */
const SUMS_AGAIN_MS = 450;

/** Kinds of message whose reply opens on what JUDGE says: it is waited for as long as there is. */
const JUDGED: ReadonlySet<string> = new Set(['choice', 'result', 'update', 'pushback']);
export const judgeLeads = (route: RouteReading | null | undefined): boolean =>
  route == null || route.k.length === 0 || route.k.some((k) => JUDGED.has(k.trim().toLowerCase()));

/**
 * Reads a message (see the module comment): null when nothing that came in time holds. Never rejects. `tails`: the turn's
 * work for the host (`Kit.later`); the usage rows are recorded there, one a call, so waiting for the reading never needs a
 * database connection. The decision needs ROUTE and SUMS; JUDGE is waited for as long as there is when the reply opens on it,
 * else a little longer than they took. What is late is cancelled. Logs `turn.understand` with ids, codes, counts and
 * milliseconds, by part, never words.
 */
export async function understandTurn(
  kit: Kit,
  meter: Meter,
  input: UnderstandInput,
  options: { readonly signal?: AbortSignal; readonly tails?: Promise<void>[] } = {},
): Promise<Understanding | null> {
  const { gateway, logger } = kit.deps;
  const { turns } = kit.config;
  const started = performance.now();
  const budget = input.channel === 'voice' ? turns.understandVoiceMs : turns.understandTypedMs;
  const fields = { requestId: meter.ctx.requestId, purpose: meter.purpose, channel: input.channel };
  const took = (): number => Math.round(performance.now() - started);
  const cancel = new AbortController();
  const over = (): boolean => cancel.signal.aborted;
  const cut = new Promise<'late'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('late');
    }, budget);
    timer.unref();
    const stop = (): void => {
      clearTimeout(timer);
      resolve('late');
    };
    cancel.signal.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted === true) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    const { context, parts } = prepareUnderstand(input);
    const readings: { -readonly [P in keyof UnderstandReadings]: UnderstandReadings[P] } = {};
    const outcomes: Record<UnderstandPart, PartOutcome | null> = { route: null, sums: null, judge: null };
    const recorded: Promise<void>[] = [];
    let askedAgain = false;
    /** One part: its reading is there when it resolves. Never rejects. */
    const ask = async (name: UnderstandPart, prepared: PreparedPart | null): Promise<void> => {
      if (prepared === null) {
        outcomes[name] = SKIPPED;
        return;
      }
      const call = async (
        messages: ChatMessage[],
        left: number,
      ): Promise<GenerateStructuredResult<unknown>> => {
        const request = {
          purpose: meter.purpose,
          requestId: meter.ctx.requestId,
          route: 'understand' as const,
          system: prepared.system,
          messages,
          promptCache: prepared.promptCache,
          schemaName: UNDERSTAND_SCHEMA_NAMES[prepared.form],
          zodSchema: UNDERSTAND_SCHEMAS[prepared.form],
          maxOutputTokens: UNDERSTAND_MAX_OUTPUT_TOKENS[prepared.form],
          timeoutMs: left,
          // Its budget is short: what a cut-off attempt read is spent all the same.
          estimateCut: true,
          signal: options.signal ? AbortSignal.any([options.signal, cancel.signal]) : cancel.signal,
        };
        // A gateway that throws at once fails its part, like one that rejects.
        const made = Promise.resolve().then(() => gateway.generateStructured<unknown>(request));
        const record = made.then(
          (r) => kit.recordUsage({ ...meter, attempts: r.attempts }),
          (err: unknown) =>
            kit.recordUsage({ ...meter, attempts: isModelGatewayError(err) ? err.attempts : [] }),
        );
        recorded.push(record);
        // A provider that does not hear its cancellation holds neither the turn nor the host's after-response work.
        const settled = Promise.race([record, cut.then(() => pause(CANCEL_GRACE_MS))]);
        options.tails?.push(kit.later(settled));
        return made;
      };
      const held = (result: GenerateStructuredResult<unknown>): void => {
        if (name === 'route') readings.route = readRoute(result.value);
        else if (name === 'sums') readings.sums = readSums(result.value);
        else readings.judge = readJudge(result.value);
        outcomes[name] = {
          code: 'ok',
          ms: took(),
          modelId: result.modelId,
          fallbackUsed: result.fallbackUsed,
        };
      };
      try {
        const result = await call(prepared.messages, budget);
        if (over()) return;
        held(result);
        // A plan and no sum: asked for once more, while there is time.
        const again = name === 'sums' && readings.sums ? sumsAgain(prepared.messages, readings.sums) : null;
        if (again === null || budget - took() < SUMS_AGAIN_MS) return;
        askedAgain = true;
        const second = await call(again, budget - took()).catch(() => null);
        if (second !== null && !over()) held(second);
      } catch (err) {
        // Cut off by its own deadline, which is the turn's: late, as by the turn.
        if (over() || options.signal?.aborted === true || took() >= budget) return;
        outcomes[name] = {
          code: isModelGatewayError(err) ? err.code : err instanceof Error ? err.name : 'unknown',
          ms: took(),
          modelId: null,
          fallbackUsed: false,
        };
      }
    };
    const route = ask('route', parts.route);
    const sums = ask('sums', parts.sums);
    const judge = ask('judge', parts.judge);
    await Promise.race([Promise.all([route, sums]), cut]);
    const left = budget - took();
    if (outcomes.judge === null && left > 0)
      await Promise.race([
        judge,
        cut,
        ...(judgeLeads(readings.route)
          ? []
          : [pause(Math.min(left, UNDERSTAND_JUDGE_WAIT_MS[input.channel]))]),
      ]);
    cancel.abort();
    if (options.tails === undefined) await Promise.race([Promise.all(recorded), pause(CANCEL_GRACE_MS)]);
    const stopped = options.signal?.aborted === true ? 'cancelled' : 'late';
    const ended = (name: UnderstandPart): PartOutcome =>
      outcomes[name] ?? { ...SKIPPED, code: stopped, ms: took() };
    const { understanding, report } = readParts(readings, context);
    const came = UNDERSTAND_PARTS.some((name) => ended(name).code === 'ok');
    const whole = UNDERSTAND_PARTS.every((name) => ['ok', 'skipped'].includes(ended(name).code));
    const logged = {
      ...fields,
      code: understanding !== null ? (whole ? 'ok' : 'partial') : came ? 'nothing_held' : ended('route').code,
      ms: took(),
      routeCode: ended('route').code,
      routeMs: ended('route').ms,
      sumsCode: ended('sums').code,
      sumsMs: ended('sums').ms,
      judgeCode: ended('judge').code,
      judgeMs: ended('judge').ms,
      // SUMS wrote a plan and no sum, and was asked once more.
      sumsAgain: askedAgain,
    };
    if (understanding === null) {
      logger.warn('turn.understand', logged);
      return null;
    }
    const answered = UNDERSTAND_PARTS.map(ended).filter((o) => o.code === 'ok');
    logger.info('turn.understand', {
      ...logged,
      modelId: answered[0]?.modelId ?? null,
      fallbackUsed: answered.some((o) => o.fallbackUsed),
      kind: understanding.kind,
      also: understanding.also.join(','),
      playId: understanding.playId,
      stepPlayId: understanding.stepPlayId,
      sure: understanding.sure,
      referral: understanding.referral,
      records: context.record.length,
      sums: understanding.sums.length,
      sumDrops: report.sumDrops.join(','),
      textDrops: report.textDrops.join(','),
      inputs: `${String(report.inputs.anywhere)}/${String(report.inputs.named)}`,
      // Given from another place than the model said: theirs all the same.
      inputsMoved: report.inputs.anywhere - report.inputs.found,
    });
    return understanding;
  } catch (err) {
    cancel.abort();
    logger.warn('turn.understand', {
      ...fields,
      code: err instanceof Error ? err.name : 'unknown',
      ms: took(),
    });
    return null;
  }
}
