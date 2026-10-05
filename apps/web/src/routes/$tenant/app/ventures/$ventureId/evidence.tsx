import { createFileRoute } from '@tanstack/react-router';

import { EvidencePage } from '@/features/venture/evidence-page';

export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/evidence')({
  head: () => ({ meta: [{ title: 'Evidence' }] }),
  component: EvidencePage,
});
