import { createFileRoute } from '@tanstack/react-router';

import { PersonasListPage } from '@/features/eir/personas/personas-list-page';
import { personasQueryOptions } from '@/lib/api/hooks/eir';

export const Route = createFileRoute('/$tenant/app/eir/personas/')({
  loader: ({ context }) => {
    context.queryClient.query(personasQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Personas' }] }),
  component: PersonasRoute,
});

function PersonasRoute() {
  const { tenant } = Route.useParams();
  return <PersonasListPage tenant={tenant} />;
}
