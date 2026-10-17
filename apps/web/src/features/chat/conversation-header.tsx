import type { PersonaSummary, SessionView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  EyeOff,
  Flag,
  Menu,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Square,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirBadge } from '@/components/faces/veir-badge';
import { InspectorToggle, useInspector } from '@/components/shell/inspector';
import { usePageMobileBar } from '@/components/shell/shell-chrome';
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
  onAction: (action: ConversationMenuAction) => void;
  /** Under the title (ended conversations: the disclosure line, so it stays in view). */
  children?: ReactNode;
}

/**
 * The conversation's one header, on the shared glass surface: the vEIR's face, name and "vEIR · AI" chip,
 * the title, a quiet "Private" for a private conversation, then the context panel and a menu for everything
 * rarer (rename, end, report, delete). Calls start from the composer's voice button. On phones it is the
 * only bar: the menu button, the title over "{vEIR} · AI", New chat and the menu (which also opens the panel).
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
  onAction,
  children,
}: ConversationHeaderProps) {
  const openNavigation = usePageMobileBar();
  const inspector = useInspector();
  const active = session.status === 'active';
  // A private conversation (a one-off: nothing from it is remembered) says so while it lasts.
  const isPrivate = session.privacy === 'ephemeral';
  const phoneSubtitle = [`${session.personaName} · AI`, isPrivate ? 'Private' : null, active ? null : 'Ended']
    .filter(Boolean)
    .join(' · ');
  return (
    <header className="glass sticky top-(--mini-call-height) z-20 border-b" data-print="hide">
      <div className="mx-auto flex h-14 w-full max-w-(--content-width) items-center gap-2.5 px-4 sm:px-6">
        {openNavigation ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-1.5 shrink-0 md:hidden"
            aria-label="Open navigation"
            onClick={openNavigation}
          >
            <Menu aria-hidden />
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <PersonaAvatar
            name={personaName}
            portraitUrl={portraitUrl}
            size="sm"
            decorative
            className="hidden sm:inline-flex"
          />
          <span className="hidden shrink-0 text-small font-medium sm:inline">{personaName}</span>
          <VeirBadge kind={personaKind} className="hidden sm:inline-flex" />
          <span aria-hidden className="hidden text-border-strong sm:inline">
            /
          </span>
          <div className="min-w-0 flex-1 sm:contents">
            <h1
              data-page-title
              tabIndex={-1}
              className="truncate text-small font-medium outline-none sm:min-w-0 sm:font-normal sm:text-muted-foreground"
              title={title}
            >
              {title}
            </h1>
            <p className="truncate text-caption text-muted-foreground sm:hidden">{phoneSubtitle}</p>
          </div>
          {isPrivate ? (
            // The title already reads "Private chat · …": an icon (named for screen readers) says it once.
            <span
              data-testid="private-indicator"
              title="Private: nothing from this conversation is remembered"
              className="hidden shrink-0 items-center text-muted-foreground sm:inline-flex"
            >
              <EyeOff aria-hidden className="size-3.5" />
              <span className="sr-only">Private</span>
            </span>
          ) : null}
          {active ? null : (
            <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">Ended</span>
          )}
        </div>
        <div className="-mr-1.5 flex shrink-0 items-center gap-0.5 sm:mr-0">
          {openNavigation && canEdit ? (
            <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
              <Link to="/$tenant/app/v/$ventureId" params={{ tenant, ventureId }} aria-label="New chat">
                <SquarePen aria-hidden />
              </Link>
            </Button>
          ) : null}
          <InspectorToggle className="hidden md:inline-flex" />
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
                {inspector.hasContent ? (
                  <DropdownMenuItem
                    className="md:hidden"
                    onSelect={() => {
                      inspector.setOpen(true);
                    }}
                  >
                    <PanelRight aria-hidden />
                    Sources and notes
                  </DropdownMenuItem>
                ) : null}
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
