import { Link } from '@tanstack/react-router';
import { MessageSquarePlus } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** An empty Knowledge section's one action: notes and digests come from conversations, so start one. */
export function StartChat({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  return (
    <Button asChild size="sm" variant="secondary">
      <Link to="/$tenant/app/v/$ventureId" params={{ tenant, ventureId }}>
        <MessageSquarePlus aria-hidden />
        Start chat
      </Link>
    </Button>
  );
}
