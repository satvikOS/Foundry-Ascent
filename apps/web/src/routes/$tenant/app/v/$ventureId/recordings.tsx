import { createFileRoute } from '@tanstack/react-router';

import { RecordingsPage } from '@/features/recordings/recordings-page';
import { recordingsQueryOptions } from '@/lib/api/hooks/recordings';

export const Route = createFileRoute('/$tenant/app/v/$ventureId/recordings')({
  loader: ({ context, params }) => {
    context.queryClient.query(recordingsQueryOptions({ ventureId: params.ventureId })).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Recordings' }] }),
  component: RecordingsPage,
});
