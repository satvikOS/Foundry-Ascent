import { createFileRoute, redirect } from '@tanstack/react-router';

import { legacyVentureTarget } from '@/lib/legacy-routes';

/**
 * Every `/ventures/<id>/<section>` link from before the conversation-first layout lands on the section's
 * new home with the same ids (see `legacyVentureTarget`).
 */
export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/$')({
  beforeLoad: ({ params, location }) => {
    const { tenant, ventureId } = params;
    const target = legacyVentureTarget(params._splat ?? '', location.search);
    /* eslint-disable @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown */
    switch (target.page) {
      case 'chat':
        throw redirect({ to: '/$tenant/app/v/$ventureId', params: { tenant, ventureId }, replace: true });
      case 'conversation':
        throw redirect({
          to: '/$tenant/app/v/$ventureId/c/$sessionId',
          params: { tenant, ventureId, sessionId: target.sessionId },
          search: target.search,
          replace: true,
        });
      case 'knowledge':
        throw redirect({
          to: '/$tenant/app/v/$ventureId/knowledge',
          params: { tenant, ventureId },
          search: target.search,
          replace: true,
        });
      case 'documents':
        throw redirect({
          to: '/$tenant/app/v/$ventureId/documents',
          params: { tenant, ventureId },
          replace: true,
        });
      case 'help':
        throw redirect({
          to: '/$tenant/app/v/$ventureId/help',
          params: { tenant, ventureId },
          search: target.search,
          replace: true,
        });
      case 'team':
        throw redirect({
          to: '/$tenant/app/v/$ventureId/team',
          params: { tenant, ventureId },
          replace: true,
        });
    }
    /* eslint-enable @typescript-eslint/only-throw-error */
  },
});
