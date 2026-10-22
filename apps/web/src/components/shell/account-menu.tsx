import type { Me } from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { ChevronsUpDown, Flag, Keyboard, LogOut, Monitor, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';

import { UserAvatar } from '@/components/faces/user-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useEndCallBeforeSignOut } from '@/features/calls/call-context';
import { useSignOut } from '@/lib/api/hooks/auth';
import { useHealth } from '@/lib/api/hooks/health';
import { errorMessage } from '@/lib/api/errors';
import { describeRoles } from '@/lib/auth/roles';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

import { staffWorkspaces } from './nav';
import { THEME_OPTIONS } from './theme-toggle';

/** Hook used by the menu and the command palette. A live call is ended first, while the session is valid. */
export function useSignOutAndRedirect() {
  const navigate = useNavigate();
  const signOut = useSignOut({ beforeClear: () => navigate({ to: '/sign-in', replace: true }) });
  const endCall = useEndCallBeforeSignOut();
  const [endingCall, setEndingCall] = useState(false);
  return {
    pending: endingCall || signOut.isPending,
    signOut: () => {
      setEndingCall(true);
      void endCall().finally(() => {
        setEndingCall(false);
        signOut.mutate(undefined, {
          onSuccess: () => {
            toast.success('Signed out');
          },
          onError: (error) => toast.error('Couldn’t sign out', { description: errorMessage(error) }),
        });
      });
    },
  };
}

interface AccountMenuProps {
  me: Me;
  /** Icon-only trigger for the collapsed sidebar rail. */
  compact?: boolean;
  onOpenShortcuts: () => void;
  onOpenDataUse: () => void;
  onOpenReportProblem: () => void;
}

/**
 * The account menu at the foot of the sidebar: appearance, shortcuts, staff workspaces, data use and
 * privacy, reporting a problem and signing out. It is also the one place the synthetic-data notice
 * lives.
 */
export function AccountMenu({
  me,
  compact = false,
  onOpenShortcuts,
  onOpenDataUse,
  onOpenReportProblem,
}: AccountMenuProps) {
  const navigate = useNavigate();
  const { preference, setTheme } = useTheme();
  const { signOut, pending } = useSignOutAndRedirect();
  const name = me.principal.displayName;
  const roles = describeRoles(me);
  const workspaces = staffWorkspaces(me);
  const ThemeIcon = THEME_OPTIONS.find((o) => o.value === preference)?.icon ?? Monitor;

  const trigger = (
    <DropdownMenuTrigger
      aria-label={`Account menu for ${name}, ${roles}`}
      className={cn(
        'group flex min-w-0 items-center gap-2.5 rounded-lg text-left transition-colors',
        'hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
        'data-[state=open]:bg-sidebar-accent',
        compact ? 'size-10 justify-center' : 'h-12 w-full px-2',
      )}
    >
      <UserAvatar name={name} size="md" decorative />
      {compact ? null : (
        <>
          {/* The space keeps the two lines two words of the visible label, which the name contains. */}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-small font-medium text-sidebar-foreground">{name}</span>{' '}
            <span className="block truncate text-caption text-sidebar-muted">{roles}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-sidebar-muted" />
        </>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {compact ? (
        <SimpleTooltip content={name} side="right">
          {trigger}
        </SimpleTooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent side="top" align="start" className="w-64">
        <div className="px-2 pt-1.5 pb-2">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-caption text-muted-foreground">{me.principal.title ?? roles}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ThemeIcon aria-hidden />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-36">
              <DropdownMenuRadioGroup
                value={preference}
                onValueChange={(value) => {
                  setTheme(value as ThemePreference);
                }}
              >
                {THEME_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onOpenShortcuts}>
            <Keyboard aria-hidden />
            Keyboard shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {workspaces.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            <DropdownMenuGroup>
              {workspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.id}
                  onSelect={() => {
                    void navigate({ to: workspace.to, params: { tenant: me.tenant.slug } });
                  }}
                >
                  <workspace.icon aria-hidden />
                  {workspace.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onOpenDataUse}>
            <ShieldQuestion aria-hidden />
            Data use &amp; privacy
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenReportProblem}>
            <Flag aria-hidden />
            Report a problem
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            signOut();
          }}
        >
          <LogOut aria-hidden />
          {pending ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
        <MenuFooter />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Short form of the deployed release (`APP_VERSION`, a git SHA in CI) for support conversations. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 7) : version;
}

/**
 * The one synthetic-data notice (this deployment holds synthetic ventures and people only, for everyone
 * who signs in) and the deployed API version from the public `GET /health`, which never touches the
 * database, so it cannot wake Aurora. Mounted only while the menu is open.
 */
function MenuFooter() {
  const health = useHealth();
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 px-2 pt-2 pb-1 text-caption text-subtle-foreground">
      <span>Synthetic data only</span>
      {health.data ? (
        <>
          <span aria-hidden>·</span>
          <span>
            Version <span className="font-mono">{shortVersion(health.data.version)}</span>
          </span>
        </>
      ) : null}
    </p>
  );
}
