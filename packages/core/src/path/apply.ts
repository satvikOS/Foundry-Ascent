import { type VentureStage } from '@foundry/contracts';
import { pathRepo, readTogether, type AppExecutor, venturesRepo } from '@foundry/db';

import { type RequestContext } from '../context.js';
import { audit, type RequestScope } from '../internal/kit.js';

import { currentStep, type ChosenStep, type Decision, type StepContext } from './engine.js';
import { type GuardedReport } from './report.js';
import { pathState, stageOrder, type PathSource } from './state.js';
import { playOf, restOf } from './steps.js';
import { type Playbook } from './types.js';

/** Writes of the path, inside a request's transaction (RLS: founders and team of the venture). */

export async function readPathSource(tx: AppExecutor, ventureId: string): Promise<PathSource | null> {
  const { venture, ...reads } = await readTogether(tx, {
    venture: venturesRepo.venturePart(ventureId),
    ...pathRepo.pathParts(ventureId),
  });
  if (venture === null) return null;
  return {
    ventureId,
    venture: {
      name: venture.name,
      stage: venture.stage,
      oneLiner: venture.oneLiner,
      domain: venture.domain,
      currentGoal: venture.currentGoal,
    },
    reads: pathRepo.pathReadsFrom(reads),
  };
}

type Ids = Pick<RequestContext, 'tenantId' | 'principalId'>;

/** Stores the stage the path has reached (never back): the row is created when the venture has none. */
async function keepStage(
  tx: AppExecutor,
  ids: Ids,
  playbook: Playbook,
  source: PathSource,
  stage: VentureStage,
): Promise<boolean> {
  if (source.reads.path === null) {
    await pathRepo.ensurePath(tx, {
      tenantId: ids.tenantId,
      ventureId: source.ventureId,
      stage,
      playbookVersion: playbook.version,
    });
  }
  if (source.reads.path !== null && source.reads.path.stage === stage) return false;
  return pathRepo.advanceStage(tx, {
    ventureId: source.ventureId,
    stage,
    order: stageOrder(playbook),
    playbookVersion: playbook.version,
  });
}

/**
 * Stores a chosen step: inserted, its waiting row promoted, or its row changed (a smaller form, another day); any other
 * `now` step then waits. `sessionId`: the conversation it was said in, for a step in the founder's own words.
 */
export async function keepStep(
  scope: Pick<RequestScope, 'tx'>,
  ids: Ids,
  ventureId: string,
  step: ChosenStep,
  sessionId: string | null = null,
): Promise<void> {
  const { tx } = scope;
  if (step.write === null) return;
  if (step.write === 'insert') {
    const inserted = await pathRepo.insertStep(tx, {
      tenantId: ids.tenantId,
      ventureId,
      step: step.view,
      givenTo: ids.principalId,
      givenSessionId: step.view.origin === 'founder' ? sessionId : null,
    });
    if (inserted)
      await audit(scope, {
        action: 'path.step_given',
        outcome: 'succeeded',
        ventureId,
        objectType: 'path_step',
        objectId: step.view.id,
        metadata: { playId: step.view.playId, origin: step.view.origin },
      });
  } else if (step.storedVersion !== null) {
    // A step changed meanwhile keeps that change.
    const changed = await pathRepo.updateStep(tx, {
      id: step.view.id,
      expectedVersion: step.storedVersion,
      change: {
        ...(step.write === 'promote'
          ? { status: 'now' as const, givenTo: ids.principalId, reason: null }
          : {}),
        items: step.view.items,
        doneWhen: step.view.doneWhen,
        dueOn: step.view.dueOn,
      },
    });
    if (changed !== null && step.write === 'change')
      await audit(scope, {
        action: 'path.step_updated',
        outcome: 'succeeded',
        ventureId,
        objectType: 'path_step',
        objectId: step.view.id,
        metadata: { update: 'turn', playId: step.view.playId },
      });
  }
  if (step.view.status === 'now' && step.write !== 'change')
    await pathRepo.demoteOtherSteps(tx, { ventureId, keepId: step.view.id });
}

