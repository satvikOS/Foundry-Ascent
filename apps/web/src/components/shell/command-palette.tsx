import type { Me } from '@foundry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Download,
  EyeOff,
  FileText,
  HandHelping,
  History,
  Keyboard,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  Phone,
  Plus,
  SquarePen,
  Sun,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { VentureMark } from '@/components/faces/user-avatar';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { toast } from '@/components/ui/toast';
import { useCallsAvailable } from '@/features/calls/calls-available';
import { exportLearning } from '@/features/student/learning';
import { errorMessage } from '@/lib/api/errors';
import { useRecentConversations } from '@/lib/api/hooks/sessions';
import { ventureQueryOptions, useVentures } from '@/lib/api/hooks/ventures';
import { canAccessVenture, canWrite, writesAnyVenture } from '@/lib/auth/roles';
import { conversationTitle, lastActivity } from '@/lib/conversations';
import { formatHotkey } from '@/lib/hooks/use-hotkeys';
import { STAGE_LABELS } from '@/lib/labels';
import { useTheme } from '@/lib/theme';
import { veirDisplay } from '@/lib/veir';

import { useSignOutAndRedirect } from './account-menu';
import { staffSections, staffWorkspaces, ventureDestinations, type Workspace } from './nav';

/** What the palette lists: everything, or only conversations (the side panel's "View all"). */
export type PaletteScope = 'all' | 'conversations';

interface CommandPaletteProps {
  me: Me;
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenShortcuts: () => void;
  onToggleSidebar: () => void;
  scope?: PaletteScope;
  onScopeChange?: (scope: PaletteScope) => void;
}

function Hotkey({ binding }: { binding: string }) {
  return (
    <CommandShortcut>
      <KbdGroup>
        {formatHotkey(binding).flatMap((chord, i) =>
          chord.map((key, j) => <Kbd key={`${i}-${j}`}>{key}</Kbd>),
        )}
      </KbdGroup>
    </CommandShortcut>
  );
}

/** How many recent conversations show before anything is typed. */
const RECENT_LIMIT = 6;

/**
 * ⌘K: every action with its shortcut. Search conversations and jump anywhere (this venture's pages, other
 * ventures, staff workspaces); start a chat or a call; add a memory, ask a person, open the latest summary or
 * export your learning; toggle the side panel, change the theme and sign out. Opened from the panel's
 * "View all", it lists only conversations (Backspace in the empty field widens it again).
 */
