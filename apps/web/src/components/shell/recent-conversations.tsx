import type { SessionView } from '@foundry/contracts';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { EyeOff, FileText, MoreHorizontal, Pencil, Phone, Trash2 } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentConversations } from '@/lib/api/hooks/sessions';
import { conversationTitle, groupByRecency } from '@/lib/conversations';
import { cn } from '@/lib/utils';

// Loaded on first use, so the shell's first paint doesn't carry them.
const RenameConversationDialog = lazy(() =>
  import('@/features/chat/conversation-dialogs').then((m) => ({ default: m.RenameConversationDialog })),
);
const DeleteConversationDialog = lazy(() =>
  import('@/features/chat/conversation-dialogs').then((m) => ({ default: m.DeleteConversationDialog })),
);

interface RecentConversationsProps {
  tenant: string;
  /** Venture names by id, so a conversation from another venture says where it belongs. */
  ventureNames: ReadonlyMap<string, string>;
  onNavigate?: (() => void) | undefined;
}

type RowDialog = { kind: 'rename' | 'delete'; session: SessionView; title: string } | null;

/**
 * The person's conversations across their ventures, newest first, grouped Today / Previous 7 days / Older.
 * Calls are marked with a phone, temporary chats with a closed eye. Each row has a menu: rename, open the
 * summary (ended conversations) and delete.
 */
export function RecentConversations({ tenant, ventureNames, onNavigate }: RecentConversationsProps) {
  const recents = useRecentConversations({ enabled: true });
  const groups = useMemo(() => groupByRecency(recents.items), [recents.items]);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [dialog, setDialog] = useState<RowDialog>(null);

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
    <>
      <nav aria-label="Recent conversations" className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {groups.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`recents-${group.id}`}>
            <h2
              id={`recents-${group.id}`}
              className="px-2.5 pt-4 pb-1 text-caption font-medium text-sidebar-muted"
            >
              {group.label}
            </h2>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
              {group.items.map((session) => {
                const title = conversationTitle(session);
                const venture = ventureNames.get(session.ventureId);
                return (
                  <li key={session.id} className="group/row relative">
                    <Link
                      to="/$tenant/app/v/$ventureId/c/$sessionId"
                      params={{ tenant, ventureId: session.ventureId, sessionId: session.id }}
                      onClick={onNavigate}
                      title={venture ? `${title} · ${venture}` : title}
                      className={cn(
                        'flex h-8 min-w-0 items-center gap-2 rounded-md pr-8 pl-2.5 text-small text-sidebar-foreground transition-colors',
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
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Options for ${title}`}
                        className={cn(
                          'absolute top-1 right-1 flex size-6 items-center justify-center rounded-sm text-sidebar-muted transition-opacity',
                          'hover:bg-sidebar-border hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-sidebar-ring',
                          'opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100',
                        )}
                      >
                        <MoreHorizontal aria-hidden className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="right" className="w-48">
                        {session.privacy === 'standard' ? (
                          <DropdownMenuItem
                            onSelect={() => {
                              setDialog({ kind: 'rename', session, title });
                            }}
                          >
                            <Pencil aria-hidden />
                            Rename
                          </DropdownMenuItem>
                        ) : null}
                        {session.status === 'ended' && session.privacy === 'standard' ? (
                          <DropdownMenuItem
                            onSelect={() => {
                              onNavigate?.();
                              void navigate({
                                to: '/$tenant/app/v/$ventureId/c/$sessionId',
                                params: { tenant, ventureId: session.ventureId, sessionId: session.id },
                                search: { view: 'digest' },
                              });
                            }}
                          >
                            <FileText aria-hidden />
                            Open summary
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          destructive
                          onSelect={() => {
                            setDialog({ kind: 'delete', session, title });
                          }}
                        >
                          <Trash2 aria-hidden />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {recents.hasNextPage ? (
          <button
            type="button"
            onClick={() => void recents.fetchNextPage()}
            disabled={recents.isFetchingNextPage}
            className="mx-2.5 mt-2 h-8 rounded-md text-left text-caption text-sidebar-muted hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring"
          >
            {recents.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </nav>
      {dialog ? (
        <Suspense fallback={null}>
          <RenameConversationDialog
            session={dialog.session}
            currentTitle={dialog.title}
            open={dialog.kind === 'rename'}
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
          />
          <DeleteConversationDialog
            session={dialog.session}
            open={dialog.kind === 'delete'}
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
            onDeleted={() => {
              if (pathname.endsWith(`/c/${dialog.session.id}`)) {
                void navigate({
                  to: '/$tenant/app/v/$ventureId',
                  params: { tenant, ventureId: dialog.session.ventureId },
                  replace: true,
                });
              }
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