/** Completes a step with the founder's words, and the criterion it produces. Null: it changed since it was read. */
export async function completeStep(
  scope: Pick<RequestScope, 'tx'>,
  ids: Ids,
  args: {
    readonly ventureId: string;
    readonly step: pathRepo.PathStepRecord;
    readonly expectedVersion: number;
    readonly evidence: string;
    readonly sourceSessionId: string | null;
    readonly how: 'founder' | 'report';
    /** Set: only the small part it was cut to is done; the rest goes on ({@link restOf}). */
    readonly rest?: ReturnType<typeof restOf>;
  },
): Promise<pathRepo.PathStepRecord | null> {
  const { tx } = scope;
  const rest = args.rest ?? null;
  if (rest !== null) {
    const goesOn = await pathRepo.updateStep(tx, {
      id: args.step.id,
      expectedVersion: args.expectedVersion,
      change: { items: rest.items, doneWhen: rest.doneWhen, dueOn: rest.dueOn },
    });
    if (goesOn !== null)
      await audit(scope, {
        action: 'path.step_part_done',
        outcome: 'succeeded',
        ventureId: args.ventureId,
        objectType: 'path_step',
        objectId: goesOn.id,
        metadata: { playId: goesOn.playId, how: args.how },
      });
    return goesOn;
  }
  const done = await pathRepo.updateStep(tx, {
    id: args.step.id,
    expectedVersion: args.expectedVersion,
    change: {
      status: 'done',
      items: args.step.items.map((i) => ({ ...i, done: true })),
      evidence: args.evidence.slice(0, 1000),
      sourceSessionId: args.sourceSessionId,
      completedBy: ids.principalId,
    },
  });
  if (done === null) return null;
  if (done.criterionId !== null)
    await pathRepo.setCriterion(tx, {
      tenantId: ids.tenantId,
      ventureId: args.ventureId,
      criterionId: done.criterionId,
      status: 'met',
      evidence: args.evidence.slice(0, 1000),
      stepId: done.id,
      sourceSessionId: args.sourceSessionId,
      principalId: ids.principalId,
    });
  await audit(scope, {
    action: 'path.step_completed',
    outcome: 'succeeded',
    ventureId: args.ventureId,
    objectType: 'path_step',
    objectId: done.id,
    metadata: { playId: done.playId, criterionId: done.criterionId, how: args.how },
  });
  return done;
}

/**
 * After a change: the stage the path has reached is kept, and the step it is on is stored (its due date starts today).
 * The state is read again, so what the change showed counts.
 */
export async function settlePath(
  scope: Pick<RequestScope, 'tx'>,
  ids: Ids,
  playbook: Playbook,
  ventureId: string,
  today: string,
): Promise<PathSource | null> {
  const source = await readPathSource(scope.tx, ventureId);
  if (source === null) return null;
  const state = pathState(playbook, source);
  const moved = await keepStage(scope.tx, ids, playbook, source, state.stage);
  if (moved && source.reads.path !== null)
    await audit(scope, {
      action: 'path.stage_reached',
      outcome: 'succeeded',
      ventureId,
      objectType: 'venture_path',
      objectId: ventureId,
      metadata: { stage: state.stage, from: source.reads.path.stage },
    });
  const context: StepContext = { ...source, playbook, today };
  const step = currentStep(context, state);
  if (step !== null) await keepStep(scope, ids, ventureId, step);
  return readPathSource(scope.tx, ventureId);
}

/**
 * Stores what a turn's decision changed, in one transaction: the direction it changed, the idea it told, the step the
 * founder's own report finished, the work it claims, and the step it gave.
 */
