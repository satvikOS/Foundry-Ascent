import { Link } from '@tanstack/react-router';
import { Phone } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CallLinkProps {
  tenant: string;
  ventureId: string;
  /** The conversation to call in; without it the call starts a new conversation. */
  sessionId?: string;
  /** The vEIR's short name ("Corin"). */
  name: string;
  className?: string;
}

/** "Call Corin": opens the call screen (`?call=1`), here or in a new conversation. */
export function CallLink({ tenant, ventureId, sessionId, name, className }: CallLinkProps) {
  const classes = cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'rounded-full px-3.5', className);
  const content = (
    <>
      <Phone aria-hidden />
      Call {name}
    </>
  );
  return sessionId ? (
    <Link
      to="/$tenant/app/v/$ventureId/c/$sessionId"
      params={{ tenant, ventureId, sessionId }}
      search={{ call: 1 }}
      className={classes}
    >
      {content}
    </Link>
  ) : (
    <Link
      to="/$tenant/app/v/$ventureId"
      params={{ tenant, ventureId }}
      search={{ call: 1 }}
      className={classes}
    >
      {content}
    </Link>
  );
}
