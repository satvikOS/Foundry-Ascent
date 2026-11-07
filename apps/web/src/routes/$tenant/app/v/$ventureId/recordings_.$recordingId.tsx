import { createFileRoute } from '@tanstack/react-router';

import { RecordingViewerPage } from '@/features/recordings/recording-viewer-page';

/** One recording, watched in its own page with its transcript beside it (from Recordings, a conversation, Watch). */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/recordings_/$recordingId')({
  head: () => ({ meta: [{ title: 'Recording' }] }),
  component: RecordingViewerPage,
});
