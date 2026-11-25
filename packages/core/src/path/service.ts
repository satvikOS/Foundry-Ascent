import {
  SavePathIntake,
  UpdatePathStep,
  type ArcEntry,
  type PathStepAction,
  type VenturePath,
} from '@foundry/contracts';
import {
  pathRepo,
  readTogether,
  sessionsRepo,
  studentRepo,
  venturesRepo,
  type AppExecutor,
} from '@foundry/db';

import { hasAnyRole, loadPrincipalRoles } from '../authz/roles.js';
import { enforceVentureAccess, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { completeStep, readPathSource, settlePath } from './apply.js';
import { arcOf } from './brief.js';
import { currentStep, followingSteps, type StepContext } from './engine.js';
import { PLAYBOOK } from './playbook/index.js';
import { pathState, type PathSource } from './state.js';
import { deadlineOf, openCriterionOf, playOf, restOf, stepFor } from './steps.js';
import { dueOnFor } from './dates.js';
import { type Playbook } from './types.js';
import { overviewView, venturePathView } from './view.js';

/** The founder path of a venture: founders and team read and change it; its EIR and program leads only read. */
export interface PathService {
  /** The path as it stands now; nothing is written by reading it. */
  get(ctx: RequestContext, ventureId: string): Promise<VenturePath>;
  /** The venture's story so far, oldest first. */
  arc(ctx: RequestContext, ventureId: string): Promise<ArcEntry[]>;
  /** What the founder told Thomas once. 409 when the path changed since it was read. */
  saveIntake(ctx: RequestContext, ventureId: string, input: unknown): Promise<VenturePath>;
  /** A founder's own change to a step (tick, complete, add, skip, block, reopen, reschedule). 409 when it changed. */
  updateStep(ctx: RequestContext, ventureId: string, stepId: string, input: unknown): Promise<VenturePath>;
}

const ARC_DIGESTS = 12;

export function createPathService(kit: Kit, playbook: Playbook = PLAYBOOK): PathService {
  const todayOf = (): string => kit.now().toISOString().slice(0, 10);

  /** The path's source with what its story adds (the person's own profile, the venture's conversations). */
  async function readWithStory(
    tx: AppExecutor,
    ventureId: string,
  ): Promise<{ source: PathSource; arc: ArcEntry[] }> {
    const { venture, profile, digests, ...reads } = await readTogether(tx, {
      venture: venturesRepo.venturePart(ventureId),
      profile: studentRepo.studentProfilePart(ventureId),
      digests: sessionsRepo.recentDigestsPart({ ventureId, limit: ARC_DIGESTS }),
      ...pathRepo.pathParts(ventureId),
    });
    if (venture === null) throw fail.notFound('Venture');
    const source: PathSource = {
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
    return {
      source,
      arc: arcOf({
        today: todayOf(),
        venture: source.venture,
        reads: source.reads,
        profile,
        notebook: null,
        digests: digests.map((d) => ({
          sessionId: d.sessionId,
          date: d.lastActivityAt,
          title: d.title,
          summary: d.digest.summary,
        })),
      }),
    };
  }

  async function viewOf(scope: RequestScope, ventureId: string): Promise<VenturePath> {
    const { source, arc } = await readWithStory(scope.tx, ventureId);
    return venturePathView(playbook, source, todayOf(), arc);
  }

  /**
   * What the caller may read: the whole path (founders, team, the assigned EIR), its shape (a program lead), or nothing.
   * An advisor sees the venture but not its conversations, and not its path either (RLS, `sessions_read`).
   */
  async function access(scope: RequestScope, ventureId: string): Promise<'full' | 'shape'> {
    const relation = await venturesRepo.getVentureAccess(scope.tx, {
      ventureId,
      principalId: scope.ctx.principalId,
    });
    const related = relation !== null && (relation.membershipRole !== null || relation.isAssignedEir);
    if (!related) {
      const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
      if (hasAnyRole(roles, ['program_lead', 'platform_admin'])) return 'shape';
    }
    const decision = enforceVentureAccess(scope, ventureId, relation, 'read');
    if (decision.relation === 'advisor') {
      scope.deferAudit({
        action: 'venture.access',
        outcome: 'denied',
        ventureId,
        objectType: 'venture_path',
        objectId: ventureId,
        policyReason: 'read:insufficient_relation:advisor',
      });
      throw fail.forbidden('insufficient_relation:advisor');
    }
    return 'full';
  }

  /**
   * The step as stored; one the path derives, or a turn offered, is stored first: as it was shown, waiting behind the
   * path's own step.
   */
  async function storedStep(
    scope: RequestScope,
    ventureId: string,
    stepId: string,
  ): Promise<{ step: pathRepo.PathStepRecord; source: PathSource }> {
    const known = await pathRepo.getStep(scope.tx, stepId);
    const source = await readPathSource(scope.tx, ventureId);
    if (source === null) throw fail.notFound('Venture');
    if (known !== null) {
      if (!source.reads.steps.some((s) => s.id === known.id))
        throw fail.notFound('Step', 'step_of_another_venture');
      return { step: known, source };
    }
    const state = pathState(playbook, source);
    const context: StepContext = { ...source, playbook, today: todayOf() };
    const step = currentStep(context, state);
    const derived =
      [...(step === null ? [] : [step.view]), ...followingSteps(context, state, step, 3)].find(
        (s) => s.id === stepId,
      ) ?? (await offeredStep(scope, context, ventureId, stepId));
    if (derived === undefined) throw fail.notFound('Step', 'step_unknown');
    await pathRepo.ensurePath(scope.tx, {
      tenantId: scope.ctx.tenantId,
      ventureId,
      stage: state.stage,
      playbookVersion: playbook.version,
    });
    await pathRepo.insertStep(scope.tx, {
      tenantId: scope.ctx.tenantId,
      ventureId,
      step: derived,
      givenTo: scope.ctx.principalId,
    });
    const stored = await pathRepo.getStep(scope.tx, stepId);
    if (stored === null) throw fail.notFound('Step', 'step_unknown');
    return { step: stored, source };
  }

  /** A step a turn offered (as that turn showed it), or one any play of the playbook would give. */
  async function offeredStep(
    scope: RequestScope,
    context: StepContext,
    ventureId: string,
    stepId: string,
  ): Promise<pathRepo.InsertStepInput['step'] | undefined> {
    const shown = await pathRepo.shownStep(scope.tx, ventureId, stepId);
    const state = pathState(playbook, context);
    for (const play of playbook.plays) {
      for (const origin of ['path', 'coach'] as const) {
        const { view } = stepFor(context, play, {
          status: 'next',
          criterionId: origin === 'coach' ? null : openCriterionOf(state, play, false),
          origin,
        });
        if (view.id !== stepId) continue;
        const kept = shown?.playId === play.id ? shown : null;
        return {
          ...view,
          // What they were shown (a smaller form of it) is what they take.
          items: (kept?.items ?? view.items).map((i) => ({ ...i, done: false })),
          doneWhen: kept?.doneWhen ?? view.doneWhen,
          dueOn: kept?.dueOn ?? dueOnFor(context.today, play.days, deadlineOf(context)),
        };
      }
    }
    return undefined;
  }

  const changed = (): Error => fail.conflict('This step changed. Reload it and try again.', 'step_version');
  const closed = (message: string): Error => fail.conflict(message, 'step_state');

  async function applyAction(
    scope: RequestScope,
    ventureId: string,
    { step, source }: { step: pathRepo.PathStepRecord; source: PathSource },
    expectedVersion: number,
    action: PathStepAction,
  ): Promise<void> {
    const ids = scope.ctx;
    const open = step.status !== 'done' && step.status !== 'skipped';
    if (step.version !== expectedVersion) throw changed();
    const change = async (c: pathRepo.StepChange): Promise<void> => {
      if ((await pathRepo.updateStep(scope.tx, { id: step.id, expectedVersion, change: c })) === null)
        throw changed();
    };
    switch (action.action) {
      case 'tick': {
        if (!open) throw closed('This step is closed. Reopen it to change it.');
        if (step.items[action.item] === undefined)
          throw fail.validation('The request is not valid', [
            { path: 'update.item', message: 'This step has no such item' },
          ]);
        await change({
          items: step.items.map((i, n) => (n === action.item ? { ...i, done: action.done } : i)),
        });
        break;
      }
      case 'complete': {
        if (!open) throw closed('This step is already closed.');
        const done = await completeStep(scope, ids, {
          ventureId,
          step,
          expectedVersion,
          evidence: action.evidence,
          sourceSessionId: null,
          how: 'founder',
          rest: restOf(
            { today: todayOf() },
            step,
            playOf(playbook, step.playId),
            source.reads.path?.intake?.deadline?.on ?? null,
          ),
        });
        if (done === null) throw changed();
        break;
      }
      case 'add': {
        if (!open) throw closed('This step is closed. Reopen it to change it.');
        // It waits behind the step they are on; with none under way, it is the step now.
        const under = source.reads.steps.some((s) => s.status === 'now' && s.id !== step.id);
        if (step.status !== 'now')
          await change({ status: under ? 'next' : 'now', givenTo: ids.principalId, reason: null });
        break;
      }
      case 'skip':
        if (!open) throw closed('This step is already closed.');
        await change({ status: 'skipped', reason: action.reason, sourceSessionId: null });
        break;
      case 'block':
        if (!open) throw closed('This step is closed. Reopen it to change it.');
        await change({ status: 'blocked', reason: action.reason, sourceSessionId: null });
        break;
      case 'reopen':
        if (step.status !== 'done' && step.status !== 'skipped' && step.status !== 'blocked')
          throw closed('This step is already open.');
        await change({ status: 'now', reason: null, evidence: null, sourceSessionId: null });
        await pathRepo.demoteOtherSteps(scope.tx, { ventureId, keepId: step.id });
        // What the finished step had shown is open again (whatever else the record says: they took it back).
        if (step.status === 'done' && step.criterionId !== null)
          await pathRepo.setCriterion(scope.tx, {
            tenantId: ids.tenantId,
            ventureId,
            criterionId: step.criterionId,
            status: 'open',
            evidence: null,
            stepId: step.id,
            sourceSessionId: null,
            principalId: ids.principalId,
          });
        break;
      case 'reschedule':
        if (!open) throw closed('This step is closed. Reopen it to change it.');
        if (action.dueOn < todayOf())
          throw fail.validation('The request is not valid', [
            { path: 'update.dueOn', message: 'Choose today or a later day' },
          ]);
        await change({ dueOn: action.dueOn });
        break;
    }
    if (action.action !== 'complete')
      await audit(scope, {
        action: 'path.step_updated',
        outcome: 'succeeded',
        ventureId,
        objectType: 'path_step',
        objectId: step.id,
        metadata: { update: action.action, playId: step.playId },
      });
    if (action.action === 'complete' || action.action === 'skip' || action.action === 'block')
      await settlePath(scope, ids, playbook, ventureId, todayOf());
  }

  return {
    get: (ctx, rawId) =>
      kit.inRequest(ctx, async (scope) => {
        const ventureId = requireId(rawId, 'Venture');
        if ((await access(scope, ventureId)) === 'full') return viewOf(scope, ventureId);
        const overview = await pathRepo.pathOverview(scope.tx, ventureId);
        if (overview === null) throw fail.notFound('Venture', 'venture_not_visible');
        await audit(scope, {
          action: 'path.overview_read',
          outcome: 'succeeded',
          ventureId,
          objectType: 'venture_path',
          objectId: ventureId,
        });
        return overviewView(playbook, ventureId, overview, todayOf());
      }),
    arc: (ctx, rawId) =>
      kit.inRequest(ctx, async (scope) => {
        const ventureId = requireId(rawId, 'Venture');
        // The story is the founders' own words: never in a program lead's view.
        if ((await access(scope, ventureId)) !== 'full') {
          scope.deferAudit({
            action: 'venture.access',
            outcome: 'denied',
            ventureId: null,
            objectType: 'venture_path',
            objectId: ventureId,
            policyReason: 'read:no_relationship',
          });
          throw fail.forbidden('path_story_team_only');
        }
        return (await readWithStory(scope.tx, ventureId)).arc;
      }),
    saveIntake: (ctx, rawId, input) =>
      kit.inRequest(ctx, async (scope) => {
        const ventureId = requireId(rawId, 'Venture');
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'venture_path' });
        const value = parseInput(SavePathIntake, input);
        const source = await readPathSource(scope.tx, ventureId);
        if (source === null) throw fail.notFound('Venture');
        const saved = await pathRepo.saveIntake(scope.tx, {
          tenantId: ctx.tenantId,
          ventureId,
          principalId: ctx.principalId,
          stage: pathState(playbook, source).stage,
          playbookVersion: playbook.version,
          intake: value.intake,
          expectedVersion: value.expectedVersion,
        });
        if (saved === null)
          throw fail.conflict('Your path changed. Reload it before saving.', 'path_version');
        await audit(scope, {
          action: 'path.intake_saved',
          outcome: 'succeeded',
          ventureId,
          objectType: 'venture_path',
          objectId: ventureId,
          metadata: { version: saved.version, deadline: value.intake.deadline !== null },
        });
        return viewOf(scope, ventureId);
      }),
    updateStep: (ctx, rawId, rawStepId, input) =>
      kit.inRequest(ctx, async (scope) => {
        const ventureId = requireId(rawId, 'Venture');
        const stepId = requireId(rawStepId, 'Step');
        await requireVentureAccess(scope, ventureId, 'write', { objectType: 'venture_path' });
        const value = parseInput(UpdatePathStep, input);
        const stored = await storedStep(scope, ventureId, stepId);
        await applyAction(scope, ventureId, stored, value.expectedVersion, value.update);
        return viewOf(scope, ventureId);
      }),
  };
}