export async function keepDecided(
  scope: Pick<RequestScope, 'tx'>,
  ids: Ids,
  args: {
    readonly playbook: Playbook;
    readonly ventureId: string;
    readonly sessionId: string;
    readonly today: string;
    readonly decision: Decision;
  },
): Promise<void> {
  const { tx } = scope;
  const { playbook, ventureId, sessionId, decision } = args;
  const { completes, applied, pivot } = decision;
  const step = decision.keeps;
  if (pivot !== null) {
    const reopen = (criterionId: string, evidence: string | null): Promise<void> =>
      pathRepo.setCriterion(tx, {
        tenantId: ids.tenantId,
        ventureId,
        criterionId,
        status: 'open',
        evidence,
        stepId: null,
        sourceSessionId: evidence === null ? null : sessionId,
        principalId: ids.principalId,
      });
    for (const criterion of pivot.reopened) {
      await reopen(criterion.id, null);
      const kept = pivot.kept.find((c) => c.criterionId === criterion.id);
      if (kept !== undefined) await reopen(criterion.id, kept.evidence);
    }
    await pathRepo.keepPivot(tx, {
      tenantId: ids.tenantId,
      ventureId,
      principalId: ids.principalId,
      stage: pivot.stage,
      playbookVersion: playbook.version,
      pivot: { on: args.today, from: pivot.from.slice(0, 400), to: pivot.to, sessionId },
      sessionId,
    });
    await audit(scope, {
      action: 'path.direction_changed',
      outcome: 'succeeded',
      ventureId,
      objectType: 'venture_path',
      objectId: ventureId,
      metadata: { stage: pivot.stage, reopened: pivot.reopened.length },
    });
  }
  if (decision.idea !== null) {
    const kept = await pathRepo.keepIdea(tx, {
      tenantId: ids.tenantId,
      ventureId,
      principalId: ids.principalId,
      stage: decision.state.stage,
      playbookVersion: playbook.version,
      idea: decision.idea,
      sessionId,
    });
    if (kept)
      await audit(scope, {
        action: 'path.idea_kept',
        outcome: 'succeeded',
        ventureId,
        objectType: 'venture_path',
        objectId: ventureId,
      });
  }
  if (completes !== null)
    await completeStep(scope, ids, {
      ventureId,
      step: completes.step,
      expectedVersion: completes.step.version,
      evidence: completes.evidence,
      sourceSessionId: sessionId,
      how: 'report',
      rest: completes.rest,
    });
  await pathRepo.ensurePath(tx, {
    tenantId: ids.tenantId,
    ventureId,
    stage: decision.state.stage,
    playbookVersion: playbook.version,
  });
  for (const row of applied?.rows ?? []) {
    await pathRepo.setCriterion(tx, {
      tenantId: ids.tenantId,
      ventureId,
      criterionId: row.criterionId,
      status: row.status,
      evidence: row.evidence,
      stepId: null,
      sourceSessionId: sessionId,
      principalId: ids.principalId,
    });
    await audit(scope, {
      action: row.status === 'claimed' ? 'path.criterion_claimed' : 'path.criterion_progress',
      outcome: 'succeeded',
      ventureId,
      objectType: 'path_criterion',
      objectId: row.criterionId,
      metadata: { how: 'founder_words' },
    });
  }
  if (applied?.stage != null)
    await pathRepo.advanceStage(tx, {
      ventureId,
      stage: applied.stage,
      order: stageOrder(playbook),
      playbookVersion: playbook.version,
    });
  if (step !== null) await keepStep(scope, ids, ventureId, step, sessionId);
  if (completes !== null || applied !== null || pivot !== null)
    await settlePath(scope, ids, playbook, ventureId, args.today);
}

/** Whether a decision changes anything stored. */
export function changesPath(decision: Decision): boolean {
  return (
    decision.completes !== null ||
    decision.applied !== null ||
    decision.pivot !== null ||
    decision.idea !== null ||
    decision.keeps !== null
  );
}

/**
 * Applies what a message reported (already held to the founder's words, `report.ts`): the step it is about is finished,
 * blocked or dropped, and criteria are claimed. A step that changed since the turn read it keeps that change.
 */
export async function applyReport(
  scope: Pick<RequestScope, 'tx'>,
  ids: Ids,
  args: {
    readonly playbook: Playbook;
    readonly ventureId: string;
    readonly sessionId: string;
    readonly today: string;
    readonly report: GuardedReport;
    /** The stored step the report is about (null: none was open). */
    readonly step: pathRepo.PathStepRecord | null;
  },
): Promise<boolean> {
  const { tx } = scope;
  const { report, step } = args;
  let changed = false;
  if (report.step !== null && report.quote !== null && step !== null) {
    if (report.step === 'done') {
      const done = await completeStep(scope, ids, {
        ventureId: args.ventureId,
        step,
        expectedVersion: step.version,
        evidence: report.quote,
        sourceSessionId: args.sessionId,
        how: 'report',
        rest: restOf({ today: args.today }, step, playOf(args.playbook, step.playId), null),
      });
      changed = done !== null;
    } else if (report.step === 'blocked' || report.step === 'dropped') {
      const updated = await pathRepo.updateStep(tx, {
        id: step.id,
        expectedVersion: step.version,
        change: {
          status: report.step === 'blocked' ? 'blocked' : 'skipped',
          reason: report.quote.slice(0, 300),
          sourceSessionId: args.sessionId,
        },
      });
      changed = updated !== null;
      if (changed)
        await audit(scope, {
          action: report.step === 'blocked' ? 'path.step_blocked' : 'path.step_skipped',
          outcome: 'succeeded',
          ventureId: args.ventureId,
          objectType: 'path_step',
          objectId: step.id,
          metadata: { playId: step.playId, how: 'report' },
        });
    }
  }
  for (const claim of report.criteria) {
    await pathRepo.setCriterion(tx, {
      tenantId: ids.tenantId,
      ventureId: args.ventureId,
      criterionId: claim.id,
      status: 'claimed',
      evidence: claim.quote.slice(0, 1000),
      stepId: null,
      sourceSessionId: args.sessionId,
      principalId: ids.principalId,
    });
    changed = true;
    await audit(scope, {
      action: 'path.criterion_claimed',
      outcome: 'succeeded',
      ventureId: args.ventureId,
      objectType: 'path_criterion',
      objectId: claim.id,
      metadata: { how: 'report' },
    });
  }
  if (changed) await settlePath(scope, ids, args.playbook, args.ventureId, args.today);
  return changed;
}
