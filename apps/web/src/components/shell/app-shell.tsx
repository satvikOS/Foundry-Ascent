import type { Me } from '@foundry/contracts';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Menu, PanelLeftClose, PanelLeftOpen, SquarePen, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useCallsAvailable } from '@/features/calls/calls-available';
import { MiniCallBar } from '@/features/calls/mini-call-bar';
import { canWrite } from '@/lib/auth/roles';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';

import type { PaletteScope } from './command-palette';
import {
  STAFF_WORKSPACES,
  staffWorkspace,
  staffWorkspaces,
  VENTURE_DESTINATIONS,
  ventureDestinations,
  workspaceFromPath,
  type Workspace,
} from './nav';
import { ShellChromeContext, type ShellChrome } from './shell-chrome';
import { SidebarContent } from './sidebar';
import { useVentureName } from './venture-name';
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

// Opened on demand (⌘K, ?, the account menu): loaded the first time they open, so they stay out of the
// first-paint bundle.
const CommandPalette = lazy(() => import('./command-palette').then((m) => ({ default: m.CommandPalette })));
const ShortcutsDialog = lazy(() =>
  import('./shortcuts-dialog').then((m) => ({ default: m.ShortcutsDialog })),
);
const DataUseDialog = lazy(() => import('./account-dialogs').then((m) => ({ default: m.DataUseDialog })));
const ReportProblemDialog = lazy(() =>
  import('./account-dialogs').then((m) => ({ default: m.ReportProblemDialog })),
);

type ShellDialog = 'palette' | 'shortcuts' | 'data-use' | 'report' | null;

/**
 * The one authenticated frame for every role, around a floating frosted side panel (design spec §8):
 *   ≥ 1024 px   the panel floats 12 px in from the viewport edges with curved corners, beside the content;
 *               `[` collapses it to a 56 px rail of icons (remembered per browser).
 *   768–1023    the rail; expanding opens the full panel over the content (focus trapped, click-away scrim).
 *   < 768       a slim top bar; its menu opens the same panel as a floating sheet.
 * Status banners show only while something needs attention, then the <main> landmark. There is no top
 * bar on desktop, and a page with its own phone header (a conversation) takes the phone bar's place.
 */
