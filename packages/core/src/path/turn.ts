import { termsIn, withMeanings, type PromptContinuity } from '@foundry/ai';
import { type EvidenceItem, type Play, type TurnGuidance } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { saysStanding, type PathPromptGuidance } from './ai-adapter.js';
import {
  arcOf,
  briefOf,
  dayOf,
  firstSentence,
  isReference,
  standingDecisions,
  type BriefSource,
} from './brief.js';
import { sayDue, sayPast } from './dates.js';
import {
  concreteFact,
  decide,
  evidencePlayOf,
  guidanceOf,
  type AppliedPivot,
  type DecideInput,
  type Decision,
} from './engine.js';
import { asksFor } from './kinds.js';
import { doneWhenOf } from './steps.js';
import { meaningWords, pointsBack, refersBack } from './match.js';
import { readResult } from './news.js';
import { CRITERION_NAMES, STAGE_DOING } from './playbook/phrases.js';
import {
  bare,
  dated,
  distinct,
  listed,
  lowerFirst,
  priorFact,
  sameThing,
  storyLines,
  toYou,
  toldAs,
  upperFirst,
} from './tell.js';
import { type Playbook } from './types.js';
import { wordsOfEvidence } from './state.js';
import { contentStems, numberOf, plain } from './words.js';

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
  /** The coach's earlier replies in view, oldest first. */
  readonly earlierReplies?: readonly string[];
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

/** Replies since a standing step was said before it may be said again: once in three turns. */
const STANDING_EVERY = 3;
/** "… help?" at the end of what they tell. */
const BARE_HELP = /[,.!;:\s]+(?:(?:please|pls|can you|could you)\s+)?help(?:\s+me)?(?:\s+please)?\s*[?.!]*$/i;
/** Words of its own a follow-up has at most ("just give me your best estimate"). */
const FOLLOW_UP_WORDS = 3;

/** How what they asked was found, as the prompt and the reply contract take it: what is only near it may be set aside. */
function matchedOf(
  decision: Decision,
  asked: Ask,
  answered: boolean,
): NonNullable<PathPromptGuidance['matched']> {
  if (decision.matched === 'semantic' || decision.matched === 'lexical') return 'semantic';
  if (decision.kind === 'recall') return 'phrase';
  return decision.matched === null && asked === null && !answered ? 'none' : 'phrase';
}

/**
 * What the step is to a reply that answers with nothing of the program's: absent when it is about what they asked (they
 * share a word that says something, or the message points back at it), else what stands on their path, said once in
 * {@link STANDING_EVERY} turns.
 */
function stepRoleOf(
  input: PathTurnInput,
  decision: Decision,
  matched: PathPromptGuidance['matched'],
): PathPromptGuidance['stepRole'] {
  const { step } = decision;
  if (matched !== 'none' || decision.kind !== 'coaching' || step === null) return undefined;
  // They tell, and ask nothing but help: what comes next is the step.
  if (decision.idea !== null) return undefined;
  const asks = input.message.replace(BARE_HELP, '.');
  if (!asksFor(asks) && !pointsBack(input.message)) return undefined;
  // A follow-up is about what was just said, in few words of its own or pointing back at it.
  if (decision.carried && (refersBack(input.message) || meaningWords(input.message) <= FOLLOW_UP_WORDS))
    return undefined;
  // "Two lifts" and "two pilots" share nothing.
  const stems = (text: string): string[] =>
    contentStems(text).filter((w) => numberOf(w) === null && !/^\d+$/.test(w));
  const about = new Set(
    stems(`${step.view.title}. ${step.view.doneWhen}. ${step.view.items.map((i) => i.do).join('. ')}`),
  );
  // What the step was given for is what they go on about ("unit economics for one box", "at forty boxes a month?").
  if (decision.carried) for (const w of stems(input.earlierMessages.at(-1) ?? '')) about.add(w);
  if (stems(input.message).some((w) => about.has(w))) return undefined;
  // One given for an earlier ask is no part of their path: the card has it.
  if (decision.offered) return 'quiet';
  const lately = (input.earlierReplies ?? []).slice(1 - STANDING_EVERY);
  return lately.some(saysStanding) ? 'quiet' : 'standing';
}

