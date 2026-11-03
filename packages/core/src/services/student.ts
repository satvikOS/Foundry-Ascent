import {
  LearningReflectionInput,
  SaveStudentProfile,
  type StudentProfile,
  type LearningReflection,
} from '@foundry/contracts';
import { p, sessionsRepo, studentRepo } from '@foundry/db';
import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit } from '../internal/kit.js';

/** Students approve their own profile and learning reflections; models never write them. */
export interface StudentService {
  profile(ctx: RequestContext, ventureId: string): Promise<StudentProfile | null>;
  save(ctx: RequestContext, ventureId: string, input: unknown): Promise<StudentProfile>;
  forget(ctx: RequestContext, ventureId: string): Promise<void>;
  log(ctx: RequestContext, ventureId: string): Promise<LearningReflection[]>;
  reflect(ctx: RequestContext, ventureId: string, input: unknown): Promise<LearningReflection>;
  removeReflection(ctx: RequestContext, ventureId: string, id: string): Promise<void>;
}
export function createStudentService(kit: Kit): StudentService {
  return {
    profile: (ctx, ventureId) =>
      kit.inRequest(ctx, async (scope) => {
        requireId(ventureId, 'Venture');
        await requireVentureAccess(scope, ventureId, 'read');
        return studentRepo.getStudentProfile(scope.tx, ventureId);
      }),
    save: (ctx, ventureId, input) =>
      kit.inRequest(ctx, async (scope) => {
        requireId(ventureId, 'Venture');
        await requireVentureAccess(scope, ventureId, 'write');
        const value = parseInput(SaveStudentProfile, input);
        const result = await scope.tx.query(
          `INSERT INTO student_profiles (tenant_id, venture_id, principal_id, profile)
        SELECT :tenant, :venture, :principal, :profile WHERE :version = 0
        ON CONFLICT (tenant_id, venture_id, principal_id) DO UPDATE SET profile = :profile,
        version = student_profiles.version + 1, approved_at = now() WHERE student_profiles.version = :version
        RETURNING version`,
          {
            tenant: p.uuid(ctx.tenantId),
            venture: p.uuid(ventureId),
            principal: p.uuid(ctx.principalId),
            profile: p.json(value.profile),
            version: p.int(value.expectedVersion),
          },
        );
        // For updates the SELECT must include a row, while creation must require version zero.
        if (result.rows.length === 0) {
          const updated = await scope.tx.query(
            `UPDATE student_profiles SET profile = :profile, version = version + 1, approved_at = now()
          WHERE tenant_id = app.current_tenant() AND principal_id = app.current_principal() AND venture_id = :venture AND version = :version RETURNING version`,
            {
              profile: p.json(value.profile),
              venture: p.uuid(ventureId),
              version: p.int(value.expectedVersion),
            },
          );
          if (updated.rows.length === 0)
            throw fail.conflict('Your profile changed. Reload it before saving.', 'profile_version');
        }
        await audit(scope, {
          action: 'student.profile_approved',
          outcome: 'succeeded',
          ventureId,
          objectType: 'student_profile',
          objectId: ctx.principalId,
        });
        const saved = await studentRepo.getStudentProfile(scope.tx, ventureId);
        if (!saved)
          throw new DomainError('internal', 'The profile could not be loaded.', {
            reason: 'profile_missing',
          });
        return saved;
      }),
    forget: (ctx, ventureId) =>
      kit.inRequest(ctx, async (scope) => {
        requireId(ventureId, 'Venture');
        await requireVentureAccess(scope, ventureId, 'write');
        await scope.tx.query(
          `DELETE FROM student_profiles WHERE tenant_id = app.current_tenant() AND principal_id = app.current_principal() AND venture_id = :venture`,
          { venture: p.uuid(ventureId) },
        );
        await audit(scope, {
          action: 'student.profile_deleted',
          outcome: 'succeeded',
          ventureId,
          objectType: 'student_profile',
          objectId: ctx.principalId,
        });
      }),
    log: (ctx, ventureId) =>
      kit.inRequest(ctx, async (scope) => {
        requireId(ventureId, 'Venture');
        await requireVentureAccess(scope, ventureId, 'read');
        return studentRepo.listLearningLog(scope.tx, ventureId);
      }),
    reflect: (ctx, ventureId, input) =>
      kit.inRequest(ctx, async (scope) => {
        requireId(ventureId, 'Venture');
        await requireVentureAccess(scope, ventureId, 'write');
        const reflection = parseInput(LearningReflectionInput, input);
        if (reflection.sessionId) {
          const session = await sessionsRepo.getSession(scope.tx, reflection.sessionId);
          if (session?.ventureId !== ventureId) throw fail.notFound('Conversation', 'reflection_session');
        }
        const inserted = await scope.tx.query(
          `INSERT INTO learning_log (tenant_id, venture_id, principal_id, reflection)
        VALUES (:tenant, :venture, :principal, :reflection) RETURNING id`,
          {
            tenant: p.uuid(ctx.tenantId),
            venture: p.uuid(ventureId),
            principal: p.uuid(ctx.principalId),
            reflection: p.json(reflection),
          },
        );
        const id = inserted.rows[0]?.id;
        const item = (await studentRepo.listLearningLog(scope.tx, ventureId)).find((r) => r.id === id);
        if (!item)
          throw new DomainError('internal', 'The reflection could not be saved.', {
            reason: 'reflection_missing',
          });
        await audit(scope, {
          action: 'student.reflection_recorded',
          outcome: 'succeeded',
          ventureId,
          objectType: 'learning_reflection',
          objectId: item.id,
        });
        return item;
      }),
    removeReflection: (ctx, ventureId, id) =>
      kit.inRequest(ctx, async (scope) => {
        requireId(ventureId, 'Venture');
        requireId(id, 'Reflection');
        await requireVentureAccess(scope, ventureId, 'write');
        const result = await scope.tx.query(
          `DELETE FROM learning_log WHERE id = :id AND venture_id = :venture AND tenant_id = app.current_tenant() AND principal_id = app.current_principal() RETURNING id`,
          { id: p.uuid(id), venture: p.uuid(ventureId) },
        );
        if (!result.rows.length) throw fail.notFound('Reflection', 'reflection_not_owned');
        await audit(scope, {
          action: 'student.reflection_deleted',
          outcome: 'succeeded',
          ventureId,
          objectType: 'learning_reflection',
          objectId: id,
        });
      }),
  };
}
