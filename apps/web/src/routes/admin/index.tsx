import { createFileRoute, redirect } from '@tanstack/react-router';

/** Console landing → its first area. */
export const Route = createFileRoute('/admin/')({
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/admin/principals', replace: true });
  },
});
