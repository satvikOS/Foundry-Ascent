import { createFileRoute } from '@tanstack/react-router';

import { PersonaDetailPage } from '@/features/eir/personas/persona-detail-page';
import { personaQueryOptions } from '@/lib/api/hooks/eir';

export const Route = createFileRoute('/$tenant/app/eir/personas/$personaId')({
  loader: async ({ context, params }) => {
    try {
      const persona = await context.queryClient.query(personaQueryOptions(params.personaId));
      return { personaName: persona.name };
    } catch {
      // The page renders the error state (with retry and request ID) itself.
      return { personaName: null };
    }
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.personaName ?? 'Persona' }] }),
  component: PersonaRoute,
});

function PersonaRoute() {
  const { tenant, personaId } = Route.useParams();
  return <PersonaDetailPage key={personaId} personaId={personaId} tenant={tenant} />;
}
