import type { Me } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Menu, PanelLeftClose, PanelLeftOpen, SquarePen, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';

import { DataUseDialog, ReportProblemDialog } from './account-dialogs';
import { CommandPalette } from './command-palette';
import {
  STAFF_WORKSPACES,
  staffWorkspace,
  staffWorkspaces,
  VENTURE_DESTINATIONS,
  workspaceFromPath,
  type Workspace,
} from './nav';
import { ShellChromeContext, type ShellChrome } from './shell-chrome';
import { ShortcutsDialog } from './shortcuts-dialog';
import { SidebarContent } from './sidebar';
import {
  AccessCodeNoticeBanner,
  AiDisabledBanner,
  DbUnavailableBanner,
  DbWakingBanner,
  OfflineBanner,
} from './status-banners';

interface AppShellProps {
  me: Me;
  children: ReactNode;
}

type ShellDialog = 'palette' | 'shortcuts' | 'data-use' | 'report' | null;

/**
 * The one authenticated frame for every role: a left sidebar (collapsible to a rail on desktop, a sheet
 * on phones) with the workspace switcher, conversations or workspace sections and the account menu;
 * status banners only while something needs attention; and the <main> landmark. There is no top bar on
 * desktop; phones get a slim bar with the menu, the current place and New chat, unless the page's own
 * header takes its place (a conversation).
 */
export function AppShell({ me, children }: AppShellProps) {
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const workspace = workspaceFromPath(pathname);
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(STORAGE_KEYS.sidebarCollapsed) === '1');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dialog, setDialog] = useState<ShellDialog>(null);
  // Pages with their own phone header (a conversation) claim the bar; the shell's bar shows otherwise.
  const [mobileBarClaims, setMobileBarClaims] = useState(0);
  const chrome = useMemo<ShellChrome>(
    () => ({
      openNavigation: () => {
        setMobileNavOpen(true);
      },
      claimMobileBar: () => {
        setMobileBarClaims((count) => count + 1);
        return () => {
          setMobileBarClaims((count) => count - 1);
        };
      },
    }),
    [],
  );

  // Close the mobile sheet after navigation; remember the venture so the app reopens there.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (ventureId) safeStorage.set(STORAGE_KEYS.lastVenture, ventureId);
  }, [ventureId]);

  const toggleSidebar = useCallback(() => {
    setCollapsed((current) => {
      safeStorage.set(STORAGE_KEYS.sidebarCollapsed, current ? '0' : '1');
      return !current;
    });
  }, []);
  const openDialog = useCallback((next: ShellDialog) => {
    setMobileNavOpen(false);
    setDialog(next);
  }, []);
  const dialogProps = (id: Exclude<ShellDialog, null>) => ({
    open: dialog === id,
    onOpenChange: (open: boolean) => {
      setDialog(open ? id : null);
    },
  });

  // The page and workspace shortcuts come from nav.ts, which the shortcuts list reads too.
  useHotkeys({
    'mod+k': () => {
      setDialog((current) => (current === 'palette' ? null : 'palette'));
    },
    '?': () => {
      setDialog('shortcuts');
    },
    '[': toggleSidebar,
    'g n': () => {
      if (ventureId) void navigate({ to: '/$tenant/app/v/$ventureId', params: { tenant, ventureId } });
    },
    ...Object.fromEntries(
      VENTURE_DESTINATIONS.map((destination) => [
        destination.shortcut,
        () => {
          if (ventureId) void navigate({ to: destination.to, params: { tenant, ventureId } });
        },
      ]),
    ),
    ...Object.fromEntries(
      STAFF_WORKSPACES.map((workspace) => [
        workspace.shortcut,
        () => {
          if (staffWorkspaces(me).some((w) => w.id === workspace.id))
            void navigate({ to: workspace.to, params: { tenant } });
        },
      ]),
    ),
  });

  const sidebarActions = {
    onOpenSearch: () => {
      openDialog('palette');
    },
    onOpenShortcuts: () => {
      openDialog('shortcuts');
    },
    onOpenDataUse: () => {
      openDialog('data-use');
    },
    onOpenReportProblem: () => {
      openDialog('report');
    },
  };

  const collapseButton = (
    <SimpleTooltip content={collapsed ? 'Expand sidebar  [' : 'Collapse sidebar  ['} side="right">
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-sidebar-muted hover:text-sidebar-foreground"
        onClick={toggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
      </Button>
    </SimpleTooltip>
  );

  return (
    <div className="min-h-dvh bg-background">
      <aside
        aria-label="Sidebar"
        data-collapsed={collapsed}
        data-print="hide"
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex',
          'transition-[width] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'w-(--sidebar-width-collapsed)' : 'w-(--sidebar-width)',
        )}
      >
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <SidebarContent
            me={me}
            workspace={workspace}
            collapsed={collapsed}
            headerAction={collapseButton}
            {...sidebarActions}
          />
        </nav>
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          hideClose
          className="w-[min(100vw-3rem,20rem)] bg-sidebar p-0 text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Conversations, pages and your account</SheetDescription>
          <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
            <SidebarContent
              me={me}
              workspace={workspace}
              onNavigate={() => {
                setMobileNavOpen(false);
              }}
              headerAction={
                <SheetClose asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Close navigation" className="shrink-0">
                    <X aria-hidden />
                  </Button>
                </SheetClose>
              }
              {...sidebarActions}
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
        {mobileBarClaims > 0 ? null : (
          <MobileBar
            me={me}
            workspace={workspace}
            navOpen={mobileNavOpen}
            onOpenNav={chrome.openNavigation}
          />
        )}

        <div data-print="hide">
          <DbWakingBanner />
          <DbUnavailableBanner />
          <OfflineBanner />
          <AiDisabledBanner />
          <AccessCodeNoticeBanner />
        </div>

        <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          <ShellChromeContext.Provider value={chrome}>{children}</ShellChromeContext.Provider>
        </main>
      </div>

      <CommandPalette
        me={me}
        workspace={workspace}
        {...dialogProps('palette')}
        onOpenShortcuts={() => {
          setDialog('shortcuts');
        }}
      />
      <ShortcutsDialog {...dialogProps('shortcuts')} />
      <DataUseDialog me={me} {...dialogProps('data-use')} />
      <ReportProblemDialog {...dialogProps('report')} />
    </div>
  );
}

