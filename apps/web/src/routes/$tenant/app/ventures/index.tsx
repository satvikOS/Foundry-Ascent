import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The old ventures list. Ventures are now switched from the sidebar, so this opens the app's default
 * place (the post-deploy smoke test also deep-links here to check the SPA fallback).
 */
export const Route = createFileRoute('/$tenant/app/ventures/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app', params, replace: true });
  },
});
