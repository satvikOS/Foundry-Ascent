import { createFileRoute } from '@tanstack/react-router';

import { AssignmentsPage } from '@/features/program/assignments/assignments-page';
import { personasQueryOptions } from '@/lib/api/hooks/eir';

export const Route = createFileRoute('/$tenant/app/program/assignments')({
  loader: ({ context }) => {
    // Loaded apart: loaders are in the first page load, the page's contracts are not needed there.
    void import('@/lib/api/hooks/program')
      .then(({ programVenturesQueryOptions }) => context.queryClient.query(programVenturesQueryOptions()))
      .catch(() => undefined);
    context.queryClient.query(personasQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'vEIRs & assignments' }] }),
  component: AssignmentsRoute,
});

function AssignmentsRoute() {
  const { tenant } = Route.useParams();
  return <AssignmentsPage tenant={tenant} />;
}