export function AppShell({ me, children }: AppShellProps) {
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const workspace = workspaceFromPath(pathname);
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  const callable = useCallsAvailable(ventureId, ventureId !== null && canWrite(me, ventureId));
  const docked = useMediaQuery(BREAKPOINTS.lg, true);
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(STORAGE_KEYS.sidebarCollapsed) === '1');
  // The panel as an overlay: the tablet rail's expanded state, and the phone's navigation sheet.
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [dialog, setDialog] = useState<ShellDialog>(null);
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all');
  // Dialogs opened at least once stay mounted (their close animation and state survive).
  const [opened, setOpened] = useState<ReadonlySet<Exclude<ShellDialog, null>>>(() => new Set());
  // Pages with their own phone header (a conversation) claim the bar; the shell's bar shows otherwise.
  const [mobileBarClaims, setMobileBarClaims] = useState(0);
  const chrome = useMemo<ShellChrome>(
    () => ({
      openNavigation: () => {
        setOverlayOpen(true);
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
  // The desktop panel shows as a rail when collapsed; between 768 and 1023 px it is always the rail.
  const railed = docked ? collapsed : true;

  // Close the overlay after navigation, and when the window grows into the docked layout.
  useEffect(() => {
    setOverlayOpen(false);
  }, [pathname, docked]);
  // Remember the venture so the app reopens there.
  useEffect(() => {
    if (ventureId) safeStorage.set(STORAGE_KEYS.lastVenture, ventureId);
  }, [ventureId]);

  const toggleSidebar = useCallback(() => {
    if (!docked) {
      setOverlayOpen((open) => !open);
      return;
    }
    setCollapsed((current) => {
      safeStorage.set(STORAGE_KEYS.sidebarCollapsed, current ? '0' : '1');
      return !current;
    });
  }, [docked]);
  const openDialog = useCallback((next: ShellDialog, scope: PaletteScope = 'all') => {
    setOverlayOpen(false);
    setDialog(next);
    if (next === 'palette') setPaletteScope(scope);
    if (next !== null) setOpened((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);
  const dialogProps = (id: Exclude<ShellDialog, null>) => ({
    open: dialog === id,
    onOpenChange: (open: boolean) => {
      if (open) openDialog(id);
      else setDialog(null);
    },
  });
  const startCall = useCallback(() => {
    if (ventureId && callable)
      void navigate({ to: '/$tenant/app/v/$ventureId', params: { tenant, ventureId }, search: { call: 1 } });
  }, [callable, navigate, tenant, ventureId]);

  // The page and workspace shortcuts come from nav.ts, which the shortcuts list reads too.
  useHotkeys({
    'mod+k': () => {
      openDialog(dialog === 'palette' ? null : 'palette');
    },
    '?': () => {
      openDialog('shortcuts');
    },
    '[': toggleSidebar,
    'g n': () => {
      if (ventureId) void navigate({ to: '/$tenant/app/v/$ventureId', params: { tenant, ventureId } });
    },
    'g v': startCall,
    ...Object.fromEntries(
      VENTURE_DESTINATIONS.map((destination) => [
        destination.shortcut,
        () => {
          if (ventureId && ventureDestinations(me, ventureId).includes(destination))
            void navigate({ to: destination.to, params: { tenant, ventureId } });
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
    onViewAllConversations: () => {
      openDialog('palette', 'conversations');
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

  const expanded = docked ? !collapsed : overlayOpen;
  const toggleLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar';
  const collapseButton = (
    <SimpleTooltip content={`${toggleLabel}  [`} side="right">
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground"
        onClick={toggleSidebar}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        aria-keyshortcuts="["
      >
        {expanded ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
      </Button>
    </SimpleTooltip>
  );

  return (
    <div className="app-ground min-h-dvh">
      <aside
        aria-label="Sidebar"
        data-collapsed={railed}
        data-print="hide"
        data-slot="side-panel"
        className={cn(
          'glass-float fixed top-(--panel-inset) bottom-(--panel-inset) left-(--panel-inset) z-30 hidden flex-col overflow-hidden text-sidebar-foreground md:flex',
          'transition-[width,border-radius] duration-(--dur-panel) ease-out-expo motion-reduce:transition-none',
          railed
            ? 'w-(--sidebar-width-collapsed) rounded-(--radius-rail)'
            : 'w-(--sidebar-width) rounded-(--radius-panel)',
        )}
      >
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <SidebarContent
            me={me}
            workspace={workspace}
            collapsed={railed}
            headerAction={collapseButton}
            {...sidebarActions}
          />
        </nav>
      </aside>

      <PanelOverlay open={overlayOpen && !docked} onOpenChange={setOverlayOpen}>
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <SidebarContent
            me={me}
            workspace={workspace}
            onNavigate={() => {
              setOverlayOpen(false);
            }}
            headerAction={
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close navigation"
                  className="shrink-0 text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground"
                >
                  <X aria-hidden />
                </Button>
              </DialogPrimitive.Close>
            }
            {...sidebarActions}
          />
        </nav>
      </PanelOverlay>

      <div
        className={cn(
          'flex min-h-dvh min-w-0 flex-col transition-[padding] duration-(--dur-panel) ease-out-expo motion-reduce:transition-none',
          'md:pl-[calc(var(--sidebar-width-collapsed)+2*var(--panel-inset))]',
          !collapsed && 'lg:pl-[calc(var(--sidebar-width)+2*var(--panel-inset))]',
        )}
      >
        {mobileBarClaims > 0 ? null : (
          <MobileBar me={me} workspace={workspace} navOpen={overlayOpen} onOpenNav={chrome.openNavigation} />
        )}
        <MiniCallBar />

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

      <Suspense fallback={null}>
        {opened.has('palette') ? (
          <CommandPalette
            me={me}
            workspace={workspace}
            scope={paletteScope}
            onScopeChange={setPaletteScope}
            {...dialogProps('palette')}
            onOpenShortcuts={() => {
              openDialog('shortcuts');
            }}
            onToggleSidebar={toggleSidebar}
          />
        ) : null}
        {opened.has('shortcuts') ? <ShortcutsDialog {...dialogProps('shortcuts')} /> : null}
        {opened.has('data-use') ? <DataUseDialog me={me} {...dialogProps('data-use')} /> : null}
        {opened.has('report') ? <ReportProblemDialog {...dialogProps('report')} /> : null}
      </Suspense>
    </div>
  );
}

/**
 * The side panel over the content, below 1024 px: from the tablet rail (inset 12 px, like the docked panel)
 * and from the phone bar's menu (a floating sheet inset 8 px inside the safe areas). A soft scrim that only
 * dims sits beneath, so the frosted panel is the one blur on screen; focus is trapped and Escape or a click
 * outside closes it.
 */
function PanelOverlay({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="panel-overlay"
          className="fixed inset-0 z-40 bg-(--scrim-soft) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="panel-sheet"
          aria-describedby={undefined}
          className={cn(
            'glass-float fixed z-50 flex flex-col overflow-hidden text-sidebar-foreground outline-none [--glass-float-face:var(--glass-float-bg-over)]',
            // Phones: a floating sheet inside the safe areas.
            'top-[calc(0.5rem+env(safe-area-inset-top))] bottom-[calc(0.5rem+env(safe-area-inset-bottom))] left-[calc(0.5rem+env(safe-area-inset-left))] w-[min(calc(100vw-3.5rem),20rem)] rounded-(--radius-sheet)',
            // Tablets: the docked panel's geometry, over the content.
            'md:top-(--panel-inset) md:bottom-(--panel-inset) md:left-(--panel-inset) md:w-(--sidebar-width) md:rounded-(--radius-panel)',
            'duration-(--dur-panel) ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-left-4 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-left-4',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
  const ventureName = useVentureName(me, ventureId);
  const title =
    workspace.kind === 'venture'
      ? (ventureName ?? '')
      : workspace.kind === 'none'
        ? me.tenant.name
        : staffWorkspace(workspace.kind).label;

  return (
    <header
      className="glass-bar sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-1 border-b px-2 md:hidden"
      data-print="hide"
      data-phone-bar=""
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
      <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium tracking-tight">{title}</p>
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
