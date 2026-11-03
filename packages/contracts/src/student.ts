import { z } from 'zod';
import { Id, Timestamp } from './domain.js';

/** Student-approved context, separate from venture claims and conversation summaries. Venture-scoped. */
export const StudentProfileData = z.object({
  background: z.string().trim().max(240).default(''),
  learningGoal: z.string().trim().max(400).default(''),
  constraints: z.string().trim().max(400).default(''),
  depth: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
  masteredConcepts: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
});
export type StudentProfileData = z.infer<typeof StudentProfileData>;
export const StudentProfile = StudentProfileData.extend({
  version: z.number().int().positive(),
  approvedAt: Timestamp,
});
export type StudentProfile = z.infer<typeof StudentProfile>;
export const StudentProfileResponse = z.object({ profile: StudentProfile.nullable() });
export const SaveStudentProfile = z.object({
  expectedVersion: z.number().int().nonnegative(),
  profile: StudentProfileData,
});
export const LearningReflectionInput = z.object({
  decision: z.string().trim().min(3).max(400),
  evidence: z.string().trim().min(3).max(1000),
  changedThinking: z.string().trim().min(3).max(1000),
  nextTest: z.string().trim().max(400).default(''),
  sessionId: Id.nullable().default(null),
});
export type LearningReflectionInput = z.infer<typeof LearningReflectionInput>;
export const LearningReflection = LearningReflectionInput.extend({ id: Id, createdAt: Timestamp });
export type LearningReflection = z.infer<typeof LearningReflection>;
export const LearningLogResponse = z.object({ items: z.array(LearningReflection) });