function promptOf(input: PathTurnInput, decision: Decision): PathPromptGuidance {
  const { step, choice, pathStep, calc } = decision;
  // Who has not said they know the words is told what one means, the first time it is used.
  const terms = ['experienced', 'some'].includes(input.reads.path?.intake?.experience ?? '')
    ? null
    : termsIn([...input.earlierMessages, input.message, ...(input.earlierReplies ?? [])].join('\n'));
  const plainLead = leadOf(input, decision);
  const lead =
    plainLead === null || terms === null
      ? plainLead
      : {
          text: withMeanings(plainLead.text, new Set(terms)),
          voice: withMeanings(plainLead.voice, new Set(terms), true),
        };
  // A step cut to one part is said as that part.
  const doing = step?.view.items.filter((i) => !i.done) ?? [];
  const title =
    doing.length === 1 && ONE_PART.test(step?.view.doneWhen ?? '')
      ? bare(doing[0]?.do ?? '')
      : (step?.view.title ?? '');
  const saidTitle =
    step === null || terms === null
      ? title
      : withMeanings(title, new Set([...terms, ...termsIn(lead?.text ?? '')]));
  const asked = askOf(input, decision, lead);
  const matched = matchedOf(decision, asked, lead !== null);
  // A sum is no answer of the step's: a step that is not about it still only stands on their path.
  const stepRole =
    lead === null || decision.calc.ask !== null ? stepRoleOf(input, decision, matched) : undefined;
  const facts = templateFacts(input, decision);
  const kind = decision.kind === 'crisis' ? 'coaching' : decision.kind;
  const talks = kind !== 'social' && kind !== 'rehearsal';
  return {
    matched,
    ...(stepRole === undefined ? {} : { stepRole }),
    kind,
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
    ...(talks && decision.firstTimeNow ? { firstTimeNow: true } : {}),
    ask: asked,
    ...(lead === null ? {} : { lead }),
    ...(talks && calc.lines.length > 0 ? { calc: calc.lines } : {}),
    ...(talks && calc.missing !== null ? { askBack: calc.missing } : {}),
    ...(talks ? { prior: priorOf(input, decision, lead) } : {}),
    ...(talks ? { said: saidText(input, decision) } : {}),
    ...(decision.howTo ? { howTo: true } : {}),
    step:
      step === null
        ? null
        : {
            title: step.view.title,
            ...(saidTitle === step.view.title ? {} : { said: saidTitle }),
            items: step.view.items
              .filter((i) => !i.done)
              .map((i) => ({ do: i.do, how: i.how, minutes: i.minutes })),
            doneWhen: doneSaid(step.view.doneWhen),
            dueOn: step.view.dueOn,
            template:
              step.view.template === null
                ? null
                : { title: step.view.template.title, body: fillTemplate(step.view.template.body, facts) },
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

const ONE_PART = /^This one part is done: (.+?)[.\s]*$/;

/** When a step cut to one part is done, said so it can be checked ("You have emailed one of the five theatre groups…"). */
function doneSaid(doneWhen: string): string {
  const part = ONE_PART.exec(doneWhen)?.[1];
  if (part === undefined) return doneWhen;
  const minutes = /^first (\d+) minutes of: (.+)$/i.exec(part);
  return minutes === null
    ? doneWhenOf(part.replace(/^the first part of: /i, ''))
    : `You have spent ${minutes[1] ?? ''} minutes on it and kept what you made.`;
}

type Ask = PathPromptGuidance['ask'];
type Lead = NonNullable<PathPromptGuidance['lead']>;

const ask = (title: string, answer: string, why: string, traps: readonly string[] = []): Ask => ({
  title,
  answer: answer.replace(/\s+/g, ' ').trim(),
  why,
  traps,
  evidenceKeys: [],
});
const flat = (text: string): string => text.replace(/[ \t]+/g, ' ').trim();
const sentence = (text: string): string => (text === '' ? '' : `${upperFirst(bare(text))}.`);
const joined = (...parts: readonly string[]): string => flat(parts.filter((p) => p !== '').join(' '));

// What the server says first ---------------------------------------------------------------------------------------

/**
 * What must be exact and comes first, whatever the model writes after it: their sum, what their news means, where they
 * stand, what is on record, what a change of direction changes. Null: the model's own answer opens the reply.
 */
function leadOf(input: PathTurnInput, decision: Decision): Lead | null {
  const { kind } = decision;
  if (kind === 'social' || kind === 'rehearsal' || kind === 'crisis') return null;
  const sum =
    decision.calc.ask !== null && decision.calc.lines.length > 0 ? sumLead(decision.calc.lines) : null;
  if (kind === 'recall') return sum ?? recallLead(input, decision);
  if (kind === 'new_idea') return null;
  if (decision.pivot !== null) return pivotLead(input, decision.pivot);
  if (sum !== null) return sum;
  if (decision.result !== null) return resultLead(input, decision.result);
  if (kind === 'news')
    return decision.news === null ? null : { text: decision.news.means, voice: decision.news.spoken };
  if (kind === 'report') return reportLead(decision);
  if (decision.overview && decision.play === null) return overviewLead(input, decision);
  return null;
}

/** A sum as it is heard ("40 boxes times $3.50 left per box is $140"). */
export function heardSum(line: string): string {
  return line
    .replace(/ x /g, ' times ')
    .replace(/ \/ /g, ' divided by ')
    .replace(/ = -/g, ' is minus ')
    .replace(/ = /g, ' is ')
    .replace(/ - /g, ' minus ');
}

function sumLead(lines: readonly string[]): Lead {
  return { text: lines.join(' '), voice: lines.slice(0, 2).map(heardSum).join(' ') };
}

function resultLead(input: PathTurnInput, result: NonNullable<Decision['result']>): Lead {
  const read = readResult(result, [...input.earlierMessages, ...input.reads.memory.map((m) => m.content)]);
  return { text: read.text, voice: read.spoken };
}

const nameOf = (c: { readonly id: string; readonly title: string }): string =>
  CRITERION_NAMES[c.id] ?? lowerFirst(bare(c.title));

/** The same without its own count ("customer talks"). */
const countedName = (c: { readonly id: string; readonly title: string }): string =>
  nameOf(c).replace(/^(?:ten|five|three|twenty|\d+) /i, '');

/** Where they stand and what is missing, said by a mentor: the answer to "get me organized". */
function overviewLead(input: PathTurnInput, decision: Decision): Lead {
  const { state, missing, step, then } = decision;
  const name = bare(input.venture.name);
  const fact = concreteFact(input.reads.memory);
  const have = state.criteria
    .filter((c) => c.status !== 'open' && (c.by === 'path' || c.by === 'record'))
    .slice(-3)
    .map((c) => nameOf(c.criterion));
  const first = step?.view.items.find((i) => !i.done);
  const stage = `You are on stage ${String(state.stageIndex + 1)} of ${String(decision.stageCount)}${name === '' ? '' : ` with ${name}`}, ${STAGE_DOING[state.stage]}.`;
  const misses = missing.length > 0 ? `Still missing: ${listed(missing.map(nameOf))}.` : '';
  const starts = first === undefined ? '' : `Start with this: ${lowerFirst(bare(first.do))}.`;
  const opens = decision.firstTimeNow ? 'Never having done this is fine: we take it one part at a time.' : '';
  const plan =
    asksForPlan(input.message) && step !== null ? `\n\n${planLines(input, decision).join('\n')}` : '';
  // Where they stand was just said: only where to start, with how.
  if ((input.earlierReplies ?? []).slice(-2).some((r) => r.includes(stage))) {
    const how = first === undefined || first.how === '' ? '' : sentence(first.how);
    return {
      text: `${joined(opens, plan === '' ? `${starts} ${how}` : 'In this order:')}${plan}`,
      voice: joined(
        opens === '' ? '' : 'First time is fine.',
        starts,
        plan === '' || then.length === 0 ? how : `Then ${lowerFirst(bare(then[0]?.title ?? ''))}.`,
      ),
    };
  }
  return {
    text: `${joined(
      opens,
      stage,
      have.length > 0 ? `You already have ${listed(have)}.` : '',
      fact === null ? '' : `What you know so far: ${fact}.`,
      misses,
      plan === '' ? starts : 'In this order:',
    )}${plan}`,
    voice: joined(
      opens === '' ? '' : 'First time is fine.',
      stage,
      missing.length > 0 ? `Still missing: ${listed(missing.slice(0, 2).map(nameOf))}.` : '',
      plan === '' || then.length === 0 ? starts : `${starts} Then ${lowerFirst(bare(then[0]?.title ?? ''))}.`,
    ),
  };
}

const PLAN_ASKED = /\b(?:plan|road ?map|schedule|to ?do list|checklist|steps)\b/;
const asksForPlan = (message: string): boolean => PLAN_ASKED.test(plain(message));

/** The open step's parts and what follows, as a numbered list. */
function planLines(input: PathTurnInput, decision: Decision): string[] {
  const { step, then } = decision;
  if (step === null) return [];
  const items = step.view.items
    .filter((i) => !i.done)
    .map((i) => `${bare(i.do)}${i.minutes === null ? '' : ` (${String(i.minutes)} min)`}.`);
  const by = step.view.dueOn === null ? '' : ` by ${sayDue(input.today, step.view.dueOn)}`;
  const own = items.length === 0 ? [`${bare(step.view.title)}${by}.`] : items;
  return [...own, ...then.map((t) => `Then: ${lowerFirst(bare(t.title))}.`)].map(
    (l, i) => `${String(i + 1)}. ${l}`,
  );
}

/** What a report changed, as a mentor says it: how far it gets them, and what it shows. */
function reportLead(decision: Decision): Lead | null {
  const { completes, work, news } = decision;
  const parts: string[] = [];
  for (const w of work)
    if (w.progress !== null) {
      const left = w.progress.of - w.progress.done;
      parts.push(
        `That is ${String(w.progress.done)} of the ${String(w.progress.of)} ${countedName(w.criterion)}, ${String(left)} to go.`,
      );
    }
  const shows = work.filter((w) => w.progress === null).map((w) => nameOf(w.criterion));
  if (shows.length > 0) parts.push(`So you now have ${listed(shows)}.`);
  if (completes !== null && parts.length === 0 && news === null)
    parts.push(
      completes.rest === null
        ? `That finishes it: ${lowerFirst(bare(completes.step.title))}.`
        : 'That part is done, and the rest of it comes next.',
    );
  if (decision.applied?.stage != null)
    parts.push(
      `That puts you on stage ${String(decision.state.stageIndex + 1)}, ${STAGE_DOING[decision.state.stage]}.`,
    );
  if (news === null && parts.length === 0) return null;
  return {
    text: joined(news?.means ?? '', ...parts),
    voice: joined(news?.spoken ?? '', ...(news === null ? parts : parts.slice(0, 1))),
  };
}

/** A new direction without what it ends ("No more lunches, I'll rent jars" → "I'll rent jars"). */
const startsNew = (to: string): string =>
  to.replace(
    /^(?:no more|no longer|not|stop\w*(?: \w+ing)?) [^,.;]{2,60}[,.;]\s*(?:but |and |now |instead )?/i,
    '',
  );

/** A change of direction: what the idea is from today, what brought it, and what has to be shown again. */
function pivotLead(input: PathTurnInput, pivot: AppliedPivot): Lead {
  const reopened = pivot.reopened.slice(0, 3).map(nameOf);
  const to = toYou(bare(startsNew(bare(pivot.to))));
  const now = /^you\b/i.test(to)
    ? `From today ${lowerFirst(to)}.`
    : `From today the idea is ${lowerFirst(to)}.`;
  const from =
    pivot.from === ''
      ? ''
      : `The first idea (${lowerFirst(shortOf(toYou(pivot.from)))}) stays in your story.`;
  const reason = [...input.reads.criteria]
    .filter((c) => c.evidence !== null && c.sourceSessionId !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => lowerFirst(toYou(bare(wordsOfEvidence(c.evidence ?? '')))))
    .find((t) => t !== '' && t.length <= 200);
  const why = reason === undefined ? '' : `What brought you here stays true: ${reason}.`;
  const again =
    reopened.length === 0
      ? 'You had shown nothing about the old customer yet, so nothing is lost.'
      : `What you showed was about the old customer, so you show it again for the new one: ${listed(reopened)}.`;
  return { text: joined(now, from, why, again), voice: joined(now, again) };
}

const shortOf = (text: string): string =>
  text.length <= 120 ? bare(text) : `${bare(text.slice(0, 117))}...`;

/** The idea in their own words: what they just said, what is kept, else what the venture's record calls it. */
function ideaOf(input: PathTurnInput, decision: Decision): string | null {
  const kept = decision.idea ?? (input.reads.path?.intake?.idea ?? '').trim();
  if (kept !== '') return bare(kept);
  const line = input.venture.oneLiner.trim();
  return line === '' ? null : bare(line);
}

const STORY =
  /\bhow (?:we|i) got (?:here|to (?:this|where))\b|\bfrom the (?:start|beginning)\b|\b(?:whole|full|entire) (?:story|history|journey)\b|\bour (?:story|history|journey)\b/;

/** How they got here, from the record's own dated entries, as a story. */
function storyLead(input: PathTurnInput, decision: Decision): Lead | null {
  const lines = storyLines(arcOf(briefSource(input, decision)));
  const first = (input.reads.path?.pivots ?? []).find((x) => x.from !== '')?.from;
  const start = first ?? ideaOf(input, decision);
  const opens = start === null ? '' : `You started with this idea: ${lowerFirst(shortOf(toYou(start)))}.`;
  if (opens === '' && lines.length === 0) return null;
  return {
    text: [opens, ...lines.map((l) => `- ${dated(l)}`)].filter((l) => l !== '').join('\n'),
    voice: joined(opens, ...lines.slice(-3).map(dated)),
  };
}

const ASKS_IDEA = /\b(?:idea|startup|venture|business|company|product)\b/;
const ASKS_LAST =
  /\b(?:last|talk|talked|discuss|discussed|speak|spoke|session|call|yesterday|cover|covered|leave off|left off|agree|agreed|said|say)\b/;
const ASKS_DECIDED =
  /\b(?:decide|decided|decision|agree|agreed|pivot|plan|change|changes|changed|direction)\b/;
const ASKS_TODO =
  /\b(?:something to do|anything to do|supposed to|going to do|meant to|tell me to do|to do next|next|plan|decide|decided|agree|agreed)\b/;

/** What is on record, as they asked for it: the idea, what was decided and when, what they told, the step they have. */
function recallLead(input: PathTurnInput, decision: Decision): Lead | null {
  const said = plain(input.message);
  if (STORY.test(said)) return storyLead(input, decision);
  const name = bare(input.venture.name);
  const idea = ideaOf(input, decision);
  const asksIdea = ASKS_IDEA.test(said);
  const asksLast = ASKS_LAST.test(said);
  const asksDecided = ASKS_DECIDED.test(said);
  const asksTodo = ASKS_TODO.test(said);
  const standing = new Set(standingDecisions(input.reads.memory).map((m) => m.id));
  const told = input.reads.memory.filter(
    (m) => m.status === 'confirmed' && !isReference(m) && (m.type !== 'decision' || standing.has(m.id)),
  );
  // What they ask about, by its own words ("what's my fee?").
  const about = new Set(contentStems(input.message).filter((w) => !GENERIC_ASK.has(w)));
  const facts = distinct(
    told
      .filter((m) => m.type !== 'decision' || !asksDecided)
      .map((m) => ({
        m,
        shared: contentStems(`${m.title}. ${m.content}`).filter((w) => about.has(w)).length,
      }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || b.m.createdAt.localeCompare(a.m.createdAt))
      .map((x) => toldAs(x.m)),
    (t) => t,
  ).slice(0, 2);
  const parts: string[] = [];
  const general = !asksLast && !asksDecided && !asksTodo && !asksIdea && facts.length === 0;
  if (idea !== null && (asksIdea || general))
    parts.push(
      `Your idea is ${name === '' || idea.toLowerCase().startsWith(name.toLowerCase()) ? '' : `${name}: `}${lowerFirst(toYou(idea))}.`,
    );
  const latest = (input.reads.path?.pivots ?? []).filter((p) => p.to !== '').at(-1);
  if (latest !== undefined && (asksDecided || asksLast || general)) {
    const to = toYou(bare(latest.to));
    parts.push(
      `${upperFirst(sayPast(input.today, latest.on))} you changed direction${latest.from === '' ? '' : `, from ${lowerFirst(shortOf(toYou(latest.from)))}`}: ${lowerFirst(to)}.`,
    );
  }
  for (const f of facts) parts.push(sentence(f));
  if (asksDecided || asksLast || general) {
    const decided = standingDecisions(input.reads.memory)
      .filter((m) => latest === undefined || !sameThing(toldAs(m), `${latest.to} ${latest.from}`, 0.5))
      .slice(0, 2);
    for (const m of distinct(decided, toldAs)) {
      const what = toldAs(m);
      parts.push(
        `${upperFirst(sayPast(input.today, dayOf(m, 'decided_on')))} ${/^you\b/.test(what) ? what : `you decided: ${what}`}.`,
      );
    }
  }
  const last = (input.continuity.recentDigests ?? [])[0];
  if (last !== undefined && last.digest.summary.trim() !== '' && asksLast) {
    const first = input.continuity.founderFirstName ?? '';
    const summary = firstSentence(last.digest.summary).replace(/…$/u, '');
    const what = lowerFirst(
      toYou(bare(first === '' ? summary : summary.replace(new RegExp(`^${first}\\b`, 'u'), 'you'))),
    );
    const day = sayPast(input.today, last.date.slice(0, 10));
    parts.push(
      /^you\b/.test(what)
        ? `${upperFirst(day)} ${what}.`
        : `${upperFirst(day)} we talked about this: ${what}.`,
    );
  }
  // A conversation is placed by the idea it was about.
  if (
    asksLast &&
    !asksDecided &&
    !asksIdea &&
    idea !== null &&
    parts.length > 0 &&
    !parts.some((p) => sameThing(p, idea))
  )
    parts.push(`It was about your idea: ${lowerFirst(shortOf(toYou(idea)))}.`);
  const progress = decision.state.criteria.find((c) => c.progress !== null);
  if (progress?.progress != null && (asksLast || asksTodo || general))
    parts.push(
      `You have ${String(progress.progress.done)} of the ${String(progress.progress.of)} ${countedName(progress.criterion)}.`,
    );
  const done = input.reads.steps.find((s) => s.status === 'done');
  if (done !== undefined && (asksLast || general))
    parts.push(
      `You finished one step: ${lowerFirst(bare(done.title))}${done.evidence === null ? '' : ` (${lowerFirst(shortOf(toYou(done.evidence)))})`}.`,
    );
  // The step they are on ends the reply, as on every turn (ai `reply-contract.ts`).
  if (parts.length === 0 && idea !== null) parts.push(`Your idea is ${lowerFirst(toYou(idea))}.`);
  const once = distinct(parts, (t) => t, 0.8);
  if (once.length === 0) return null;
  let text = '';
  for (const part of once) if (joined(text, part).length <= RECALL_CHARS) text = joined(text, part);
  return { text, voice: once.slice(0, 3).join(' ') };
}

/** Words of a recall question that name no fact of the record. */
const GENERIC_ASK = new Set(
  'remember remind again talk discuss decide decided idea startup venture plan last week change record agree session per what'.split(
    ' ',
  ),
);

/** Most characters of a recall. */
const RECALL_CHARS = 690;

// What the model answers from ----------------------------------------------------------------------------------------

/** The program's answer the model gives in its own words; null when the lead is the answer, or the model has to find one. */
function askOf(input: PathTurnInput, decision: Decision, lead: Lead | null): Ask {
  const { play, kind } = decision;
  if (kind === 'social' || kind === 'rehearsal' || kind === 'crisis' || kind === 'recall') return null;
  if (decision.pivot !== null || kind === 'news') return null;
  if (decision.pushes && decision.referral !== null) return pushAsk(decision);
  if (kind === 'report') return reportAsk(input, decision, lead);
  if (decision.howTo) return howToAsk(input, decision);
  if (play !== null) return playAsk(play);
  if (decision.smaller !== null && !decision.overview) return smallerAsk(decision);
  return null;
}

/** The play's answer: its steps are the turn's own. */
const playAsk = (play: Play): Ask => ask(play.title, play.answer, play.why, play.traps);

/** How to do the first part of the step, with its template filled in from what they told. */
function howToAsk(input: PathTurnInput, decision: Decision): Ask {
  const view = decision.step?.view;
  const first = view?.items.find((i) => !i.done);
  if (view === undefined || first === undefined) return null;
  const time = first.minutes === null ? '' : ` It takes about ${String(first.minutes)} minutes.`;
  const made = ask(
    `How to start: ${view.title}`,
    `Start with the first part: ${lowerFirst(bare(first.do))}. ${first.how}${time}`,
    'One part you can finish today moves more than a plan for all of them.',
  );
  return made === null || view.template === null
    ? made
    : { ...made, block: fillTemplate(view.template.body, templateFacts(input, decision)) };
}

/** Who decides and what to take, to a push for a ruling. */
function pushAsk(decision: Decision): Ask {
  const { referral } = decision;
  return ask(
    'Who decides this, and what to take',
    `This one is for ${lowerFirst(bare(referral?.who ?? ''))}. Bring ${lowerFirst(bare(referral?.bring ?? ''))}. I cannot decide it for you, and a yes or no from me would be a guess.`,
    'A wrong yes here is hard to undo, and they answer questions like this for free or early.',
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

/** A step not done, a commitment made: said when the lead says nothing of it. Never asks for what they reported. */
function reportAsk(input: PathTurnInput, decision: Decision, lead: Lead | null): Ask {
  const { report, commitment, step } = decision;
  const parts: string[] = [];
  if (report?.state === 'not_yet') {
    parts.push(
      decision.movedTo === null
        ? 'That happens, and nothing is lost: the step stands.'
        : `That happens, and nothing is lost: the step moves to ${sayDue(input.today, decision.movedTo)}.`,
    );
    const offer = decision.smallerOffer?.items.find((i) => !i.done);
    if (offer !== undefined)
      parts.push(`If it is still too much, do one thing only: ${lowerFirst(bare(offer.do))}.`);
  } else if (lead === null && commitment !== null && step !== null) {
    const first = step.view.items.find((i) => !i.done);
    parts.push(
      'Good, that is a clear commitment.',
      first === undefined || first.do === step.view.title
        ? 'Write one line for each answer, in their words, the same day.'
        : `Begin with this: ${lowerFirst(bare(first.do))}.`,
    );
  }
  if (decision.smaller !== null) {
    const less = smallerAsk(decision)?.answer;
    if (less !== undefined) parts.push(less);
  }
  return parts.length === 0 ? null : ask('What they report, and what it changes', parts.join(' '), '');
}

// Their own facts --------------------------------------------------------------------------------------------------

/** Everything they said or that is on record of them, as one text: what a line written for them may claim. */
function saidText(input: PathTurnInput, decision: Decision): string {
  const { continuity, reads, venture } = input;
  const intake = reads.path?.intake ?? null;
  const profile = continuity.studentProfile ?? null;
  return [
    ...input.earlierMessages,
    input.message,
    venture.name,
    venture.oneLiner,
    venture.currentGoal ?? '',
    intake === null
      ? ''
      : [intake.idea, intake.customer, intake.studies, intake.doneSoFar, intake.block].join('. '),
    profile === null ? '' : [profile.background, profile.learningGoal, profile.constraints].join('. '),
    ...reads.memory
      .filter((m) => m.status === 'confirmed' && !isReference(m))
      .map(
        (m) =>
          `${m.title}. ${m.content}. ${typeof m.attributes.result === 'string' ? m.attributes.result : ''}`,
      ),
    ...reads.criteria.map((c) => c.evidence ?? ''),
    ...reads.steps.map((s) => s.evidence ?? ''),
    ...(reads.path?.pivots ?? []).flatMap((p) => [p.from, p.to]),
    ...(continuity.notebook?.founderProfile ?? []).map((e) => e.text),
    decision.calc.lines.join(' '),
  ]
    .filter((t) => t.trim() !== '')
    .join('\n')
    .slice(0, SAID_CHARS);
}

const SAID_CHARS = 12_000;

/** The one thing on record the answer builds on; none where the lead is the record itself. */
function priorOf(input: PathTurnInput, decision: Decision, lead: Lead | null): PathPromptGuidance['prior'] {
  const { kind } = decision;
  if (kind === 'recall' || kind === 'social' || kind === 'rehearsal' || kind === 'new_idea') return null;
  const found = priorFact({
    oneLiner: input.venture.oneLiner,
    reads: input.reads,
    intake: input.reads.path?.intake ?? null,
    earlier: input.earlierMessages,
    message: input.message,
    about: `${decision.play?.title ?? ''} ${decision.step?.view.title ?? ''} ${decision.play?.answer ?? ''}`,
    said: [(input.earlierReplies ?? []).at(-1) ?? '', lead?.text ?? ''].join(' '),
    applies: kind === 'coaching' && lead === null && decision.referral === null && decision.play !== null,
  });
  return found;
}

interface TemplateFacts {
  readonly idea: string | null;
  readonly customer: string | null;
  readonly venture: string | null;
  readonly founder: string | null;
}

function templateFacts(input: PathTurnInput, decision: Decision): TemplateFacts {
  const customer = input.reads.path?.intake?.customer.trim() ?? '';
  const name = bare(input.venture.name);
  return {
    idea: ideaOf(input, decision),
    customer: customer === '' ? null : bare(customer),
    venture: name === '' || /^new venture\b/i.test(name) ? null : name,
    founder: input.continuity.founderFirstName ?? null,
  };
}

/** A template with what they told in its brackets, and the brackets of what they did not. */
export function fillTemplate(body: string, facts: TemplateFacts): string {
  return body.replace(/\[([^\]\n]{2,80})\]/g, (whole, slot: string) => {
    const t = slot.toLowerCase();
    if (/^your (?:first )?name$|^my name$/.test(t)) return facts.founder ?? whole;
    if (/\b(?:what (?:i|we) would (?:do|make|offer|build)|(?:my|the|your) (?:idea|offer|product)\b)/.test(t))
      return facts.idea === null ? whole : lowerFirst(facts.idea);
    if (/^(?:one )?type of person|^(?:the )?customer$|^who (?:it is for|has (?:it|the problem))/.test(t))
      return facts.customer === null ? whole : lowerFirst(facts.customer);
    if (/^(?:venture|venture name|product name|company)$/.test(t)) return facts.venture ?? whole;
    return whole;
  });
}

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

/** What they might send next about the step, as tap-to-send messages the path answers by itself. */
export function followUpsOf(decision: Decision): string[] {
  const { kind, step } = decision;
  if (step === null || !['coaching', 'report', 'news', 'new_idea'].includes(kind)) return [];
  return [
    ...(decision.howTo ? [] : [HOW_FOLLOW_UP]),
    ...(decision.smaller === null ? [SMALLER_FOLLOW_UP] : []),
  ];
}

const HOW_FOLLOW_UP = 'How do I do the first part?';
const SMALLER_FOLLOW_UP = 'That is too much this week. Can you make it smaller?';
