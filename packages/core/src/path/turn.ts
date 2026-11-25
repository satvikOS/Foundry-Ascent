import { type PromptContinuity } from '@foundry/ai';
import { type EvidenceItem, type Play, type TurnGuidance } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { type PathPromptGuidance } from './ai-adapter.js';
import {
  arcOf,
  briefOf,
  dayOf,
  factOf,
  firstSentence,
  isReference,
  standingDecisions,
  type BriefSource,
} from './brief.js';
import { monthDay, sayDue } from './dates.js';
import {
  concreteFact,
  decide,
  evidencePlayOf,
  guidanceOf,
  type AppliedPivot,
  type DecideInput,
  type Decision,
} from './engine.js';
import { type Playbook } from './types.js';
import { contentStems, plain } from './words.js';

/** The path of one turn: what was decided, what is kept with the turn, and what the prompt is given. */
export interface PathTurn {
  readonly decision: Decision;
  readonly guidance: TurnGuidance | null;
  readonly prompt: PathPromptGuidance;
}

export interface PathTurnInput extends Omit<DecideInput, 'recordText' | 'background'> {
  readonly continuity: PromptContinuity;
  /** The founder's earlier messages in view. */
  readonly earlierMessages: readonly string[];
}

function briefSource(input: PathTurnInput, decision: Decision): BriefSource {
  const { continuity } = input;
  const notebook = continuity.notebook ?? null;
  return {
    today: input.today,
    venture: input.venture,
    // As it reads after this turn: the idea just told, the direction just changed, the work just reported.
    reads: readsAfter(input, decision),
    profile: continuity.studentProfile ?? null,
    notebook:
      notebook === null
        ? null
        : { founderProfile: notebook.founderProfile, commitments: notebook.commitments },
    digests: (continuity.recentDigests ?? []).map((d) => ({
      sessionId: d.sessionId ?? '',
      date: d.date,
      title: d.title ?? null,
      summary: d.digest.summary,
    })),
  };
}

/** What the turn changes of the record, for what the prompt says of it. */
function readsAfter(input: PathTurnInput, decision: Decision): pathRepo.PathReads {
  const reads = decision.applied?.reads ?? input.reads;
  const idea = decision.pivot?.to ?? decision.idea;
  if (idea === null) return reads;
  const path: pathRepo.PathRecord = {
    ventureId: input.ventureId,
    stage: decision.state.stage,
    intakeBy: null,
    pivots: [],
    playbookVersion: input.playbook.version,
    version: 1,
    ...reads.path,
    intake: { ...EMPTY_INTAKE, ...reads.path?.intake, idea },
  };
  return {
    ...reads,
    path:
      decision.pivot === null
        ? path
        : {
            ...path,
            pivots: [
              ...path.pivots,
              { on: input.today, from: decision.pivot.from, to: decision.pivot.to, sessionId: null },
            ],
          },
  };
}

const EMPTY_INTAKE = {
  idea: '',
  customer: '',
  studies: '',
  experience: null,
  hoursPerWeek: null,
  deadline: null,
  doneSoFar: '',
  block: '',
};

/** Decides the turn and builds what its prompt and its record carry. Pure, like the engine. */
export function pathTurn(input: PathTurnInput): PathTurn {
  const { continuity, playbook } = input;
  const notebook = continuity.notebook ?? null;
  const decision = decide({
    ...input,
    recordText: [
      notebook?.summary ?? '',
      ...(notebook?.commitments ?? []).map((c) => c.text),
      ...(continuity.recentDigests ?? []).flatMap((d) => [d.digest.summary, ...d.digest.topics]),
    ].join('. '),
    background: [
      ...input.earlierMessages,
      continuity.studentProfile?.background ?? '',
      ...(notebook?.founderProfile ?? []).map((e) => e.text),
    ],
  });
  return { decision, guidance: guidanceOf(playbook, decision), prompt: promptOf(input, decision) };
}

