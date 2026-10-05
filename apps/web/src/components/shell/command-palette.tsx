import type { Me, VentureSummary } from '@foundry/contracts';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Keyboard, LogOut, Monitor, Moon, Play, Rocket, Sun } from 'lucide-react';
import { useMemo, useState } from 'react';

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
import { StageChip } from '@/components/ui/stage-chip';
import { toast } from '@/components/ui/toast';
import { useStartSession } from '@/lib/api/hooks/sessions';
import { useVentures } from '@/lib/api/hooks/ventures';
import { errorMessage } from '@/lib/api/errors';
import { canWrite } from '@/lib/auth/roles';
import { formatHotkey } from '@/lib/hooks/use-hotkeys';
import { useTheme } from '@/lib/theme';

import {
  ADMIN_SECTIONS,
  EIR_SECTIONS,
  PROGRAM_SECTIONS,
  VENTURE_SECTION_ROUTES,
  VENTURE_SECTIONS,
  primaryNav,
} from './nav';
import { useSignOutAndRedirect } from './user-menu';

interface CommandPaletteProps {
  me: Me;
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

/**
 * ⌘K palette: jump to any page, venture or venture section; start a coaching session; switch theme;
 * sign out. Venture sections appear once you type, to keep the default list short.
 */
export function CommandPalette({ me, open, onOpenChange, onOpenShortcuts }: CommandPaletteProps) {
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const [search, setSearch] = useState('');
  const { data: ventures = [] } = useVentures();
  const params = useParams({ strict: false });
  const currentVentureId =
    'ventureId' in params && typeof params.ventureId === 'string' ? params.ventureId : null;
  const startSession = useStartSession();
  const { setTheme } = useTheme();
  const { signOut } = useSignOutAndRedirect();
  const { items, consoles } = primaryNav(me);
  const consoleIds = new Set(consoles.map((c) => c.id));

  const orderedVentures = useMemo(() => {
    if (!currentVentureId) return ventures;
    return [...ventures].sort(
      (a, b) => Number(b.id === currentVentureId) - Number(a.id === currentVentureId),
    );
  }, [ventures, currentVentureId]);
  const writable = orderedVentures.filter((v) => canWrite(me, v.id));

  const run = (action: () => void) => {
    onOpenChange(false);
    setSearch('');
    action();
  };

  const start = (venture: VentureSummary) => {
    run(() => {
      const id = toast.loading(`Starting a session for ${venture.name}…`);
      startSession.mutate(
        { ventureId: venture.id, input: { mode: 'diagnose' } },
        {
          onSuccess: (session) => {
            toast.success('Session started', { id });
            void navigate({
              to: '/$tenant/app/ventures/$ventureId/coach/$sessionId',
              params: { tenant, ventureId: venture.id, sessionId: session.id },
            });
          },
          onError: (error) =>
            toast.error('Couldn’t start a session', { id, description: errorMessage(error) }),
        },
      );
    });
  };

  const searching = search.trim().length > 0;

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
        placeholder="Search ventures, pages and actions…"
        aria-label="Search ventures, pages and actions"
      />
      <CommandList>
        <CommandEmpty>No results. Try a venture name or “memory”.</CommandEmpty>

        <CommandGroup heading="Go to">
          {items.map((item) => (
            <CommandItem
              key={item.id}
              value={`go ${item.label}`}
              onSelect={() => {
                run(() => void navigate(item.link));
              }}
            >
              <item.icon aria-hidden />
              {item.label}
              <Hotkey binding={item.shortcut} />
            </CommandItem>
          ))}
          {consoleIds.has('eir')
            ? EIR_SECTIONS.map((section) => (
                <CommandItem
                  key={`eir-${section.id}`}
                  value={`EIR studio ${section.label}`}
                  onSelect={() => {
                    run(() => void navigate({ to: section.to, params: { tenant } }));
                  }}
                >
                  <section.icon aria-hidden />
                  EIR studio · {section.label}
                </CommandItem>
              ))
            : null}
          {consoleIds.has('program')
            ? PROGRAM_SECTIONS.map((section) => (
                <CommandItem
                  key={`program-${section.id}`}
                  value={`Program ${section.label}`}
                  onSelect={() => {
                    run(() => void navigate({ to: section.to, params: { tenant } }));
                  }}
                >
                  <section.icon aria-hidden />
                  Program · {section.label}
                </CommandItem>
              ))
            : null}
          {consoleIds.has('admin')
            ? ADMIN_SECTIONS.map((section) => (
                <CommandItem
                  key={`admin-${section.id}`}
                  value={`Admin ${section.label}`}
                  onSelect={() => {
                    run(() => void navigate({ to: section.to }));
                  }}
                >
                  <section.icon aria-hidden />
                  Admin · {section.label}
                </CommandItem>
              ))
            : null}
        </CommandGroup>

        {orderedVentures.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Ventures">
              {orderedVentures.map((venture) => (
                <CommandItem
                  key={venture.id}
                  value={`venture ${venture.name} ${venture.oneLiner}`}
                  onSelect={() => {
                    run(
                      () =>
                        void navigate({
                          to: '/$tenant/app/ventures/$ventureId/overview',
                          params: { tenant, ventureId: venture.id },
                        }),
                    );
                  }}
                >
                  <Rocket aria-hidden />
                  <span className="truncate">{venture.name}</span>
                  {venture.id === currentVentureId ? (
                    <span className="text-xs text-muted-foreground">Current</span>
                  ) : null}
                  <span className="ml-auto">
                    <StageChip stage={venture.stage} showMeter={false} />
                  </span>
                </CommandItem>
              ))}
              {searching
                ? orderedVentures.flatMap((venture) =>
                    VENTURE_SECTIONS.filter((s) => s.id !== 'overview').map((section) => (
                      <CommandItem
                        key={`${venture.id}-${section.id}`}
                        value={`${venture.name} ${section.label}`}
                        onSelect={() => {
                          run(
                            () =>
                              void navigate({
                                to: VENTURE_SECTION_ROUTES[section.id],
                                params: { tenant, ventureId: venture.id },
                              }),
                          );
                        }}
                      >
                        <section.icon aria-hidden />
                        <span className="truncate">
                          {venture.name} <span className="text-muted-foreground">›</span> {section.label}
                        </span>
                      </CommandItem>
                    )),
                  )
                : null}
            </CommandGroup>
          </>
        ) : null}

        {writable.length > 0 && me.aiEnabled ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              {writable.map((venture) => (
                <CommandItem
                  key={`start-${venture.id}`}
                  value={`start session coach ${venture.name}`}
                  onSelect={() => {
                    start(venture);
                  }}
                >
                  <Play aria-hidden />
                  <span className="truncate">Start a session · {venture.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Preferences">
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
