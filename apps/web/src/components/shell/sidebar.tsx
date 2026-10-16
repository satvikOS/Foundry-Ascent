import type { Me } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { createLink } from '@tanstack/react-router';
import { Phone, Search, SquarePen, type LucideIcon } from 'lucide-react';
import { useMemo, type ComponentProps, type ReactNode } from 'react';

import { VentureMark } from '@/components/faces/user-avatar';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useCallsAvailable } from '@/features/calls/calls-available';
import { ventureQueryOptions, useVentures } from '@/lib/api/hooks/ventures';
import { canAccessVenture, canWrite, writesAnyVenture } from '@/lib/auth/roles';
import { cn, isMac } from '@/lib/utils';
import { veirDisplay } from '@/lib/veir';

import { AccountMenu } from './account-menu';
import { STAFF_SECTIONS, ventureDestinations, type Workspace } from './nav';
import { RecentConversations } from './recent-conversations';
import { useVentureName } from './venture-name';
import { WorkspaceSwitcher } from './workspace-switcher';

const itemClasses = cn(
  'group flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-small font-medium text-sidebar-muted transition-colors',
  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
  'data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-foreground',
);

interface SidebarAnchorProps extends ComponentProps<'a'> {
  icon?: LucideIcon;
  /** Shown instead of an icon (e.g. a venture mark). */
  leading?: ReactNode;
  label: string;
  collapsed?: boolean;
  /** Count shown after the label (e.g. items to review). */
  count?: number;
  countLabel?: string;
  emphasis?: boolean;
}