function promptOf(input: PathTurnInput, decision: Decision): PathPromptGuidance {
  const { step, choice, pathStep } = decision;
  return {
    kind: decision.kind === 'crisis' ? 'coaching' : decision.kind,
    brief: briefOf(
      briefSource(input, decision),
      choice.length > 0
        ? [`They ask you to choose between: ${choice.join(' | ')}. Pick one, or an order.`]
        : [],
    ),
    stage: {
      title: decision.stageTitle,
      number: decision.state.stageIndex + 1,
      count: decision.stageCount,
    },
    firstTime: decision.firstTime,
    ask: askOf(input, decision),
    step:
      step === null
        ? null
        : {
            title: step.view.title,
            items: step.view.items
              .filter((i) => !i.done)
              .map((i) => ({ do: i.do, how: i.how, minutes: i.minutes })),
            doneWhen: step.view.doneWhen,
            dueOn: step.view.dueOn,
            template: step.view.template,
          },
    pathStep: pathStep === null ? null : { title: pathStep.title, dueOn: pathStep.dueOn },
    then: decision.then.map((s) => s.title),
    checkIn:
      decision.checkIn === null
        ? null
        : { title: decision.checkIn.title, dueOn: decision.checkIn.dueOn, overdue: decision.checkIn.overdue },
    referral:
      decision.referral === null ? null : { who: decision.referral.who, bring: decision.referral.bring },
    newIdea: decision.newIdea,
    criteria: decision.missing.map((c) => ({ id: c.id, title: c.title, evidence: c.evidence })),
  };
}

type Ask = PathPromptGuidance['ask'];

const ask = (title: string, answer: string, why: string, traps: readonly string[] = []): Ask => ({
  title,
  answer: answer.replace(/\s+/g, ' ').trim(),
  why,
  traps,
  evidenceKeys: [],
});
const bare = (text: string): string => text.replace(/[\s.!?;]+$/u, '').trim();
const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
/** A step with its day, as the record says it. */
const withDay = (input: PathTurnInput, title: string, dueOn: string | null): string =>
  dueOn === null ? bare(title) : `${bare(title)}, due ${sayDue(input.today, dueOn)}`;

/** What the reply must say first, from the program and the record: whatever the turn is. */
function askOf(input: PathTurnInput, decision: Decision): Ask {
  const { play, kind } = decision;
  if (kind === 'social' || kind === 'rehearsal' || kind === 'crisis') return null;
  if (kind === 'recall') return recallAsk(input, decision);
  if (decision.pivot !== null) return pivotAsk(decision, decision.pivot);
  if (decision.pushes && decision.referral !== null) return pushAsk(decision);
  if (kind === 'report') return reportAsk(input, decision);
  if (play !== null) return playAsk(play);
  if (decision.smaller !== null && !decision.overview) return smallerAsk(decision);
  return decision.overview ? overviewAsk(input, decision) : null;
}

/** The play's answer: its steps are the turn's own. */
const playAsk = (play: Play): Ask => ask(play.title, play.answer, play.why, play.traps);

/** Who decides and what to take, to a push for a ruling. */
function pushAsk(decision: Decision): Ask {
  const { referral, step } = decision;
  return ask(
    'Who decides this, and what to take',
    `I cannot decide this for you, and I will not say yes or no to it: ${lowerFirst(bare(referral?.who ?? ''))} can. Take with you: ${lowerFirst(bare(referral?.bring ?? ''))}.` +
      (step === null ? '' : ` What you can do now is the step: ${lowerFirst(bare(step.view.title))}.`),
    'A wrong yes here is hard to undo, and they answer questions like this for free or early.',
  );
}