export function CommandPalette({
  me,
  workspace,
  open,
  onOpenChange,
  onOpenShortcuts,
  onToggleSidebar,
  scope = 'all',
  onScopeChange,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const tenant = me.tenant.slug;
  const [search, setSearch] = useState('');
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  const { data: ventures = [] } = useVentures();
  const recents = useRecentConversations({ enabled: open && writesAnyVenture(me) });
  const ventureDetail = useQuery({
    ...ventureQueryOptions(ventureId ?? ''),
    enabled: ventureId !== null && canAccessVenture(me, ventureId),
  });
  const veir = veirDisplay(ventureDetail.data);
  const { setTheme } = useTheme();
  const { signOut } = useSignOutAndRedirect();
  const searching = search.trim().length > 0;
  const onlyConversations = scope === 'conversations';
  const searchLabel = onlyConversations ? 'Search conversations' : 'Search conversations, pages and actions';

  const conversations = useMemo(() => {
    const sorted = [...recents.items].sort((a, b) => lastActivity(b) - lastActivity(a));
    return searching || onlyConversations ? sorted : sorted.slice(0, RECENT_LIMIT);
  }, [recents.items, searching, onlyConversations]);
  // The latest ended, standard conversation of this venture: the one with a summary to open.
  const latestSummary = useMemo(
    () =>
      ventureId === null
        ? null
        : ([...recents.items]
            .filter((s) => s.ventureId === ventureId && s.status === 'ended' && s.privacy === 'standard')
            .sort((a, b) => lastActivity(b) - lastActivity(a))[0] ?? null),
    [recents.items, ventureId],
  );
  const otherVentures = ventures.filter((v) => v.id !== ventureId);
  const writable = ventureId !== null && canWrite(me, ventureId);
  const callable = useCallsAvailable(ventureId, writable);

  const close = () => {
    onOpenChange(false);
    setSearch('');
  };
  const run = (action: () => void) => {
    close();
    action();
  };

  return (
    <CommandDialog
      // cmdk names its field from this label (its own aria-labelledby wins over an aria-label).
      commandProps={{ label: searchLabel }}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setSearch('');
      }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={onlyConversations ? 'Search conversations…' : 'Search conversations, pages and actions…'}
        onKeyDown={(event) => {
          if (onlyConversations && event.key === 'Backspace' && search === '') onScopeChange?.('all');
        }}
        leading={
          onlyConversations ? (
            <button
              type="button"
              onClick={() => onScopeChange?.('all')}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-xs bg-secondary pr-1 pl-2 text-caption text-secondary-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              Conversations
              <X aria-hidden className="size-3" />
              <span className="sr-only">: show everything</span>
            </button>
          ) : null
        }
      />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {ventureId && !onlyConversations ? (
          <CommandGroup heading="This venture">
            {writable ? (
              <CommandItem
                value="new chat start conversation"
                onSelect={() => {
                  run(
                    () => void navigate({ to: '/$tenant/app/v/$ventureId', params: { tenant, ventureId } }),
                  );
                }}
              >
                <SquarePen aria-hidden />
                New chat
                <Hotkey binding="g n" />
              </CommandItem>
            ) : null}
            {callable && veir ? (
              <CommandItem
                value={`start a call ${veir.name} voice talk`}
                onSelect={() => {
                  run(
                    () =>
                      void navigate({
                        to: '/$tenant/app/v/$ventureId',
                        params: { tenant, ventureId },
                        search: { call: 1 },
                      }),
                  );
                }}
              >
                <Phone aria-hidden />
                Start a call
                <Hotkey binding="g v" />
              </CommandItem>
            ) : null}
            {ventureDestinations(me, ventureId).map((destination) => (
              <CommandItem
                key={destination.id}
                value={`go ${destination.label}${destination.id === 'venture' ? ' settings profile goal stage team' : ''}`}
                onSelect={() => {
                  run(() => void navigate({ to: destination.to, params: { tenant, ventureId } }));
                }}
              >
                <destination.icon aria-hidden />
                {destination.label}
                <Hotkey binding={destination.shortcut} />
              </CommandItem>
            ))}
            {writable ? (
              <>
                <CommandItem
                  value="add a memory remember note"
                  onSelect={() => {
                    run(
                      () =>
                        void navigate({
                          to: '/$tenant/app/v/$ventureId/knowledge',
                          params: { tenant, ventureId },
                          search: { add: true },
                        }),
                    );
                  }}
                >
                  <Plus aria-hidden />
                  Add a memory
                </CommandItem>
                <CommandItem
                  value="ask a person human help eir escalate"
                  onSelect={() => {
                    run(
                      () =>
                        void navigate({
                          to: '/$tenant/app/v/$ventureId/help',
                          params: { tenant, ventureId },
                          search: { ask: true },
                        }),
                    );
                  }}
                >
                  <HandHelping aria-hidden />
                  Ask a person
                </CommandItem>
                {latestSummary ? (
                  <CommandItem
                    value="open the latest session summary digest recap"
                    onSelect={() => {
                      run(
                        () =>
                          void navigate({
                            to: '/$tenant/app/v/$ventureId/c/$sessionId',
                            params: { tenant, ventureId, sessionId: latestSummary.id },
                            search: { view: 'digest' },
                          }),
                      );
                    }}
                  >
                    <History aria-hidden />
                    Open the latest session summary
                  </CommandItem>
                ) : null}
                <CommandItem
                  value="export learning download coaching profile learning log you"
                  onSelect={() => {
                    run(() => {
                      exportLearning(client, ventureId).catch((error: unknown) => {
                        toast.error('Couldn’t export your learning', { description: errorMessage(error) });
                      });
                    });
                  }}
                >
                  <Download aria-hidden />
                  Export learning
                </CommandItem>
              </>
            ) : null}
          </CommandGroup>
        ) : null}

        {conversations.length > 0 ? (
          <>
            {onlyConversations ? null : <CommandSeparator />}
            <CommandGroup heading={onlyConversations || searching ? 'Conversations' : 'Recent conversations'}>
              {conversations.map((session) => {
                const title = conversationTitle(session);
                return (
                  <CommandItem
                    key={session.id}
                    value={`conversation ${title} ${session.id}`}
                    onSelect={() => {
                      run(
                        () =>
                          void navigate({
                            to: '/$tenant/app/v/$ventureId/c/$sessionId',
                            params: { tenant, ventureId: session.ventureId, sessionId: session.id },
                          }),
                      );
                    }}
                  >
                    {session.hasCalls ? (
                      <Phone aria-hidden />
                    ) : session.privacy === 'ephemeral' ? (
                      <EyeOff aria-hidden />
                    ) : (
                      <MessageSquare aria-hidden />
                    )}
                    <span className="truncate">{title}</span>
                  </CommandItem>
                );
              })}
              {onlyConversations && recents.hasNextPage ? (
                <CommandItem
                  value="load older conversations more"
                  disabled={recents.isFetchingNextPage}
                  onSelect={() => void recents.fetchNextPage()}
                >
                  <FileText aria-hidden />
                  {recents.isFetchingNextPage ? 'Loading…' : 'Load older conversations'}
                </CommandItem>
              ) : null}
            </CommandGroup>
          </>
        ) : null}

        {onlyConversations ? null : (
          <>
            {otherVentures.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading={ventureId ? 'Other ventures' : 'Ventures'}>
                  {otherVentures.map((venture) => (
                    <CommandItem
                      key={venture.id}
                      value={`venture ${venture.name} ${venture.oneLiner}`}
                      onSelect={() => {
                        run(
                          () =>
                            void navigate({
                              to: '/$tenant/app/v/$ventureId',
                              params: { tenant, ventureId: venture.id },
                            }),
                        );
                      }}
                    >
                      <VentureMark name={venture.name} size="xs" />
                      <span className="truncate">{venture.name}</span>
                      <span className="ml-auto text-caption text-muted-foreground">
                        {STAGE_LABELS[venture.stage]}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}

            {staffWorkspaces(me).map((item) => (
              <CommandGroup key={item.id} heading={item.label}>
                {staffSections(me, item.id).map((section) => (
                  <CommandItem
                    key={`${item.id}-${section.id}`}
                    value={`${item.label} ${section.label}`}
                    onSelect={() => {
                      run(() => void navigate({ to: section.to, params: { tenant } }));
                    }}
                  >
                    <section.icon aria-hidden />
                    {section.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}

            <CommandSeparator />
            <CommandGroup heading="Preferences">
              <CommandItem
                value="switch theme system"
                onSelect={() => {
                  run(() => {
                    setTheme('system');
                  });
                }}
              >
                <Monitor aria-hidden />
                Use system theme
              </CommandItem>
              <CommandItem
                value="switch theme light"
                onSelect={() => {
                  run(() => {
                    setTheme('light');
                  });
                }}
              >
                <Sun aria-hidden />
                Use light theme
              </CommandItem>
              <CommandItem
                value="switch theme dark"
                onSelect={() => {
                  run(() => {
                    setTheme('dark');
                  });
                }}
              >
                <Moon aria-hidden />
                Use dark theme
              </CommandItem>
              <CommandItem
                value="toggle sidebar side panel collapse expand"
                onSelect={() => {
                  run(onToggleSidebar);
                }}
              >
                <PanelLeft aria-hidden />
                Toggle sidebar
                <Hotkey binding="[" />
              </CommandItem>
              <CommandItem
                value="keyboard shortcuts help"
                onSelect={() => {
                  run(onOpenShortcuts);
                }}
              >
                <Keyboard aria-hidden />
                Keyboard shortcuts
                <Hotkey binding="?" />
              </CommandItem>
              <CommandItem
                value="sign out log out"
                onSelect={() => {
                  run(signOut);
                }}
              >
                <LogOut aria-hidden />
                Sign out
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
