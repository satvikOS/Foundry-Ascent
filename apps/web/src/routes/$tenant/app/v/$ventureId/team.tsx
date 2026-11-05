import { createFileRoute, redirect } from '@tanstack/react-router';

import { TEAM_ANCHOR } from '@/features/venture/anchors';

/** Team is a section of the Venture page now: links and bookmarks land on it there. */
export const Route = createFileRoute('/$tenant/app/v/$ventureId/team')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/v/$ventureId/settings', params, hash: TEAM_ANCHOR, replace: true });
  },
});