function SidebarAnchor({
  icon: Icon,
  leading,
  label,
  collapsed = false,
  count,
  countLabel,
  emphasis = false,
  className,
  ...props
}: SidebarAnchorProps) {
  return (
    <a
      {...props}
      className={cn(
        itemClasses,
        emphasis && 'text-sidebar-foreground',
        collapsed && 'justify-center px-0',
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-4 shrink-0" /> : leading}
      <span className={cn('min-w-0 flex-1 truncate', collapsed && 'sr-only')}>{label}</span>
      {count && count > 0 ? (
        <span className={cn('tabular text-caption text-sidebar-muted', collapsed && 'sr-only')}>
          {count}
          {countLabel ? <span className="sr-only"> {countLabel}</span> : null}
        </span>
      ) : null}
    </a>
  );
}

/** Router-aware sidebar row (typed `to`/`params`, `data-status="active"` from the router). */
const SidebarLink = createLink(SidebarAnchor);

function Tip({ show, label, children }: { show: boolean; label: string; children: ReactNode }) {
  return (
    <SimpleTooltip content={label} side="right" disabled={!show}>
      {children}
    </SimpleTooltip>
  );
}

function Divider({ collapsed }: { collapsed: boolean }) {
  return <div aria-hidden className={cn('my-2 h-px bg-sidebar-border', collapsed ? 'mx-2' : 'mx-2.5')} />;
}

export interface SidebarContentProps {
  me: Me;
  workspace: Workspace;
  collapsed?: boolean;
  /** Called after any navigation (closes the mobile sheet). */
  onNavigate?: () => void;
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
  onOpenDataUse: () => void;
  onOpenReportProblem: () => void;
  /** Collapse / close control shown next to the switcher. */
  headerAction?: ReactNode;
}

/** Sidebar contents, shared by the desktop sidebar (and its collapsed rail) and the mobile sheet. */
export function SidebarContent({
  me,
  workspace,
  collapsed = false,
  onNavigate,
  onOpenSearch,
  onOpenShortcuts,
  onOpenDataUse,
  onOpenReportProblem,
  headerAction,
}: SidebarContentProps) {
  const tenant = me.tenant.slug;
  const ventures = useVentures();
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  // Program leads and platform admins may open a venture's Team without reading the venture: nothing else of it
  // is requested or linked for them.
  const readable = ventureId !== null && canAccessVenture(me, ventureId);
  const venture = useQuery({ ...ventureQueryOptions(ventureId ?? ''), enabled: readable });
  const ventureName = useVentureName(me, ventureId);
  const veir = veirDisplay(venture.data);
  const writable = ventureId !== null && canWrite(me, ventureId);
  const callable = useCallsAvailable(ventureId, writable);
  // Only founders and team members hold conversations; read-only roles never request them.
  const hasConversations = writesAnyVenture(me);
  const ventureNames = useMemo(
    () => new Map(me.memberships.map((m) => [m.ventureId, m.ventureName])),
    [me.memberships],
  );
  const staff = workspace.kind === 'eir' || workspace.kind === 'program' || workspace.kind === 'admin';
  const assigned =
    workspace.kind === 'eir' ? (ventures.data ?? []).filter((v) => me.assignedVentureIds.includes(v.id)) : [];

  const search = (
    <Tip show={collapsed} label="Search">
      <button
        type="button"
        onClick={onOpenSearch}
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
        className={cn(itemClasses, collapsed && 'justify-center px-0')}
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate text-left', collapsed && 'sr-only')}>Search</span>
        {collapsed ? null : (
          <KbdGroup
            aria-hidden
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Kbd>{isMac() ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        )}
      </button>
    </Tip>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex shrink-0 items-center gap-1 pt-2', collapsed ? 'flex-col px-2' : 'px-2')}>
        {collapsed ? headerAction : null}
        <WorkspaceSwitcher
          me={me}
          workspace={workspace}
          ventures={ventures.data ?? []}
          ventureName={ventureName}
          compact={collapsed}
        />
        {collapsed ? null : headerAction}
      </div>

      <div className={cn('grid shrink-0 gap-px pt-2', collapsed ? 'px-2' : 'px-2')}>
        {ventureId && writable ? (
          <Tip show={collapsed} label="New chat">
            <SidebarLink
              to="/$tenant/app/v/$ventureId"
              params={{ tenant, ventureId }}
              activeOptions={{ exact: true }}
              onClick={onNavigate}
              icon={SquarePen}
              label="New chat"
              emphasis
              collapsed={collapsed}
            />
          </Tip>
        ) : null}
        {ventureId && callable && veir ? (
          <Tip show={collapsed} label={`Call ${veir.name}`}>
            <SidebarLink
              to="/$tenant/app/v/$ventureId"
              params={{ tenant, ventureId }}
              search={{ call: 1 }}
              activeOptions={{ exact: true }}
              onClick={onNavigate}
              icon={Phone}
              label={`Call ${veir.name}`}
              emphasis
              collapsed={collapsed}
            />
          </Tip>
        ) : null}
        {search}
      </div>

      {staff ? (
        <div className="grid shrink-0 gap-px px-2 pt-2">
          <Divider collapsed={collapsed} />
          {STAFF_SECTIONS[workspace.kind].map((section) => (
            <Tip key={section.id} show={collapsed} label={section.label}>
              <SidebarLink
                to={section.to}
                params={{ tenant }}
                onClick={onNavigate}
                icon={section.icon}
                label={section.label}
                collapsed={collapsed}
              />
            </Tip>
          ))}
        </div>
      ) : null}

      <div className={cn('min-h-0 flex-1 overflow-y-auto pb-2', collapsed ? 'px-2' : 'px-2')}>
        {hasConversations && !collapsed ? (
          <RecentConversations tenant={tenant} ventureNames={ventureNames} onNavigate={onNavigate} />
        ) : null}
        {assigned.length > 0 && !collapsed ? (
          <div role="group" aria-labelledby="sidebar-assigned" className="pt-2">
            <h2
              id="sidebar-assigned"
              className="px-2.5 pt-4 pb-1 text-caption font-medium text-sidebar-muted"
            >
              Assigned ventures
            </h2>
            <ul className="grid gap-px">
              {assigned.map((item) => (
                <li key={item.id}>
                  <SidebarLink
                    to="/$tenant/app/v/$ventureId"
                    params={{ tenant, ventureId: item.id }}
                    onClick={onNavigate}
                    leading={<VentureMark name={item.name} size="xs" />}
                    label={item.name}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {ventureId ? (
        <div className="grid shrink-0 gap-px border-t border-sidebar-border px-2 py-2">
          {ventureDestinations(me, ventureId).map((destination) => {
            // Counts are things to act on (proposals to review, requests for help), which only the venture
            // team can open; read-only roles see the pages without them.
            const count = !writable
              ? undefined
              : destination.id === 'knowledge'
                ? venture.data?.pendingMemory
                : destination.id === 'help'
                  ? venture.data?.openEscalations
                  : undefined;
            return (
              <Tip key={destination.id} show={collapsed} label={destination.label}>
                <SidebarLink
                  to={destination.to}
                  params={{ tenant, ventureId }}
                  onClick={onNavigate}
                  icon={destination.icon}
                  label={destination.label}
                  count={count}
                  countLabel={destination.id === 'knowledge' ? 'to review' : 'open'}
                  collapsed={collapsed}
                />
              </Tip>
            );
          })}
        </div>
      ) : null}

      <div className={cn('shrink-0 border-t border-sidebar-border p-2', collapsed && 'flex justify-center')}>
        <AccountMenu
          me={me}
          compact={collapsed}
          onOpenShortcuts={onOpenShortcuts}
          onOpenDataUse={onOpenDataUse}
          onOpenReportProblem={onOpenReportProblem}
        />
      </div>
    </div>
  );
}
