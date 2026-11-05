import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import type { CallKind } from './call-kind';

export interface CallTarget {
  readonly tenant: string;
  readonly ventureId: string;
  /** The conversation to call in; null for a call that starts a new conversation (New chat). */
  readonly sessionId: string | null;
}

/** A link that opens the call screen for a kind of call, in a conversation or (sessionId null) from New chat. */
export function CallLink({
  tenant,
  ventureId,
  sessionId,
  kind,
  children,
  onClick,
  ...props
}: CallTarget & {
  kind: CallKind;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  'aria-label'?: string;
}) {
  return sessionId ? (
    <Link
      to="/$tenant/app/v/$ventureId/c/$sessionId"
      params={{ tenant, ventureId, sessionId }}
      search={{ call: kind }}
      onClick={onClick}
      {...props}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/$tenant/app/v/$ventureId"
      params={{ tenant, ventureId }}
      search={{ call: kind }}
      onClick={onClick}
      {...props}
    >
      {children}
    </Link>
  );
}
