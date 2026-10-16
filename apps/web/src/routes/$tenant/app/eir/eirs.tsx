import { createFileRoute } from '@tanstack/react-router';

import { EirsPage } from '@/features/eir/eirs/eirs-page';
import { personasQueryOptions } from '@/lib/api/hooks/eir';
import { ForbiddenError } from '@/lib/auth/guards';
import { canManageEirs, canUseProgramConsole } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';

/** EIRs: program leads and platform admins (the API refuses anyone else). */
export const Route = createFileRoute('/$tenant/app/eir/eirs')({
  beforeLoad: ({ context }) => {
    if (!canManageEirs(context.me)) throw new ForbiddenError('the EIR list');
  },
  loader: ({ context }) => {
    context.queryClient.query(personasQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'EIRs' }] }),
  component: EirsRoute,
});

function EirsRoute() {
  const { tenant } = Route.useParams();
  // Program leads build vEIRs (the API refuses anyone else).
  const canCreateVeir = canUseProgramConsole(useRequiredMe());
  return <EirsPage tenant={tenant} canCreateVeir={canCreateVeir} />;
}
