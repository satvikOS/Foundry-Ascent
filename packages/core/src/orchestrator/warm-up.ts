import {
  RISK_RULES,
  SentenceGate,
  buildRetrievalQuery,
  classifyRisk,
  deriveSpoken,
  spokenHandBackFor,
} from '@foundry/ai';

import { ReplyExtractor } from './reply-extract.js';

/**
 * Warms the turn engine's own code before a call's first turn needs it (docs/runbooks/latency.md, "The first turn a
 * process serves"). The latency harness (`latency --cold`, profile local) measured the first spoken turn of a fresh
 * process starting its model call at about 280 ms against about 15 ms for every later turn, and a later call's first
 * turn as fast as any other: the cost is the process's, not the call's or the conversation's. Nearly all of it is V8
 * compiling regular expressions the first time they run, and again to machine code the second time: the risk
 * classifier's rules (about 95 ms on each of a turn's two classifications), the sentence gate's identity and craft
 * checks (about 75 ms to build the first gate) and what the gate reads as the reply streams.
 *
 * It runs the functions a turn runs, on synthetic text, with the call's guard names when it has them (the gate
 * compiles a few patterns per name), and keeps nothing but which names it warmed: no database, no model, no network,
 * no state of a call or a conversation. Those functions are pure (their only caches are compiled patterns keyed by name), so nothing a turn
 * computes, and nothing the model is told, depends on whether it ran (warm-up.test.ts compares the prompt, the
 * classification and the gate's output with and without it).
 *
 * The work is cut into steps that each give the event loop back (a step is a few milliseconds of the classifier's
 * patterns, or one gate build: tens of milliseconds), so a request that arrives meanwhile, such as the call's intro
 * speech, waits for one step at most. It never rejects. Pure CPU and idempotent, it is harmless if it is cut short.
 *
 * Where it runs: once when the process starts (the API Lambda's init phase, before any invocation, and the dev server
 * before it listens: `warmApiProcess`), so no request waits behind it in an invocation's drain; then the call screen
 * and the call start only check it (`warmTurnEngine` is memoized) and warm the call's own guard names (~10 ms).
 *
 * V8 discards a regular expression's compiled code when the expression goes unused through a few major garbage
 * collections (measured on Node 24: 3 organic major GCs; the classifier's patterns then cost ~100 ms again, whatever
 * `--no-flush-bytecode` says). A memoized warm-up therefore checks one of the classifier's largest patterns first
 * ({@link turnEngineLooksCold}) and warms again when it has gone cold. The latency harness saw no major GC in a whole
 * founder flow (8 turns, 13 other requests), so this is rare.
 */
export interface TurnWarmUpGuards {
  readonly personaName: string;
  readonly personaEirName: string | null;
  readonly eirNames: readonly string[];
  readonly addressees: readonly string[];
  readonly founderName: string | null;
  readonly otherVentureNames: readonly string[];
  readonly otherVentureCanaries: readonly string[];
  readonly otherVentureMemberNames: readonly string[];
}

/** Synthetic founder lines: plain ASCII, and one with typographic punctuation (V8 compiles a pattern per string width). */
const FOUNDER_LINES = [
  'We interviewed twelve customers this week. What should we test first with the pilot?',
  'I’m not sure the pilot is working — how would we know in two weeks?',
] as const;

/** A synthetic reply as a stream delivers it: a few sentences, a question, the kind of words a call's reply uses. */
const REPLY =
  'That makes sense. Start with the one assumption that would sink the pilot if it were wrong. ' +
  'Pick a measure you can read in two weeks, and agree it with your champion before you begin. ' +
  'What would you expect to see by then?';

const PREVIOUS_REPLY = 'Good to see you again. How did the customer calls go since we last spoke?';

/** Names for a warm-up without a call's own (the call screen opening): synthetic, never shown or stored. */
export const SYNTHETIC_WARM_UP_GUARDS: TurnWarmUpGuards = {
  personaName: 'Alex Example',
  personaEirName: null,
  eirNames: ['Pat Example'],
  addressees: ['Sam Example'],
  founderName: 'Sam',
  otherVentureNames: ['Example Widgets'],
  otherVentureCanaries: ['example-widgets-canary'],
  otherVentureMemberNames: ['Lee Example'],
};

/** How many warm-ups are remembered (each set of guard names warms once per process). */
const MAX_REMEMBERED = 64;

const done = new Map<string, Promise<void>>();
/** Warm-ups that have finished (their key), so the cold check runs only on a finished one. */
const finished = new Set<string>();
/** The classifier's rules hold no names: warmed once, whatever the guards. */
let rulesWarmed: Promise<void> | null = null;

/** Above this, one run of the probe pattern was compiling rather than running (warm: ~0.01 ms; cold: 3-9 ms). */
const COLD_PROBE_MS = 1;

let probePattern: RegExp | null = null;

/** The classifier's longest pattern: the costliest to compile again, so the clearest sign it was discarded. */
function probe(): RegExp {
  if (probePattern !== null) return probePattern;
  let longest: RegExp | null = null;
  for (const rule of RISK_RULES) {
    for (const pattern of rule.patterns)
      if (longest === null || pattern.source.length > longest.source.length) longest = pattern;
  }
  probePattern = longest ?? /warm/u;
  return probePattern;
}

