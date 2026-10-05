import type { Me } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { DatabaseZap, PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { BrandMark } from './brand';
import { primaryNav } from './nav';

const itemClasses = cn(
  'group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-sidebar-muted transition-colors',
  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
  'data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-foreground',
);

function NavLabel({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return <span className={cn('truncate', collapsed && 'sr-only')}>{children}</span>;
}

function NavIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden className="size-4 shrink-0 opacity-80 group-data-[status=active]:opacity-100" />;
}

function GroupLabel({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  if (collapsed) return <div aria-hidden className="mx-2 my-2 h-px bg-sidebar-border" />;
  return (
    <div className="px-2 pt-4 pb-1.5 text-[11px] font-semibold tracking-wide text-sidebar-muted uppercase">
      {children}
    </div>
  );
}

interface SidebarContentProps {
  me: Me;
  collapsed?: boolean;
  onNavigate?: () => void;
}

/** Rail contents, shared by the desktop rail and the mobile drawer. */
export function SidebarContent({ me, collapsed = false, onNavigate }: SidebarContentProps) {
  const { items, consoles } = primaryNav(me);
  const tenant = me.tenant.slug;
  const ventures = me.memberships.slice(0, 8);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'flex h-(--header-height) shrink-0 items-center gap-2.5 border-b border-sidebar-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        <Link
          to="/$tenant/app"
          params={{ tenant }}
          onClick={onNavigate}
          className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
          aria-label={collapsed ? `Foundry Ascent home, ${me.tenant.name}` : undefined}
        >
          <BrandMark className="size-7" />
          {collapsed ? null : (
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold tracking-tight">Foundry Ascent</span>
              <span className="block truncate text-xs text-sidebar-muted">{me.tenant.name}</span>
            </span>
          )}
        </Link>
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}>
        <ul className="grid gap-0.5" aria-label="Workspace">
          {items.map((item) => (
            <li key={item.id}>
              <SimpleTooltip content={item.label} side="right" disabled={!collapsed}>
                <Link
                  {...item.link}
                  onClick={onNavigate}
                  className={cn(itemClasses, collapsed && 'justify-center px-0')}
                >
                  <NavIcon icon={item.icon} />
                  <NavLabel collapsed={collapsed}>{item.label}</NavLabel>
                </Link>
              </SimpleTooltip>
            </li>
          ))}
        </ul>

        {ventures.length > 0 ? (
          <>
            <GroupLabel collapsed={collapsed}>Your ventures</GroupLabel>
            <ul className="grid gap-0.5" aria-label="Your ventures">
              {ventures.map((membership) => (
                <li key={membership.ventureId}>
                  <SimpleTooltip content={membership.ventureName} side="right" disabled={!collapsed}>
                    <Link
                      to="/$tenant/app/ventures/$ventureId"
                      params={{ tenant, ventureId: membership.ventureId }}
                      onClick={onNavigate}
                      className={cn(itemClasses, collapsed && 'justify-center px-0')}
                    >
                      <Avatar name={membership.ventureName} size="xs" shape="square" decorative />
                      <NavLabel collapsed={collapsed}>{membership.ventureName}</NavLabel>
                    </Link>
                  </SimpleTooltip>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {consoles.length > 0 ? (
          <>
            <GroupLabel collapsed={collapsed}>Consoles</GroupLabel>
            <ul className="grid gap-0.5" aria-label="Consoles">
              {consoles.map((item) => (
                <li key={item.id}>
                  <SimpleTooltip content={item.label} side="right" disabled={!collapsed}>
                    <Link
                      {...item.link}
                      onClick={onNavigate}
                      className={cn(itemClasses, collapsed && 'justify-center px-0')}
                    >
                      <NavIcon icon={item.icon} />
                      <NavLabel collapsed={collapsed}>{item.label}</NavLabel>
                    </Link>
                  </SimpleTooltip>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className={cn('shrink-0 border-t border-sidebar-border py-3', collapsed ? 'px-2' : 'px-4')}>
        <SimpleTooltip content="All data in this environment is synthetic" side="right" disabled={!collapsed}>
          <p
            className={cn(
              'flex items-center gap-2 text-xs text-sidebar-muted',
              collapsed && 'justify-center',
            )}
          >
            <DatabaseZap aria-hidden className="size-3.5 shrink-0" />
            <span className={cn(collapsed && 'sr-only')}>Synthetic data only</span>
          </p>
        </SimpleTooltip>
      </div>
    </div>
  );
}

interface SidebarProps {
  me: Me;
  collapsed: boolean;
  onToggle: () => void;
}

/** Desktop left rail (≥ 768 px); collapses to an icon rail. */
export function Sidebar({ me, collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      aria-label="Primary"
      data-collapsed={collapsed}
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-(--sidebar-width-collapsed)' : 'w-(--sidebar-width)',
      )}
    >
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
        <SidebarContent me={me} collapsed={collapsed} />
      </nav>
      <div
        className={cn(
          'shrink-0 border-t border-sidebar-border p-2',
          collapsed ? 'flex justify-center' : 'flex justify-end',
        )}
      >
        <SimpleTooltip content={collapsed ? 'Expand sidebar ( [ )' : 'Collapse sidebar ( [ )'} side="right">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          </Button>
        </SimpleTooltip>
      </div>
    </aside>
  );
}
