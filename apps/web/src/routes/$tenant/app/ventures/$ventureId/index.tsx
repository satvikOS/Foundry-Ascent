import { createFileRoute, redirect } from '@tanstack/react-router';

/** `/ventures/<id>` from before the conversation-first layout → that venture's new chat. */
export const Route = createFileRoute('/$tenant/app/ventures/$ventureId/')({
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects are thrown
    throw redirect({ to: '/$tenant/app/v/$ventureId', params, replace: true });
  },
});
