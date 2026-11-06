import type { SessionView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  EyeOff,
  Flag,
  Menu,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Square,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { VeirName } from '@/components/faces/veir-name';
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
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { type VeirName as VeirNameView } from '@/lib/veir';

export type ConversationMenuAction = 'rename' | 'end' | 'report' | 'delete';

interface ConversationHeaderProps {
  tenant: string;
  ventureId: string;
  session: SessionView;
  title: string;
  /** Who the conversation is with: the mentor's name ("Thomas"); null while unknown. */
  veir: VeirNameView | null;
  /** The person may change this conversation (founders and team). */
  canEdit: boolean;
  onAction: (action: ConversationMenuAction) => void;
  /** Under the title. */
  children?: ReactNode;
  /** The call buttons (voice, video), before the panel toggle and the menu; null when calls are off. */
  calls?: ReactNode;
}

/**
 * The conversation's one header, the top edge of its window (conversation-window.tsx), spanning the window: the
 * mentor's name ("Thomas", no face and no badge),
 * the title, a quiet "Private" for a private conversation, then the call buttons (voice, video), the context panel's
 * toggle and a menu for everything rarer (rename, end, report, delete). On phones it is the only bar: the menu
 * button, the title over the name, then at most three icons (Voice call, Video call, More), so the title keeps its
 * room; New chat and the context panel are the first items of More there.
 */
export function ConversationHeader({
  tenant,
  ventureId,
  session,
  title,
  veir,
  canEdit,
  onAction,
  children,
  calls = null,
}: ConversationHeaderProps) {
  const openNavigation = usePageMobileBar();
  // The panel beside the content has its own close: the header toggles it only while it is not there.
  const inspector = useInspector();
  const panelBeside = inspector.open && inspector.isDesktop;
  // Phones (the header is the only bar): New chat and the panel live in More, beside the two call buttons.
  const phone = !useMediaQuery(BREAKPOINTS.md, true) && openNavigation !== null && canEdit;
  const active = session.status === 'active';
  // A private conversation (a one-off: nothing from it is remembered) says so while it lasts.
  const isPrivate = session.privacy === 'ephemeral';
  const phoneStatus = [isPrivate ? 'Private' : null, active ? null : 'Ended'].filter(Boolean).join(' · ');
  const name = veir?.name ?? session.personaName;
  return (
    <header
      data-slot="conversation-header"
      className="glass-bar sticky top-(--mini-call-height) z-20 border-b"
      data-print="hide"
    >
      <div className="flex h-14 w-full items-center gap-2.5 px-4 sm:px-5">
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
          {veir ? (
            <VeirName veir={veir} className="hidden shrink-0 text-small font-medium sm:inline-flex" />
          ) : null}
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
            <p className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground sm:hidden">
              {veir ? <VeirName veir={veir} /> : <span className="truncate">{name}</span>}
              {phoneStatus ? <span className="truncate">· {phoneStatus}</span> : null}
            </p>
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
        <div data-slot="header-actions" className="-mr-1.5 flex shrink-0 items-center gap-0.5 sm:mr-0">
          {calls}
          {panelBeside || phone ? null : <InspectorToggle />}
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
                {phone ? (
                  <>
                    <DropdownMenuItem asChild>
                      <Link to="/$tenant/app/v/$ventureId" params={{ tenant, ventureId }}>
                        <SquarePen aria-hidden />
                        New chat
                      </Link>
                    </DropdownMenuItem>
                    {inspector.label ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          inspector.setOpen(true);
                        }}
                      >
                        <PanelRightOpen aria-hidden />
                        Show {inspector.label}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                  </>
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
      {children ? <div className="w-full px-4 pb-2.5 sm:px-5">{children}</div> : null}
    </header>
  );
}
