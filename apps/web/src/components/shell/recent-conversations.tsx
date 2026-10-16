import { Link } from '@tanstack/react-router';
import { EyeOff, Phone } from 'lucide-react';
import { useMemo } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useRecentConversations } from '@/lib/api/hooks/sessions';
import { conversationTitle, groupByRecency } from '@/lib/conversations';
import { cn } from '@/lib/utils';

interface RecentConversationsProps {
  tenant: string;
  ventureId: string;
  onNavigate?: (() => void) | undefined;
}

/**
 * The sidebar's conversations, newest first, grouped Today / Previous 7 days / Older. Calls are marked
 * with a phone, temporary chats with a closed eye.
 */
export function RecentConversations({ tenant, ventureId, onNavigate }: RecentConversationsProps) {
  const recents = useRecentConversations(ventureId);
  const groups = useMemo(() => groupByRecency(recents.data ?? []), [recents.data]);

  if (recents.isPending) {
    return (
      <div aria-busy="true" className="grid gap-2 px-2.5 pt-4">
        <span className="sr-only" role="status">
          Loading conversations…
        </span>
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (recents.isError) {
    return (
      <p className="px-2.5 pt-4 text-caption text-sidebar-muted">
        Conversations couldn’t load.{' '}
        <button
          type="button"
          className="font-medium text-sidebar-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-sidebar-ring"
          onClick={() => void recents.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  if (groups.length === 0) {
    return <p className="px-2.5 pt-4 text-caption text-sidebar-muted">No conversations yet.</p>;
  }

  return (
    <nav aria-label="Recent conversations" className="grid gap-1">
      {groups.map((group) => (
        <div key={group.id} role="group" aria-labelledby={`recents-${group.id}`}>
          <h2
            id={`recents-${group.id}`}
            className="px-2.5 pt-4 pb-1 text-caption font-medium text-sidebar-muted"
          >
            {group.label}
          </h2>
          <ul className="grid gap-px">
            {group.items.map((session) => {
              const title = conversationTitle(session);
              return (
                <li key={session.id}>
                  <Link
                    to="/$tenant/app/v/$ventureId/c/$sessionId"
                    params={{ tenant, ventureId, sessionId: session.id }}
                    onClick={onNavigate}
                    title={title}
                    className={cn(
                      'flex h-8 min-w-0 items-center gap-2 rounded-md px-2.5 text-small text-sidebar-foreground transition-colors',
                      'hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
                      'data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {session.hasCalls ? (
                      <>
                        <Phone aria-hidden className="size-3.5 shrink-0 text-sidebar-muted" />
                        <span className="sr-only">, includes a call</span>
                      </>
                    ) : null}
                    {session.privacy === 'ephemeral' ? (
                      <>
                        <EyeOff aria-hidden className="size-3.5 shrink-0 text-sidebar-muted" />
                        <span className="sr-only">, temporary chat</span>
                      </>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