function defaultColdCheck(): boolean {
  const pattern = probe();
  const line = FOUNDER_LINES[0].toLowerCase();
  const started = performance.now();
  if (pattern.global) Array.from(line.matchAll(pattern));
  else new RegExp(pattern.source, pattern.flags).test(line);
  return performance.now() - started > COLD_PROBE_MS;
}

let coldCheck: () => boolean = defaultColdCheck;

/**
 * Whether the turn engine's patterns look cold: one run of the classifier's longest pattern took longer than running
 * it does (it was compiled again). Cheap when warm (~0.01 ms).
 */
export function turnEngineLooksCold(): boolean {
  return coldCheck();
}

/** Tests only: replaces the cold check (null restores it) and forgets every warm-up. */
export function setTurnEngineColdCheckForTests(check: (() => boolean) | null): void {
  coldCheck = check ?? defaultColdCheck;
  done.clear();
  finished.clear();
  rulesWarmed = null;
}

const nextTurnOfTheLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** How long one step may hold the event loop before it gives it back (one pattern can take longer on its own). */
const STEP_MS = 4;

/** Every pattern of the classifier's rules, run twice on each line (interpreted once, then compiled), in short steps. */
async function warmRules(): Promise<void> {
  let stepStarted = performance.now();
  for (const rule of RISK_RULES) {
    for (const pattern of [...rule.patterns, ...(rule.exclude ?? [])]) {
      for (const line of FOUNDER_LINES) {
        const lower = line.toLowerCase();
        for (let pass = 0; pass < 2; pass += 1) {
          // As the classifier runs them (`matchAll` works on a copy, so the shared pattern's lastIndex is untouched);
          // a pattern without the global flag (none today) is tested on a copy as well.
          if (pattern.global) Array.from(lower.matchAll(pattern));
          else new RegExp(pattern.source, pattern.flags).test(lower);
        }
      }
      if (performance.now() - stepStarted >= STEP_MS) {
        await nextTurnOfTheLoop();
        stepStarted = performance.now();
      }
    }
  }
  await nextTurnOfTheLoop();
}

async function warm(guards: TurnWarmUpGuards): Promise<void> {
  rulesWarmed ??= warmRules();
  await rulesWarmed;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const line of FOUNDER_LINES) {
      // Both of a turn's classifications: the message alone, then with the names of the other ventures.
      classifyRisk(line);
      classifyRisk(line, {
        otherVentureNames: guards.otherVentureNames,
        otherVentureMemberNames: guards.otherVentureMemberNames,
      });
      buildRetrievalQuery({ founderText: line, previousAnswer: PREVIOUS_REPLY, currentGoal: null });
      spokenHandBackFor(line, '00000000-0000-4000-8000-000000000000', [PREVIOUS_REPLY]);
      await nextTurnOfTheLoop();
    }
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [index, line] of FOUNDER_LINES.entries()) {
      const gate = new SentenceGate({
        personaName: guards.personaName,
        eirNames: guards.eirNames,
        personaEirName: guards.personaEirName,
        addressees: guards.addressees,
        founderName: guards.founderName,
        greeted: index === 1,
        previousReply: PREVIOUS_REPLY,
        founderText: line,
        otherVentureNames: guards.otherVentureNames,
        otherVentureCanaries: guards.otherVentureCanaries,
        otherVentureMemberNames: guards.otherVentureMemberNames,
        evidenceKeys: new Set(['M1', 'D1']),
        keepDropped: true,
        callerContinues: true,
        spoken: true,
      });
      await nextTurnOfTheLoop();
      const reply = new ReplyExtractor();
      // The reply arrives in pieces, as a stream's text does.
      for (const piece of REPLY.match(/\S+\s*/g) ?? []) gate.push(reply.push(piece));
      gate.push(reply.end());
      gate.end();
      deriveSpoken(REPLY);
      await nextTurnOfTheLoop();
    }
  }
}

function keyOf(guards: TurnWarmUpGuards): string {
  return JSON.stringify([
    guards.personaName,
    guards.personaEirName,
    guards.eirNames,
    guards.addressees,
    guards.founderName,
    guards.otherVentureNames,
    guards.otherVentureCanaries,
    guards.otherVentureMemberNames,
  ]);
}

/**
 * Warms the turn engine (see the module comment) with a call's guard names, or synthetic ones. Resolves when done (the
 * same promise for guards already warmed in this process, so a second call costs nothing); never rejects.
 */
export function warmTurnEngine(guards: TurnWarmUpGuards = SYNTHETIC_WARM_UP_GUARDS): Promise<void> {
  const key = keyOf(guards);
  const known = done.get(key);
  if (known !== undefined) {
    if (!finished.has(key)) return known;
    let cold: boolean;
    try {
      cold = turnEngineLooksCold();
    } catch {
      cold = false;
    }
    if (!cold) return known;
    // Garbage collection discarded the compiled patterns: every warm-up of this process is stale.
    done.clear();
    finished.clear();
    rulesWarmed = null;
  }
  if (done.size >= MAX_REMEMBERED) {
    done.clear();
    finished.clear();
  }
  const run = warm(guards)
    .catch(() => undefined)
    .then(() => {
      if (done.get(key) === run) finished.add(key);
    });
  done.set(key, run);
  return run;
}
