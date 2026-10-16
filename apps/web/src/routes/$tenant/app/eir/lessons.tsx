import { createFileRoute } from '@tanstack/react-router';

import { LessonsQueuePage } from '@/features/eir/lessons/lessons-queue-page';
import { personasQueryOptions } from '@/lib/api/hooks/eir';

export const Route = createFileRoute('/$tenant/app/eir/lessons')({
  loader: ({ context }) => {
    context.queryClient.query(personasQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Lessons to review' }] }),
  component: LessonsRoute,
});

function LessonsRoute() {
  const { tenant } = Route.useParams();
  return <LessonsQueuePage tenant={tenant} />;
}
