import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { NewPersonaPage } from '@/features/eir/personas/new-persona-page';
import { ForbiddenError } from '@/lib/auth/guards';
import { canUseProgramConsole } from '@/lib/auth/roles';

/** `?eir=<profile id>`: the EIR the vEIR is built from, chosen already (from the EIR list). */
interface NewPersonaSearch {
  eir?: string | undefined;
}

/** New vEIR: program leads only (the API refuses anyone else). */
export const Route = createFileRoute('/$tenant/app/eir/personas/new')({
  validateSearch: (search: Record<string, unknown>): NewPersonaSearch => {
    const eir = z.uuid().safeParse(search.eir);
    return { eir: eir.success ? eir.data : undefined };
  },
  beforeLoad: ({ context }) => {
    if (!canUseProgramConsole(context.me)) throw new ForbiddenError('creating vEIRs');
  },
  head: () => ({ meta: [{ title: 'New vEIR' }] }),
  component: NewPersonaRoute,
});

function NewPersonaRoute() {
  const { tenant } = Route.useParams();
  const { eir } = Route.useSearch();
  return <NewPersonaPage tenant={tenant} initialEirId={eir} />;
}
