import { createFileRoute, redirect } from '@tanstack/react-router';

/** Console landing → its first area. */
export const Route = createFileRoute('/$tenant/app/eir/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/eir/personas', params, replace: true });
  },
});
