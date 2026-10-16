import { createFileRoute, redirect } from '@tanstack/react-router';

/** Workspace landing → its first area. */
export const Route = createFileRoute('/$tenant/app/admin/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/admin/principals', params, replace: true });
  },
});
