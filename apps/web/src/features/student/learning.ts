import {
  LearningLogResponse,
  StudentProfileResponse,
  type LearningReflection,
  type StudentProfile,
} from '@foundry/contracts';
import { queryOptions, type QueryClient } from '@tanstack/react-query';

import { api, path } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/query-keys';

export const studentProfileQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.studentProfile(ventureId),
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/student-profile`, StudentProfileResponse, { signal }),
  });

export const learningLogQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.learningLog(ventureId),
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/learning-log`, LearningLogResponse, { signal }),
  });

/** Saves the student's coaching profile and learning log as one JSON file (nothing leaves the browser). */
export function downloadLearning(profile: StudentProfile | null, items: readonly LearningReflection[]) {
  const blob = new Blob(
    [JSON.stringify({ profile, learningLog: items, exportedAt: new Date().toISOString() }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'foundry-learning.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** "Export learning" from anywhere (the command palette): reads both, then downloads. */
export async function exportLearning(client: QueryClient, ventureId: string): Promise<void> {
  const [profile, log] = await Promise.all([
    client.query(studentProfileQueryOptions(ventureId)),
    client.query(learningLogQueryOptions(ventureId)),
  ]);
  downloadLearning(profile.profile ?? null, log.items);
}
