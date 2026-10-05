import type { Me } from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { BadgeInfo, Keyboard, LogOut, Monitor, Moon, Sun } from 'lucide-react';

import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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
import { useSignOut } from '@/lib/api/hooks/auth';
import { useHealth } from '@/lib/api/hooks/health';
import { errorMessage } from '@/lib/api/errors';
import { describeRoles } from '@/lib/auth/roles';
import { useTheme, type ThemePreference } from '@/lib/theme';

interface UserMenuProps {
  me: Me;
  onOpenShortcuts: () => void;
}

/** Hook used by the menu and the command palette. */
export function useSignOutAndRedirect() {
  const navigate = useNavigate();
  const signOut = useSignOut({ beforeClear: () => navigate({ to: '/sign-in', replace: true }) });
  return {
    pending: signOut.isPending,
    signOut: () => {
      signOut.mutate(undefined, {
        onSuccess: () => {
          toast.success('Signed out');
        },
        onError: (error) => toast.error('Couldn’t sign out', { description: errorMessage(error) }),
      });
    },
  };
}

export function UserMenu({ me, onOpenShortcuts }: UserMenuProps) {
  const { preference, setTheme } = useTheme();
  const { signOut, pending } = useSignOutAndRedirect();
  const name = me.principal.displayName;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label={`Account menu for ${name}`}
        >
          <Avatar name={name} size="sm" decorative />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-start gap-2.5 px-2 py-2">
          <Avatar name={name} size="default" decorative />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{name}</p>
            {me.principal.title ? (
              <p className="truncate text-xs text-muted-foreground">{me.principal.title}</p>
            ) : null}
            <p className="mt-1 truncate text-xs text-muted-foreground">{describeRoles(me)}</p>
            {me.principal.synthetic ? (
              <Badge variant="outline" className="mt-1.5 gap-1">
                <BadgeInfo aria-hidden />
                Synthetic identity
              </Badge>
            ) : null}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {preference === 'light' ? (
                <Sun aria-hidden />
              ) : preference === 'dark' ? (
                <Moon aria-hidden />
              ) : (
                <Monitor aria-hidden />
              )}
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-36">
              <DropdownMenuRadioGroup
                value={preference}
                onValueChange={(v) => {
                  setTheme(v as ThemePreference);
                }}
              >
                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onOpenShortcuts}>
            <Keyboard aria-hidden />
            Keyboard shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
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
        <BuildVersion />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Short form of the deployed release (`APP_VERSION`, a git SHA in CI) for support conversations. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 7) : version;
}

/**
 * The deployed API version from the public `GET /health` (never touches the database, so it cannot wake
 * Aurora). Mounted only while the menu is open; the result is cached for five minutes.
 */
function BuildVersion() {
  const health = useHealth();
  if (!health.data) return null;
  return (
    <p className="px-2 pt-1.5 pb-1 text-[11px] text-subtle-foreground">
      Version <span className="font-mono">{shortVersion(health.data.version)}</span>
    </p>
  );
}
