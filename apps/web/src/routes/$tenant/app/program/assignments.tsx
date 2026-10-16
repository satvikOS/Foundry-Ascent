import { createFileRoute } from '@tanstack/react-router';

import { AssignmentsPage } from '@/features/program/assignments/assignments-page';
import { personasQueryOptions } from '@/lib/api/hooks/eir';
import { programVenturesQueryOptions } from '@/lib/api/hooks/program';

export const Route = createFileRoute('/$tenant/app/program/assignments')({
  loader: ({ context }) => {
    context.queryClient.query(programVenturesQueryOptions()).catch(() => undefined);
    context.queryClient.query(personasQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'vEIRs & assignments' }] }),
  component: AssignmentsRoute,
});

function AssignmentsRoute() {
  const { tenant } = Route.useParams();
  return <AssignmentsPage tenant={tenant} />;
}