/** Where they stand and what comes next, in order, with what is on record: the answer to "get me organized". */
function overviewAsk(input: PathTurnInput, decision: Decision): Ask {
  const { state, missing, step, then } = decision;
  const idea = ideaOf(input, decision);
  const fact = concreteFact(input.reads.memory);
  const shown = state.criteria.filter(
    (c) => c.status !== 'open' && (c.criterion.stage === state.stage || c.by === 'path' || c.by === 'record'),
  );
  const parts = [
    `${bare(input.venture.name)} is at stage ${String(state.stageIndex + 1)} of ${String(decision.stageCount)}: ${decision.stageTitle}.`,
    fact === null ? (idea === null ? '' : `Your idea: ${idea}.`) : `On record: ${bare(fact)}.`,
    shown.length > 0
      ? `Already shown: ${shown
          .slice(-3)
          .map((c) => c.criterion.title)
          .join('; ')}.`
      : '',
    missing.length > 0 ? `Still to show: ${missing.map((c) => c.title).join('; ')}.` : '',
    step === null ? '' : `Now: ${withDay(input, step.view.title, step.view.dueOn)}.`,
    then.length > 0 ? `Then: ${then.map((s) => s.title).join('; then ')}.` : '',
  ];
  return ask(
    'Where you are and what comes next',
    parts.filter((p) => p !== '').join(' '),
    'Each step produces the evidence the stage still needs, so the next one is worth doing.',
  );
}

/** The step cut to their time: what it is now. */
function smallerAsk(decision: Decision): Ask {
  const items = decision.step?.view.items.filter((i) => !i.done) ?? [];
  const minutes = items.reduce((sum, i) => sum + (i.minutes ?? 0), 0);
  const timed = items.length > 0 && items.every((i) => i.minutes !== null);
  const doing = items.map((i) => lowerFirst(bare(i.do))).join('; then ');
  return ask(
    'A smaller version of the step',
    `Make it smaller: ${doing}. ${timed ? `That is about ${String(minutes)} minutes, and the rest waits.` : 'The rest waits.'}`,
    'A small part that is done this week is worth more than a whole step that is not.',
  );
}

/** What a report changed: counted, how far it gets them, moved, or finished; never asked for again. */
function reportAsk(input: PathTurnInput, decision: Decision): Ask {
  const parts: string[] = [];
  const { completes, work, report, commitment, step, then } = decision;
  if (completes !== null)
    parts.push(
      completes.rest === null
        ? `That finishes "${bare(completes.step.title)}", in your words.`
        : `That part of "${bare(completes.step.title)}" is done, and the rest of it is next.`,
    );
  for (const w of work)
    parts.push(
      w.progress === null
        ? `That counts as "${bare(w.criterion.title)}".`
        : `That is ${String(w.progress.done)} of ${String(w.progress.of)} towards "${bare(w.criterion.title)}": ${String(w.progress.of - w.progress.done)} more to go.`,
    );
  if (decision.applied?.stage != null)
    parts.push(`So you are at stage ${String(decision.state.stageIndex + 1)}: ${decision.stageTitle}.`);
  if (report?.state === 'not_yet') {
    parts.push(
      decision.movedTo === null
        ? 'That is fine, and nothing is lost: the step stands.'
        : `That is fine, and nothing is lost: it moves to ${sayDue(input.today, decision.movedTo)}.`,
    );
    const offer = decision.smallerOffer?.items.find((i) => !i.done);
    if (offer !== undefined)
      parts.push(`If that is still too much, do only this: ${lowerFirst(bare(offer.do))}.`);
  }
  if (parts.length === 0 && commitment !== null && step !== null)
    parts.push(`Set: ${withDay(input, step.view.title, step.view.dueOn)}.`);
  if (parts.length === 0) return null;
  if (decision.smaller !== null) {
    const less = smallerAsk(decision)?.answer;
    if (less !== undefined) parts.push(less);
  } else if (step !== null && report?.state !== 'not_yet' && (completes !== null || work.length > 0))
    parts.push(
      `Next: ${withDay(input, step.view.title, step.view.dueOn)}.${then[0] === undefined ? '' : ` Then: ${then[0].title}.`}`,
    );
  return ask(
    'What you did, and what it changes',
    parts.join(' '),
    'What you report in your own words is kept as the evidence, so nobody asks you for it twice.',
  );
}

