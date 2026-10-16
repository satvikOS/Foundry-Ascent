import type { SessionView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { MessagesSquare, Phone } from 'lucide-react';
import { useMemo, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useSessions } from '@/lib/api/hooks/sessions';
import { conversationTitle, lastActivity } from '@/lib/conversations';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { formatIsoDate } from '@/features/memory/typed/attributes';
import { sentenceStart, useVeirName } from '@/features/venture/veir-name';

import { useDeleteDigest } from './digest-api';

type Digested = SessionView & { digest: NonNullable<SessionView['digest']> };

/** Conversations with a digest, the most recent first. */
export function digestedConversations(sessions: readonly SessionView[]): Digested[] {
  return sessions
    .filter((session): session is Digested => session.digest !== null)
    .sort((a, b) => lastActivity(b) - lastActivity(a));
}

interface DigestsSectionProps {
  ventureId: string;
  tenant: string;
  canEdit: boolean;
}

/**
 * What the vEIR took from each conversation: the digest's summary, topics and commitments, linking back
 * to the conversation. Digests are AI notes, labelled as such; one can be deleted and the conversation
 * stays.
 */
export function DigestsSection({ ventureId, tenant, canEdit }: DigestsSectionProps) {
  const sessions = useSessions(ventureId);
  const author = useVeirName(ventureId);
  const remove = useDeleteDigest(ventureId);
  const [confirm, setConfirm] = useState<Digested | null>(null);
  const rows = useMemo(() => digestedConversations(sessions.data ?? []), [sessions.data]);

  if (sessions.isPending) return <HairlineSkeleton rows={3} label="Loading conversations…" />;
  if (sessions.isError) {
    return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} headingLevel={2} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquare}
        headingLevel={2}
        title="No digests yet"
        description={`When a conversation ends or goes quiet, ${author} writes a short digest of it here. Temporary chats never get one.`}
      />
    );
  }

  const deleteDigest = (session: Digested) => {
    setConfirm(null);
    remove.mutate(session.id, {
      onSuccess: () => {
        toast.success('Digest deleted');
        announce('Digest deleted');
      },
      onError: (error) => {
        toast.error('Couldn’t delete the digest', { description: errorMessage(error) });
      },
    });
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5">
        <p className="label-mono">AI notes</p>
        <p className="max-w-[60ch] text-small text-muted-foreground">
          What {author} took from each conversation. Your team can see and delete them. They’re never treated
          as facts.
        </p>
      </div>
      <ul aria-label="Conversation digests" className="divide-y divide-border border-b border-border">
        {rows.map((session) => {
          const title = conversationTitle(session);
          const { digest } = session;
          const headingId = `digest-${session.id}`;
          return (
            <li key={session.id} aria-labelledby={headingId} className="grid gap-3 py-5 first:pt-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 id={headingId} className="min-w-0 text-[15px] font-medium">
                  <Link
                    to="/$tenant/app/v/$ventureId/c/$sessionId"
                    params={{ tenant, ventureId, sessionId: session.id }}
                    className="underline decoration-transparent underline-offset-[3px] hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {title}
                  </Link>
                </h3>
                <p className="flex items-center gap-1.5 text-caption text-subtle-foreground">
                  {session.hasCalls ? (
                    <>
                      <Phone aria-hidden className="size-3" />
                      <span>Call</span>
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  <time dateTime={isoString(digest.generatedAt)} title={formatDateTime(digest.generatedAt)}>
                    {formatRelative(digest.generatedAt)}
                  </time>
                </p>
              </div>
              <p className="prose-reading text-pretty">{digest.summary}</p>
              {digest.topics.length > 0 ? (
                <ul aria-label="Topics" className="flex flex-wrap gap-1.5">
                  {digest.topics.map((topic) => (
                    <li
                      key={topic}
                      className="rounded-full border border-border px-2.5 py-0.5 text-caption text-muted-foreground"
                    >
                      {topic}
                    </li>
                  ))}
                </ul>
              ) : null}
              {digest.commitments.length > 0 ? (
                <div className="grid gap-1">
                  <p className="label-mono">Commitments</p>
                  <ul className="grid gap-1 text-small">
                    {digest.commitments.map((commitment, index) => (
                      <li key={`${index}-${commitment.text}`} className="flex flex-wrap gap-x-2">
                        <span>{commitment.text}</span>
                        {commitment.due ? (
                          <span className="text-subtle-foreground">Due {formatIsoDate(commitment.due)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {canEdit ? (
                <div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="-ml-2 text-muted-foreground"
                    aria-describedby={headingId}
                    disabled={remove.isPending && remove.variables === session.id}
                    onClick={() => {
                      setConfirm(session);
                    }}
                  >
                    Delete digest
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this digest?</AlertDialogTitle>
            <AlertDialogDescription>
              {sentenceStart(author)} stops drawing on it in later conversations, and it won’t be written
              again. The conversation stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm) deleteDigest(confirm);
              }}
            >
              Delete digest
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
