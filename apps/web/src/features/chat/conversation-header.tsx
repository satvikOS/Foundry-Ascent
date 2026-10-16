import type { PersonaSummary, SessionView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { EyeOff, Flag, MoreHorizontal, Pencil, Phone, Square, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirBadge } from '@/components/faces/veir-badge';
import { InspectorToggle } from '@/components/shell/inspector';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';

export type ConversationMenuAction = 'rename' | 'end' | 'report' | 'delete';

interface ConversationHeaderProps {
  tenant: string;
  ventureId: string;
  session: SessionView;
  title: string;
  personaName: string;
  personaKind: PersonaSummary['kind'];
  portraitUrl?: string | null | undefined;
  /** The person may change this conversation (founders and team). */
  canEdit: boolean;
  /** A call can start from here (the vEIR is available and the conversation is open). */
  canCall: boolean;
  onAction: (action: ConversationMenuAction) => void;
  /** Under the title (ended conversations: the disclosure line, so it stays in view). */
  children?: ReactNode;
}

/**
 * The conversation's one header: the vEIR's face, name and "vEIR · AI" chip, the title, then Call, the
 * context panel and a menu for everything rarer (rename, end, report, delete).
 */
export function ConversationHeader({
  tenant,
  ventureId,
  session,
  title,
  personaName,
  personaKind,
  portraitUrl,
  canEdit,
  canCall,
  onAction,
  children,
}: ConversationHeaderProps) {
  const active = session.status === 'active';
  return (
    <header
      className="sticky top-(--header-height) z-20 border-b border-border bg-background md:top-0"
      data-print="hide"
    >
      <div className="mx-auto flex h-14 w-full max-w-(--content-width) items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <PersonaAvatar name={personaName} portraitUrl={portraitUrl} size="sm" decorative />
          <span className="hidden shrink-0 text-small font-medium sm:inline">{personaName}</span>
          <VeirBadge kind={personaKind} />
          <span aria-hidden className="hidden text-border-strong sm:inline">
            /
          </span>
          <h1
            data-page-title
            tabIndex={-1}
            className="min-w-0 truncate text-small text-muted-foreground outline-none"
            title={title}
          >
            {title}
          </h1>
          {session.privacy === 'ephemeral' ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
              <EyeOff aria-hidden className="size-3.5" />
              Temporary
            </span>
          ) : null}
          {active ? null : (
            <span className="shrink-0 rounded-full border border-border px-2 py-px text-caption text-muted-foreground">
              Ended
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {canCall ? (
            <SimpleTooltip content={`Call ${personaName}`}>
              <Button asChild variant="ghost" size="icon-sm">
                <Link
                  to="/$tenant/app/v/$ventureId/c/$sessionId"
                  params={{ tenant, ventureId, sessionId: session.id }}
                  search={{ call: 1 }}
                  aria-label={`Call ${personaName}`}
                >
                  <Phone aria-hidden />
                </Link>
              </Button>
            </SimpleTooltip>
          ) : null}
          <InspectorToggle />
          {canEdit ? (
            <DropdownMenu>
              <SimpleTooltip content="More">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Conversation options">
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="end" className="w-56">
                {session.privacy === 'standard' ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      onAction('rename');
                    }}
                  >
                    <Pencil aria-hidden />
                    Rename
                  </DropdownMenuItem>
                ) : null}
                {active ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      onAction('end');
                    }}
                  >
                    <Square aria-hidden />
                    End and summarise
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onSelect={() => {
                    onAction('report');
                  }}
                >
                  <Flag aria-hidden />
                  Report a problem
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onSelect={() => {
                    onAction('delete');
                  }}
                >
                  <Trash2 aria-hidden />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {children ? (
        <div className="mx-auto w-full max-w-(--content-width) px-4 pb-2.5 sm:px-6">{children}</div>
      ) : null}
    </header>
  );
}
