import { createFileRoute } from '@tanstack/react-router';

import { NewPersonaPage } from '@/features/eir/personas/new-persona-page';
import { ForbiddenError } from '@/lib/auth/guards';
import { canUseProgramConsole } from '@/lib/auth/roles';

/** New vEIR: program leads only (the API refuses anyone else). */
export const Route = createFileRoute('/$tenant/app/eir/personas/new')({
  beforeLoad: ({ context }) => {
    if (!canUseProgramConsole(context.me)) throw new ForbiddenError('creating vEIRs');
  },
  head: () => ({ meta: [{ title: 'New vEIR' }] }),
  component: NewPersonaRoute,
});

function NewPersonaRoute() {
  const { tenant } = Route.useParams();
  return <NewPersonaPage tenant={tenant} />;
}
