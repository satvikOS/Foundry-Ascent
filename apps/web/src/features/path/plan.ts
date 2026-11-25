import type {
  ArcEntry,
  ArcEntryKind,
  CriterionStatus,
  PathStageView,
  PathStepView,
  VenturePath,
} from '@foundry/contracts';

import { dueState, longDay } from './due';
import { citationLabel, type StepCitation } from './sources';

/*
 * The path as a plan a person reads: what is shown on the page, printed on one sheet and copied as text, all from the
 * same data.
 */

export const ARC_LABELS: Record<ArcEntryKind, string> = {
  origin: 'Origin',
  idea: 'Idea',
  pivot: 'Pivot',
  decision: 'Decision',
  experiment: 'Experiment',
  result: 'Result',
  milestone: 'Milestone',
  setback: 'Setback',
  commitment: 'Commitment',
  step_done: 'Step done',
  conversation: 'Conversation',
};

export const CRITERION_LABELS: Record<CriterionStatus, string> = {
  open: 'Open',
  claimed: 'Claimed',
  met: 'Met',
};

/** What a story tells first on the same day: where it started, then the turns, then what came of them. */
const ARC_ORDER: readonly ArcEntryKind[] = [
  'origin',
  'idea',
  'pivot',
  'decision',
  'experiment',
  'result',
  'setback',
  'milestone',
  'step_done',
  'commitment',
  'conversation',
];

/** The story oldest first, so it reads as a backstory; conversations only when asked for. */
export function story(arc: readonly ArcEntry[], { conversations = false } = {}): ArcEntry[] {
  return arc
    .filter((entry) => conversations || entry.kind !== 'conversation')
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        a.entry.on.slice(0, 10).localeCompare(b.entry.on.slice(0, 10)) ||
        ARC_ORDER.indexOf(a.entry.kind) - ARC_ORDER.indexOf(b.entry.kind) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

export function currentStage(path: Pick<VenturePath, 'stages' | 'stage'>): PathStageView | null {
  return (
    path.stages.find((stage) => stage.status === 'current') ??
    path.stages.find((stage) => stage.stage === path.stage) ??
    null
  );
}

/** "Stage 2 of 7: Discovery". */
export function stageLine(path: Pick<VenturePath, 'stages' | 'stage'>): string {
  const stage = currentStage(path);
  if (!stage) return '';
  return `Stage ${String(path.stages.indexOf(stage) + 1)} of ${String(path.stages.length)}: ${stage.title}`;
}

export interface LaterItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
}

/**
 * What comes after the next steps: the path's later steps, then what the current stage still asks for that no step
 * covers yet, then the next stage.
 */
export function laterItems(path: VenturePath): LaterItem[] {
  const steps = [...(path.now ? [path.now] : []), ...path.next];
  const covered = new Set([...steps, ...path.done].map((step) => step.criterionId));
  const stage = currentStage(path);
  const nextStage = path.stages.find((candidate) => candidate.status === 'ahead');
  return [
    ...path.next
      .filter((step) => step.status === 'later')
      .map((step) => ({ id: step.id, title: step.title, detail: step.doneWhen })),
    ...(stage?.criteria ?? [])
      .filter((criterion) => criterion.status === 'open' && !covered.has(criterion.id))
      .map((criterion) => ({ id: criterion.id, title: criterion.title, detail: criterion.evidence })),
    ...(nextStage ? [{ id: nextStage.stage, title: `Then ${nextStage.title}`, detail: nextStage.goal }] : []),
  ];
}

/** The steps right after the current one. */
export function nextSteps(path: Pick<VenturePath, 'next'>): PathStepView[] {
  return path.next.filter((step) => step.status !== 'later');
}

/** What the founder reported for a criterion, from the steps that produce it. */
export function reportedEvidence(
  path: Pick<VenturePath, 'done' | 'now' | 'next'>,
  criterionId: string,
): PathStepView[] {
  return [...path.done, ...(path.now ? [path.now] : []), ...path.next].filter(
    (step) => step.criterionId === criterionId && step.evidence !== null && step.status !== 'skipped',
  );
}

/** Every source the plan's open steps cite, each once. */
export function planSources(path: Pick<VenturePath, 'now' | 'next'>): StepCitation[] {
  const seen = new Map<string, StepCitation>();
  for (const step of [...(path.now ? [path.now] : []), ...path.next])
    for (const citation of step.citations) seen.set(citationLabel(citation), citation);
  return [...seen.values()];
}

export interface PlanContext {
  readonly ventureName: string;
  readonly disclosure: string;
  readonly now?: Date;
}

/** How many of the story's entries fit the one-page plan: where it started, then the latest. */
export const PLAN_STORY = 10;

export function planStory(arc: readonly ArcEntry[]): ArcEntry[] {
  const all = story(arc);
  const first = all[0];
  if (all.length <= PLAN_STORY || !first) return all;
  return [first, ...all.slice(-(PLAN_STORY - 1))];
}

function dueSuffix(step: PathStepView, now: Date): string {
  const due = dueState(step.dueOn, now);
  return due ? ` (${due.text})` : '';
}

/** The plan as plain text, to paste into an email or a document. */
export function planAsText(
  path: VenturePath,
  { ventureName, disclosure, now = new Date() }: PlanContext,
): string {
  const stage = currentStage(path);
  const lines: string[] = [`${ventureName}: plan`, longDay(now.toISOString()), ''];
  const block = (title: string, body: readonly string[]) => {
    if (body.length > 0) lines.push(title, ...body, '');
  };
  block(stageLine(path), [
    ...(stage ? [`Goal: ${stage.goal}`] : []),
    ...(stage?.criteria ?? []).map(
      (criterion) =>
        `- [${criterion.status === 'met' ? 'x' : criterion.status === 'claimed' ? '~' : ' '}] ${criterion.title}: ${CRITERION_LABELS[criterion.status].toLowerCase()}. ${criterion.evidence}`,
    ),
  ]);
  if (path.now) {
    block(`Now${dueSuffix(path.now, now)}`, [
      path.now.title,
      ...path.now.items.map(
        (item, index) =>
          `${String(index + 1)}. [${item.done ? 'x' : ' '}] ${item.do}${item.how ? ` (${item.how})` : ''}`,
      ),
      `Done when: ${path.now.doneWhen}`,
    ]);
  }
  block(
    'Next',
    nextSteps(path).map((step) => `- ${step.title}${dueSuffix(step, now)}`),
  );
  block(
    'Later',
    laterItems(path).map((item) => `- ${item.title}`),
  );
  block(
    'Done',
    path.done.map(
      (step) =>
        `- ${step.title}${step.completedAt ? `, ${longDay(step.completedAt)}` : ''}${step.evidence ? `: ${step.evidence}` : ''}`,
    ),
  );
  block(
    'Story',
    planStory(path.arc).map(
      (entry) =>
        `- ${longDay(entry.on)}, ${ARC_LABELS[entry.kind].toLowerCase()}: ${entry.title}${entry.detail ? `. ${entry.detail}` : ''}`,
    ),
  );
  block(
    'Sources',
    planSources(path).map(
      (source) =>
        `- ${citationLabel(source)}${source.authors ? ` (${source.authors})` : ''}${source.url ? ` ${source.url}` : ''}`,
    ),
  );
  lines.push(disclosure);
  return `${lines.join('\n').trim()}\n`;
}
