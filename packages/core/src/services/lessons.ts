import { CreateLessonRequest, LessonAction, type LessonView } from '@foundry/contracts';
import { eirRepo, personasRepo, resourcesRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles, requireRole } from '../authz/roles.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';

/**
 * Lessons: de-identified, generalised patterns in a persona's common pool (or program-wide). Distillation
 * proposes them as drafts; the persona's EIR or a program lead edits, publishes or withdraws them. Only
 * published lessons are retrieved, and only for ventures the persona coaches (program-wide ones for all).
 */
export interface LessonsService {
  /** A persona's lessons: drafts first for its curators, published ones only for other EIR-studio roles. */
  list(ctx: RequestContext, personaId: string): Promise<LessonView[]>;
  /** A new draft lesson (program lead or the persona's EIR). */
  create(
    ctx: RequestContext,
    personaId: string,
    input: z.input<typeof CreateLessonRequest>,
  ): Promise<LessonView>;
  /** Edit, publish or withdraw (program lead or the persona's EIR; program-wide lessons: program lead). */
  act(ctx: RequestContext, lessonId: string, action: z.input<typeof LessonAction>): Promise<LessonView>;
}

const STUDIO_ROLES = ['eir', 'program_lead', 'platform_admin'] as const;

export function createLessonsService(kit: Kit): LessonsService {
  async function loadPersona(scope: RequestScope, personaId: string): Promise<personasRepo.PersonaRecord> {
    const persona = await personasRepo.getPersona(scope.tx, personaId);
    if (persona?.tenantId !== scope.ctx.tenantId) throw fail.notFound('Persona');
    return persona;
  }

  /** Program lead, or (for a persona's lesson) the EIR the persona is built from. */
  async function requireCurator(scope: RequestScope, personaId: string | null): Promise<void> {
    const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
    if (hasAnyRole(roles, ['program_lead'])) return;
    if (personaId !== null && hasAnyRole(roles, ['eir'])) {
      const persona = await loadPersona(scope, personaId);
      const profile = persona.eirProfileId
        ? await eirRepo.getEirProfile(scope.tx, persona.eirProfileId)
        : null;
      if (profile?.principalId === scope.ctx.principalId) return;
    }
    scope.deferAudit({
      action: 'authz.denied',
      outcome: 'denied',
      objectType: 'lesson',
      objectId: personaId,
      policyReason: 'requires_lesson_curator',
    });
    throw fail.forbidden(
      'requires_lesson_curator',
      'Only program leads and this persona’s EIR review its lessons',
    );
  }

  return {
    list: async (ctx, rawPersonaId) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      return await kit.inRequest(ctx, async (scope) => {
        await requireRole(scope, STUDIO_ROLES, { objectType: 'lesson', objectId: personaId });
        await loadPersona(scope, personaId);
        const lessons = await resourcesRepo.listLessons(scope.tx, { tenantId: ctx.tenantId, personaId });
        return lessons.map(resourcesRepo.toLessonView);
      });
    },

    create: async (ctx, rawPersonaId, rawInput) => {
      const personaId = requireId(rawPersonaId, 'Persona');
      const input = parseInput(CreateLessonRequest, rawInput);
      return await kit.inRequest(ctx, async (scope) => {
        await loadPersona(scope, personaId);
        await requireCurator(scope, personaId);
        const lesson = await resourcesRepo.createPattern(scope.tx, {
          tenantId: ctx.tenantId,
          personaId,
          origin: 'authored',
          title: input.title,
          context: input.context,
          signal: input.signal,
          intervention: input.intervention,
          outcome: input.outcome,
          limits: input.limits,
          sourceClass: 'authored',
          status: 'draft',
          ownerId: ctx.principalId,
        });
        await audit(scope, {
          action: 'lesson.created',
          outcome: 'succeeded',
          objectType: 'lesson',
          objectId: lesson.id,
          metadata: { personaId, origin: 'authored' },
        });
        return resourcesRepo.toLessonView(lesson);
      });
    },

    act: async (ctx, rawLessonId, rawAction) => {
      const lessonId = requireId(rawLessonId, 'Lesson');
      const action = parseInput(LessonAction, rawAction);
      return await kit.inRequest(ctx, async (scope) => {
        // RLS hides unpublished lessons from everyone but their curators.
        const lesson = await resourcesRepo.getPattern(scope.tx, lessonId);
        if (lesson?.tenantId !== ctx.tenantId) throw fail.notFound('Lesson');
        await requireCurator(scope, lesson.personaId);
        let updated: resourcesRepo.PatternRecord | null;
        switch (action.action) {
          case 'publish':
            if (lesson.status === 'published') return resourcesRepo.toLessonView(lesson);
            updated = await resourcesRepo.updatePattern(
              scope.tx,
              lessonId,
              { status: 'published' },
              { fromStatuses: ['draft', 'in_review'] },
            );
            break;
          case 'withdraw':
            if (lesson.status === 'withdrawn') return resourcesRepo.toLessonView(lesson);
            updated = await resourcesRepo.updatePattern(
              scope.tx,
              lessonId,
              { status: 'withdrawn' },
              { fromStatuses: ['draft', 'in_review', 'published'] },
            );
            break;
          case 'edit': {
            const { action: _action, ...patch } = action;
            if (Object.keys(patch).length === 0) {
              throw fail.validation('Provide at least one field to change');
            }
            updated = await resourcesRepo.updatePattern(scope.tx, lessonId, patch, {
              fromStatuses: ['draft', 'in_review', 'published'],
            });
            break;
          }
        }
        if (updated === null) {
          throw fail.conflict('The lesson cannot change in its current state', 'invalid_transition');
        }
        await audit(scope, {
          action: `lesson.${action.action === 'edit' ? 'edited' : action.action === 'publish' ? 'published' : 'withdrawn'}`,
          outcome: 'succeeded',
          objectType: 'lesson',
          objectId: lessonId,
          metadata: {
            personaId: lesson.personaId,
            from: lesson.status,
            to: updated.status,
            origin: lesson.origin,
          },
        });
        return resourcesRepo.toLessonView(updated);
      });
    },
  };
}
