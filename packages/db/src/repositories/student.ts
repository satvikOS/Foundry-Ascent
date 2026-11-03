import { LearningReflection, StudentProfile } from '@foundry/contracts';
import { col } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { firstPart, queryRows, readPart } from './common.js';

/** Identifiers derive from the RLS request, never from a browser's claimed student identity. */
export function studentProfilePart(ventureId: string) {
  return firstPart(
    `SELECT profile, version, approved_at FROM student_profiles WHERE tenant_id = app.current_tenant()
     AND principal_id = app.current_principal() AND venture_id = :venture`,
    { venture: p.uuid(ventureId) },
    (r) =>
      StudentProfile.parse({
        ...(col.json().decode(r.profile, 'profile') as Record<string, unknown>),
        version: col.int.decode(r.version, 'version'),
        approvedAt: col.ts.decode(r.approved_at, 'approved_at'),
      }),
  );
}
export const getStudentProfile = (ex: SqlExecutor, ventureId: string) =>
  readPart(ex, studentProfilePart(ventureId));
export async function listLearningLog(ex: SqlExecutor, ventureId: string) {
  return queryRows(
    ex,
    `SELECT id, reflection, created_at FROM learning_log WHERE tenant_id = app.current_tenant()
    AND principal_id = app.current_principal() AND venture_id = :venture ORDER BY created_at DESC, id LIMIT 100`,
    { venture: p.uuid(ventureId) },
    (r) =>
      LearningReflection.parse({
        ...(col.json().decode(r.reflection, 'reflection') as Record<string, unknown>),
        id: r.id,
        createdAt: col.ts.decode(r.created_at, 'created_at'),
      }),
  );
}
