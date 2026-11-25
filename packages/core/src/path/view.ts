import { type ArcEntry, type PathStageView, type PathStepView, type VenturePath } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';

import { currentStep, followingSteps, type StepContext } from './engine.js';
import { pathState, type PathSource, type PathState } from './state.js';
import { shownStep, stepView } from './steps.js';
import { type Playbook } from './types.js';

const MAX_DONE = 20;

export function stageViews(playbook: Playbook, state: PathState): PathStageView[] {
  return playbook.stages.map((s, i) => ({
    stage: s.stage,
    title: s.title,
    goal: s.goal,
    status: i < state.stageIndex ? 'done' : i === state.stageIndex ? 'current' : 'ahead',
    criteria: state.criteria
      .filter((c) => c.criterion.stage === s.stage)
      .map((c) => ({
        id: c.criterion.id,
        title: c.criterion.title,
        evidence: c.criterion.evidence,
        status: c.status,
      })),
  }));
}

/** The venture's whole path as the app shows it. A step not stored yet has the id and version its first write will have. */
export function venturePathView(
  playbook: Playbook,
  source: PathSource,
  today: string,
  arc: ArcEntry[],
): VenturePath {
  const state = pathState(playbook, source);
  const context: StepContext = { ...source, playbook, today };
  const step = currentStep(context, state);
  const { reads } = source;
  const done = reads.steps
    .filter((s) => s.status === 'done')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || a.id.localeCompare(b.id))
    .slice(0, MAX_DONE)
    .map(stepView);
  return {
    ventureId: source.ventureId,
    stage: state.stage,
    stages: stageViews(playbook, state),
    now: step === null ? null : shownStep(step.view, state),
    next: followingSteps(context, state, step, 3).map((s) => shownStep(s, state)),
    done,
    intake: reads.path?.intake ?? null,
    arc,
    playbookVersion: playbook.version,
    version: reads.path?.version ?? 1,
  };
}

/** A program lead's view: the same shape without a word of the founder's (no intake, no evidence, no story). */
export function overviewView(
  playbook: Playbook,
  ventureId: string,
  overview: pathRepo.PathOverview,
  today: string,
): VenturePath {
  const steps = overview.steps.map((s): pathRepo.PathStepRecord => {
    const play = playbook.plays.find((x) => x.id === s.play_id) ?? null;
    return {
      id: s.id,
      playId: s.play_id,
      criterionId: s.criterion_id,
      title: s.title,
      items: (play?.steps ?? []).map((i) => ({ do: i.do, how: i.how, minutes: i.minutes, done: false })),
      doneWhen: play?.doneWhen ?? s.title,
      dueOn: s.due_on,
      status: s.status,
      origin: s.origin,
      evidence: null,
      reason: null,
      template: null,
      citations: [],
      givenTo: null,
      sourceSessionId: null,
      createdAt: new Date(s.created_at).toISOString(),
      completedAt: s.completed_at === null ? null : new Date(s.completed_at).toISOString(),
      version: s.version,
    };
  });
  const source: PathSource = {
    ventureId,
    venture: { name: '', stage: overview.venture_stage, oneLiner: '', domain: '', currentGoal: null },
    reads: {
      path:
        overview.stage === null
          ? null
          : {
              ventureId,
              stage: overview.stage,
              intake: null,
              intakeBy: null,
              pivots: [],
              playbookVersion: playbook.version,
              version: overview.version ?? 1,
            },
      steps,
      criteria: overview.criteria.map((c) => ({
        criterionId: c.id,
        status: c.status,
        evidence: null,
        stepId: null,
        sourceSessionId: null,
        updatedAt: '',
      })),
      memory: [],
    },
  };
  const view = venturePathView(playbook, source, today, []);
  // Nothing is given to a venture by looking at it: a step no turn has given yet is not shown as one.
  const given = new Set(steps.map((s) => s.id));
  const bare = (s: PathStepView): PathStepView => ({ ...s, evidence: null });
  return {
    ...view,
    now: view.now !== null && given.has(view.now.id) ? bare(view.now) : null,
    next: view.next.filter((s) => given.has(s.id)).map(bare),
    done: view.done.map(bare),
  };
}
