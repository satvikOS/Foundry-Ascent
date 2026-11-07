import { createFileRoute } from '@tanstack/react-router';

import { RecordingsPage } from '@/features/recordings/recordings-page';

/** The venture's recordings, a page at a time (the page asks for them: none of it is part of the first page load). */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/recordings')({
  head: () => ({ meta: [{ title: 'Recordings' }] }),
  component: RecordingsPage,
});
