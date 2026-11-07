import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { RecordingsPage } from '@/features/recordings/recordings-page';
import { recordingsQueryOptions } from '@/lib/api/hooks/recordings';

/** `?r=<recording id>`: the recording to play (the call screen's Watch, a conversation's recording). */
export interface RecordingsSearch {
  r?: string | undefined;
}

export const Route = createFileRoute('/$tenant/app/v/$ventureId/recordings')({
  validateSearch: (search: Record<string, unknown>): RecordingsSearch => {
    const r = z.uuid().safeParse(search.r);
    return { r: r.success ? r.data : undefined };
  },
  loader: ({ context, params }) => {
    context.queryClient.query(recordingsQueryOptions({ ventureId: params.ventureId })).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Recordings' }] }),
  component: RecordingsPage,
});
