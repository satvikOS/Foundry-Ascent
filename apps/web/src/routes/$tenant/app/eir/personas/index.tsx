import { createFileRoute } from '@tanstack/react-router';

import { PersonasListPage } from '@/features/eir/personas/personas-list-page';
import { personasQueryOptions } from '@/lib/api/hooks/eir';
import { canUseProgramConsole } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';

export const Route = createFileRoute('/$tenant/app/eir/personas/')({
  loader: ({ context }) => {
    context.queryClient.query(personasQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Personas' }] }),
  component: PersonasRoute,
});

function PersonasRoute() {
  const { tenant } = Route.useParams();
  // Program leads create vEIRs (the API refuses anyone else).
  const canCreate = canUseProgramConsole(useRequiredMe());
  return <PersonasListPage tenant={tenant} canCreate={canCreate} />;
}