/** A change of direction: the idea kept, what no longer carries, and why. */
function pivotAsk(decision: Decision, pivot: AppliedPivot): Ask {
  const reopened = pivot.reopened.slice(0, 4).map((c) => bare(c.title));
  return ask(
    'What the change of direction changes',
    `Kept: the idea is now "${bare(pivot.to)}"${pivot.from === '' ? '' : `, and the old one ("${shortOf(pivot.from)}") stays in your story with today's date`}. ` +
      (reopened.length === 0
        ? 'Nothing you had shown was about the old customer, so nothing is taken back.'
        : `What you showed about the old customer does not carry over by itself, so these are open again: ${reopened.join('; ')}.`) +
      ` You are at stage ${String(decision.state.stageIndex + 1)}: ${decision.stageTitle}.`,
    'The old talks and tests were with other people about another problem; what you know about the work itself stays.',
  );
}

const shortOf = (text: string): string =>
  text.length <= 120 ? bare(text) : `${bare(text.slice(0, 117))}...`;

/** The idea in their own words: what they just said, what is kept, else what the venture's record calls it. */
function ideaOf(input: PathTurnInput, decision: Decision): string | null {
  const kept = decision.idea ?? (input.reads.path?.intake?.idea ?? '').trim();
  if (kept !== '') return `"${bare(kept)}"`;
  const line = input.venture.oneLiner.trim();
  return line === '' ? null : bare(line);
}

const STORY =
  /\bhow (?:we|i) got (?:here|to (?:this|where))\b|\bfrom the (?:start|beginning)\b|\b(?:whole|full|entire) (?:story|history|journey)\b|\bour (?:story|history|journey)\b/;

/** How they got here, from the record's own dated entries: what was reported, decided, changed and finished. */
function storyAsk(input: PathTurnInput, decision: Decision): Ask {
  const arc = arcOf(briefSource(input, decision)).filter((e) =>
    ['result', 'setback', 'decision', 'pivot', 'milestone', 'step_done', 'experiment'].includes(e.kind),
  );
  const first = (input.reads.path?.pivots ?? []).find((x) => x.from !== '')?.from;
  const idea = ideaOf(input, decision);
  const start =
    first !== undefined
      ? `You started with "${shortOf(first)}".`
      : idea === null
        ? ''
        : `You started with ${idea}.`;
  const { step } = decision;
  const end = step === null ? '' : `Open step now: ${withDay(input, step.view.title, step.view.dueOn)}.`;
  let answer = start;
  const room = RECALL_CHARS - end.length - 1;
  for (const e of arc) {
    const line = `${monthDay(e.on)}: ${shortOf(e.title)}.`;
    if (`${answer} ${line}`.length <= room) answer = `${answer} ${line}`.trim();
  }
  answer = `${answer} ${end}`.trim();
  return answer === ''
    ? null
    : ask(
        'How you got here',
        answer,
        'This is what you told me and what the venture holds, with its dates; nothing is added to it.',
      );
}

