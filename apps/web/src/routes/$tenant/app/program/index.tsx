import { createFileRoute, redirect } from '@tanstack/react-router';

/** Console landing → its first area. */
export const Route = createFileRoute('/$tenant/app/program/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/program/portfolio', params, replace: true });
  },
});
