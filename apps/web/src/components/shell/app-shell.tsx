import type { Me } from '@foundry/contracts';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Building, Menu, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { canUseAdminConsole, canUseEirStudio, canUseProgramConsole } from '@/lib/auth/roles';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn, isMac } from '@/lib/utils';

import { AppShellContext, type AppShellContextValue } from './app-shell-context';
import { CommandPalette } from './command-palette';
import { ShortcutsDialog } from './shortcuts-dialog';
import { Sidebar, SidebarContent } from './sidebar';
import { AiDisabledBanner, DbWakingBanner, OfflineBanner } from './status-banners';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

interface AppShellProps {
  me: Me;
  children: ReactNode;
}

/**
 * Authenticated application frame: left rail (collapsible to icons; drawer on mobile), sticky top bar
 * (tenant, ⌘K search, theme, account), global status banners and the <main> landmark.
 */
export function AppShell({ me, children }: AppShellProps) {
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(STORAGE_KEYS.sidebarCollapsed) === '1');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Close the mobile drawer after navigation.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const toggleSidebar = useCallback(() => {
    setCollapsed((current) => {
      safeStorage.set(STORAGE_KEYS.sidebarCollapsed, current ? '0' : '1');
      return !current;
    });
  }, []);

  useHotkeys({
    'mod+k': () => {
      setPaletteOpen((open) => !open);
    },
    '?': () => {
      setShortcutsOpen(true);
    },
    '[': toggleSidebar,
    'g h': () => void navigate({ to: '/$tenant/app', params: { tenant } }),
    'g v': () => void navigate({ to: '/$tenant/app/ventures', params: { tenant } }),
    'g e': () => {
      if (canUseEirStudio(me)) void navigate({ to: '/$tenant/app/eir', params: { tenant } });
    },
    'g p': () => {
      if (canUseProgramConsole(me)) void navigate({ to: '/$tenant/app/program', params: { tenant } });
    },
    'g a': () => {
      if (canUseAdminConsole(me)) void navigate({ to: '/admin' });
    },
  });

  const shell = useMemo<AppShellContextValue>(
    () => ({
      openCommandPalette: () => {
        setPaletteOpen(true);
      },
      openShortcuts: () => {
        setShortcutsOpen(true);
      },
      toggleSidebar,
      sidebarCollapsed: collapsed,
    }),
    [collapsed, toggleSidebar],
  );

  return (
    <AppShellContext.Provider value={shell}>
      <div className="min-h-dvh bg-background">
        <Sidebar me={me} collapsed={collapsed} onToggle={toggleSidebar} />

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Primary navigation</SheetDescription>
            <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
              <SidebarContent
                me={me}
                onNavigate={() => {
                  setMobileNavOpen(false);
                }}
              />
            </nav>
          </SheetContent>
        </Sheet>

        <div
          className={cn(
            'flex min-h-dvh min-w-0 flex-col transition-[padding] duration-200 ease-out motion-reduce:transition-none',
            collapsed ? 'md:pl-(--sidebar-width-collapsed)' : 'md:pl-(--sidebar-width)',
          )}
        >
          <header
            className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:px-4"
            data-print="hide"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label="Open navigation"
              aria-expanded={mobileNavOpen}
              onClick={() => {
                setMobileNavOpen(true);
              }}
            >
              <Menu aria-hidden />
            </Button>

            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Building aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{me.tenant.name}</span>
              {me.tenant.kind === 'partner' ? (
                <Badge variant="outline" className="hidden sm:inline-flex">
                  Partner
                </Badge>
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                className="hidden w-64 justify-start gap-2 text-muted-foreground md:inline-flex lg:w-72"
                onClick={() => {
                  setPaletteOpen(true);
                }}
                aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
              >
                <Search aria-hidden />
                <span className="flex-1 text-left font-normal">Search or jump to…</span>
                <KbdGroup aria-hidden>
                  <Kbd>{isMac() ? '⌘' : 'Ctrl'}</Kbd>
                  <Kbd>K</Kbd>
                </KbdGroup>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label="Search or jump to"
                onClick={() => {
                  setPaletteOpen(true);
                }}
              >
                <Search aria-hidden />
              </Button>
              <ThemeToggle />
              <UserMenu
                me={me}
                onOpenShortcuts={() => {
                  setShortcutsOpen(true);
                }}
              />
            </div>
          </header>

          <div data-print="hide">
            <DbWakingBanner />
            <OfflineBanner />
            <AiDisabledBanner />
          </div>

          <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
            {children}
          </main>
        </div>

        <CommandPalette
          me={me}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenShortcuts={() => {
            setShortcutsOpen(true);
          }}
        />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </AppShellContext.Provider>
  );
}