/** What is on record, as facts: the idea, what was decided and when, what they told, and the open step with its day. */
function recallAsk(input: PathTurnInput, decision: Decision): Ask {
  const said = plain(input.message);
  if (STORY.test(said)) return storyAsk(input, decision);
  const idea = ideaOf(input, decision);
  const name = input.venture.name.trim();
  const parts: string[] = [];
  if (idea !== null) parts.push(`Your idea${name === '' ? '' : `, ${bare(name)}`}: ${idea}.`);
  const about = new Set(contentStems(input.message));
  const told = input.reads.memory.filter((m) => m.status === 'confirmed' && !isReference(m));
  const pivots = (input.reads.path?.pivots ?? []).filter((p) => p.to !== '');
  const latest = pivots.at(-1);
  if (latest !== undefined)
    parts.push(
      `On ${monthDay(latest.on)} you changed direction${latest.from === '' ? '' : ` from "${shortOf(latest.from)}"`} to "${shortOf(latest.to)}".`,
    );
  const decisions = standingDecisions(input.reads.memory).slice(0, 2);
  for (const m of decisions) parts.push(`Decided on ${monthDay(dayOf(m, 'decided_on'))}: ${factOf(m)}.`);
  // What they ask about, by its own words ("what's my fee?"), before the rest.
  const asked = told
    .filter((m) => m.type !== 'decision')
    .filter((m) => contentStems(`${m.title}. ${m.content}`).some((w) => about.has(w)))
    .slice(0, 2);
  for (const m of asked) parts.push(`On record: ${factOf(m)}.`);
  const progress = decision.state.criteria.find((c) => c.progress !== null);
  if (progress?.progress != null)
    parts.push(
      `So far: ${String(progress.progress.done)} of ${String(progress.progress.of)} towards "${bare(progress.criterion.title)}".`,
    );
  const last = (input.continuity.recentDigests ?? [])[0];
  if (
    last !== undefined &&
    last.digest.summary.trim() !== '' &&
    /\b(?:last|talk|discuss|speak|spoke|session|call|got here|from the start|yesterday)/.test(said)
  )
    parts.push(`Last conversation (${monthDay(last.date)}): ${bare(firstSentence(last.digest.summary))}.`);
  for (const row of input.reads.steps.filter((s) => s.status === 'done').slice(0, 1))
    parts.push(`Done: ${bare(row.title)}${row.evidence === null ? '' : ` ("${shortOf(row.evidence)}")`}.`);
  const { step } = decision;
  if (step !== null) parts.push(`Open step: ${withDay(input, step.view.title, step.view.dueOn)}.`);
  if (parts.length === 0) return null;
  let answer = '';
  for (const part of parts)
    if (`${answer} ${part}`.length <= RECALL_CHARS) answer = `${answer} ${part}`.trim();
  return ask(
    'What is on record',
    answer,
    'This is what you told me and what the venture holds, with its dates; nothing is added to it.',
  );
}

/** Most characters of a recall's answer (the prompt shows at most 700). */
const RECALL_CHARS = 690;

/** The shown evidence that is the play's own sources (by their titles), for its citations. */
export function evidenceKeysOf(
  playbook: Playbook,
  decision: Decision,
  shown: readonly Pick<EvidenceItem, 'key' | 'title' | 'kind'>[],
): string[] {
  const play = evidencePlayOf(playbook, decision);
  if (play === null) return [];
  const titles = play.citations.flatMap((c) => {
    const source = playbook.sources.find((s) => s.id === c.sourceId);
    return source === undefined ? [] : [plain(source.title)];
  });
  const playTitle = plain(play.title);
  return shown
    .filter((item) => item.kind === 'chunk' || item.kind === 'resource')
    .filter((item) => {
      const title = plain(item.title);
      return title.includes(playTitle) || titles.some((t) => title.includes(t));
    })
    .map((item) => item.key)
    .slice(0, 4);
}

/** The prompt's guidance with the citations its answer may use. */
export function withEvidenceKeys(prompt: PathPromptGuidance, keys: readonly string[]): PathPromptGuidance {
  return prompt.ask === null || keys.length === 0
    ? prompt
    : { ...prompt, ask: { ...prompt.ask, evidenceKeys: keys } };
}

/** The decided step as the turn's next action, so call summaries and recaps name the same step. */
export function nextActionsOf(
  decision: Decision,
): { owner: string; action: string; target_date: string | null }[] | null {
  if (decision.step === null) return null;
  return [{ owner: 'founder', action: decision.step.view.title, target_date: decision.step.view.dueOn }];
}
