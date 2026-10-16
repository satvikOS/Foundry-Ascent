import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';

import { PersonaDetailPage } from '@/features/eir/personas/persona-detail-page';
import { isPersonaTab, type PersonaTab } from '@/features/eir/personas/persona-tabs';
import { personaQueryOptions } from '@/lib/api/hooks/eir';
import { canUseProgramConsole } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';

interface PersonaSearch {
  /** Section of the persona page (Overview when absent). */
  tab?: Exclude<PersonaTab, 'overview'> | undefined;
  /** Lesson open in the Lessons section. */
  lesson?: string | undefined;
}

export const Route = createFileRoute('/$tenant/app/eir/personas/$personaId')({
  validateSearch: (search: Record<string, unknown>): PersonaSearch => ({
    tab: isPersonaTab(search.tab) && search.tab !== 'overview' ? search.tab : undefined,
    lesson:
      typeof search.lesson === 'string' && /^[0-9a-f-]{36}$/i.test(search.lesson) ? search.lesson : undefined,
  }),
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const me = useRequiredMe();
  const onTabChange = useCallback(
    (tab: PersonaTab) => {
      void navigate({ search: { tab: tab === 'overview' ? undefined : tab }, replace: true });
    },
    [navigate],
  );
  const onLessonChange = useCallback(
    (lesson: string | undefined) => {
      void navigate({ search: (prev) => ({ ...prev, lesson }), replace: true });
    },
    [navigate],
  );
  return (
    <PersonaDetailPage
      key={personaId}
      personaId={personaId}
      tenant={tenant}
      tab={search.tab ?? 'overview'}
      onTabChange={onTabChange}
      lessonId={search.lesson}
      onLessonChange={onLessonChange}
      canSeeAssignments={canUseProgramConsole(me)}
    />
  );
}
