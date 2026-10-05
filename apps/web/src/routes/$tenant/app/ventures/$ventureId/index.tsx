import { createFileRoute, redirect } from '@tanstack/react-router';

/** /ventures/$ventureId → the overview section. */
export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/ventures/$ventureId/overview', params, replace: true });
  },
});
