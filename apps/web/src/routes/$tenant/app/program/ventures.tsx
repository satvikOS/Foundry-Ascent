import { createFileRoute } from '@tanstack/react-router';

import { ProgramVenturesPage } from '@/features/program/program-ventures';
import { programVenturesQueryOptions } from '@/lib/api/hooks/program';

export const Route = createFileRoute('/$tenant/app/program/ventures')({
  loader: ({ context }) => {
    context.queryClient.query(programVenturesQueryOptions()).catch(() => undefined);
  },
  head: () => ({ meta: [{ title: 'Program ventures' }] }),
  component: ProgramVenturesPage,
});
