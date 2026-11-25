import {
  RawUnderstanding,
  UNDERSTAND_MAX_OUTPUT_TOKENS,
  UNDERSTAND_SCHEMA_NAME,
  UNDERSTAND_TIMEOUT_MS,
  exchangesInView,
  isModelGatewayError,
  readUnderstanding,
  understandCacheHint,
  understandMessages,
  understandSystemPrompt,
  type ChatMessage,
  type HistoryTurn,
  type PromptCacheHint,
  type PromptContinuity,
  type Understanding,
  type UnderstandContext,
  type UnderstandPlay,
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
 * Understand first (docs/architecture/understand.md): a short structured call reads the message against the venture's
 * record before the path decides, and code keeps what it can check. It is off by default (`CORE_UNDERSTAND`), and a turn
 * goes on by its rules whenever the call fails, is late or says nothing that holds.
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

export interface PreparedUnderstand {
  readonly system: string;
  readonly promptCache: PromptCacheHint;
  readonly messages: ChatMessage[];
  readonly context: UnderstandContext;
}

interface Catalogue {
  readonly plays: readonly UnderstandPlay[];
  readonly system: string;
}
const CATALOGUES = new WeakMap<Playbook, Catalogue>();
const ASKS = /^(?:how|what|should|when|do|does|can|could|who|where|why|is|am|are|which|will|would|did)\b/iu;

/** The playbook as the call is shown it: once per playbook, so the system prompt is the same text on every turn. */
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
  const made = { plays, system: understandSystemPrompt(plays) };
  CATALOGUES.set(playbook, made);
  return made;
}

/** Everything the call reads and its answer is checked against. Pure. */
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
    record: recordLines({ today, reads, continuity }),
    shown: [about, step ?? ''].join('. '),
    plays,
    stepCandidates: new Set(
      plays.filter((p) => stages.some((s) => s === p.stage && near.has(s))).map((p) => p.id),
    ),
  };
  return {
    system,
    promptCache: understandCacheHint(system),
    messages: understandMessages({ context, venture: about, step, channel: input.channel }),
    context,
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

/**
 * Reads a message (see the module comment): null when the call failed, was late or left nothing. Never rejects. `tails`:
 * the turn's work for the host (`Kit.later`); the usage row is recorded there, so waiting for the reading never needs a
 * database connection. Logs `turn.understand` with ids, codes, counts and milliseconds, never words.
 */
export async function understandTurn(
  kit: Kit,
  meter: Meter,
  input: UnderstandInput,
  options: { readonly signal?: AbortSignal; readonly tails?: Promise<void>[] } = {},
): Promise<Understanding | null> {
  const { gateway, logger } = kit.deps;
  const started = performance.now();
  const budget = UNDERSTAND_TIMEOUT_MS[input.channel];
  const timeout = AbortSignal.timeout(budget);
  const fields = { requestId: meter.ctx.requestId, purpose: meter.purpose, channel: input.channel };
  const took = (): number => Math.round(performance.now() - started);
  const late = new Promise<'late'>((resolve) => {
    timeout.addEventListener(
      'abort',
      () => {
        resolve('late');
      },
      { once: true },
    );
  });
  try {
    const prepared = prepareUnderstand(input);
    const call = gateway.generateStructured({
      purpose: meter.purpose,
      requestId: meter.ctx.requestId,
      route: 'understand',
      system: prepared.system,
      messages: prepared.messages,
      promptCache: prepared.promptCache,
      schemaName: UNDERSTAND_SCHEMA_NAME,
      zodSchema: RawUnderstanding,
      maxOutputTokens: UNDERSTAND_MAX_OUTPUT_TOKENS,
      timeoutMs: budget,
      // Its budget is short: what a cut-off attempt read is spent all the same.
      estimateCut: true,
      // One budget for the model and the one behind it.
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const recorded = call.then(
      (r) => kit.recordUsage({ ...meter, attempts: r.attempts }),
      (err: unknown) => kit.recordUsage({ ...meter, attempts: isModelGatewayError(err) ? err.attempts : [] }),
    );
    // A provider that does not hear its cancellation holds neither the turn nor the host's after-response work.
    const settled = Promise.race([recorded, late.then(() => pause(CANCEL_GRACE_MS))]);
    if (options.tails === undefined) await Promise.race([recorded, late]);
    else options.tails.push(kit.later(settled));
    // Whatever the model does with its cancellation, the turn waits no longer than the budget.
    const result = await Promise.race([call, late]);
    if (result === 'late') {
      logger.warn('turn.understand', { ...fields, code: 'late', ms: took() });
      return null;
    }
    const { understanding, report } = readUnderstanding(result.value, prepared.context);
    logger.info('turn.understand', {
      ...fields,
      code: understanding === null ? 'nothing_held' : 'ok',
      ms: took(),
      modelId: result.modelId,
      fallbackUsed: result.fallbackUsed,
      kind: understanding?.kind ?? null,
      also: understanding?.also.join(',') ?? '',
      playId: understanding?.playId ?? null,
      stepPlayId: understanding?.stepPlayId ?? null,
      sure: understanding?.sure ?? false,
      referral: understanding?.referral ?? null,
      records: prepared.context.record.length,
      sums: understanding?.sums.length ?? 0,
      sumDrops: report.sumDrops.join(','),
      textDrops: report.textDrops.join(','),
      inputs: `${String(report.inputs.found)}/${String(report.inputs.named)}`,
    });
    return understanding;
  } catch (err) {
    logger.warn('turn.understand', {
      ...fields,
      code: timeout.aborted
        ? 'late'
        : options.signal?.aborted === true
          ? 'cancelled'
          : isModelGatewayError(err)
            ? err.code
            : err instanceof Error
              ? err.name
              : 'unknown',
      ms: took(),
    });
    return null;
  }
}
