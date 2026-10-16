import type { Me } from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import {
  EyeOff,
  Keyboard,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Phone,
  Settings2,
  SquarePen,
  Sun,
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
import { useRecentConversations } from '@/lib/api/hooks/sessions';
import { useVentures } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { conversationTitle, lastActivity } from '@/lib/conversations';
import { formatHotkey } from '@/lib/hooks/use-hotkeys';
import { STAGE_LABELS } from '@/lib/labels';
import { useTheme } from '@/lib/theme';

import { useSignOutAndRedirect } from './account-menu';
import { STAFF_SECTIONS, staffWorkspaces, VENTURE_DESTINATIONS, type Workspace } from './nav';

interface CommandPaletteProps {
  me: Me;
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenShortcuts: () => void;
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
 * ⌘K: search conversations and jump anywhere — this venture's pages, other ventures, staff
 * workspaces — or change the theme and sign out. Starting a conversation always goes through New chat.
 */
export function CommandPalette({ me, workspace, open, onOpenChange, onOpenShortcuts }: CommandPaletteProps) {
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const [search, setSearch] = useState('');
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  const { data: ventures = [] } = useVentures();
  const recents = useRecentConversations(open ? ventureId : null);
  const { setTheme } = useTheme();
  const { signOut } = useSignOutAndRedirect();
  const searching = search.trim().length > 0;

  const conversations = useMemo(() => {
    const sorted = [...(recents.data ?? [])].sort((a, b) => lastActivity(b) - lastActivity(a));
    return searching ? sorted : sorted.slice(0, RECENT_LIMIT);
  }, [recents.data, searching]);
  const otherVentures = ventures.filter((v) => v.id !== ventureId);
  const writable = ventureId !== null && canWrite(me, ventureId);

  const run = (action: () => void) => {
    onOpenChange(false);
    setSearch('');
    action();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setSearch('');
      }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search conversations, pages and ventures…"
        aria-label="Search conversations, pages and ventures"
      />
      <CommandList>
        <CommandEmpty>Nothing matches. Try a conversation title or a page name.</CommandEmpty>

        {ventureId ? (
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
            {VENTURE_DESTINATIONS.map((destination) => (
              <CommandItem
                key={destination.id}
                value={`go ${destination.label}`}
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
              <CommandItem
                value="venture settings name stage goal"
                onSelect={() => {
                  run(
                    () =>
                      void navigate({
                        to: '/$tenant/app/v/$ventureId/settings',
                        params: { tenant, ventureId },
                      }),
                  );
                }}
              >
                <Settings2 aria-hidden />
                Venture settings
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {ventureId && conversations.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={searching ? 'Conversations' : 'Recent conversations'}>
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
                            params: { tenant, ventureId, sessionId: session.id },
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
            </CommandGroup>
          </>
        ) : null}

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
            {STAFF_SECTIONS[item.id].map((section) => (
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
            value="theme system"
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
            value="theme light"
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
            value="theme dark"
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
      </CommandList>
    </CommandDialog>
  );
}