/** Phones only: menu, where you are, and New chat. Desktop has no top bar. */
function MobileBar({
  me,
  workspace,
  navOpen,
  onOpenNav,
}: {
  me: Me;
  workspace: Workspace;
  navOpen: boolean;
  onOpenNav: () => void;
}) {
  const tenant = me.tenant.slug;
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  const venture = useQuery({ ...ventureQueryOptions(ventureId ?? ''), enabled: ventureId !== null });
  const title =
    workspace.kind === 'venture'
      ? (venture.data?.name ?? me.memberships.find((m) => m.ventureId === ventureId)?.ventureName ?? '')
      : workspace.kind === 'none'
        ? me.tenant.name
        : staffWorkspace(workspace.kind).label;

  return (
    <header
      className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-1 border-b border-border bg-background px-2 md:hidden"
      data-print="hide"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        aria-expanded={navOpen}
        onClick={onOpenNav}
      >
        <Menu aria-hidden />
      </Button>
      <p className="min-w-0 flex-1 truncate px-1 text-sm font-semibold tracking-tight">{title}</p>
      {ventureId && canWrite(me, ventureId) ? (
        <Button asChild variant="ghost" size="icon">
          <Link to="/$tenant/app/v/$ventureId" params={{ tenant, ventureId }} aria-label="New chat">
            <SquarePen aria-hidden />
          </Link>
        </Button>
      ) : null}
    </header>
  );
}
