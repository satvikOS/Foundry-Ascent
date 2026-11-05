import type { Me } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { createLink } from '@tanstack/react-router';
import { Search, SquarePen, type LucideIcon } from 'lucide-react';
import { useMemo, type ComponentProps, type ReactNode } from 'react';

import { VentureMark } from '@/components/faces/user-avatar';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useLessonsToReview } from '@/lib/api/hooks/eir';
import { ventureQueryOptions, useVentures } from '@/lib/api/hooks/ventures';
import { canAccessVenture, canWrite, writesAnyVenture } from '@/lib/auth/roles';
import { formatHotkey } from '@/lib/hooks/use-hotkeys';
import { cn, isMac } from '@/lib/utils';

import { AccountMenu } from './account-menu';
import { staffSections, ventureDestinations, type Workspace } from './nav';
import { RecentConversations } from './recent-conversations';
import { sidebarGroupLabelClasses, sidebarRowClasses } from './sidebar-styles';
import { useVentureName } from './venture-name';
import { WorkspaceSwitcher } from './workspace-switcher';

interface SidebarAnchorProps extends ComponentProps<'a'> {
  icon?: LucideIcon;
  /** Shown instead of an icon (e.g. a venture mark). */
  leading?: ReactNode;
  label: string;
  collapsed?: boolean;
  /** Count shown after the label (e.g. items to review). */
  count?: number;
  countLabel?: string;
}

function SidebarAnchor({
  icon: Icon,
  leading,
  label,
  collapsed = false,
  count,
  countLabel,
  className,
  ...props
}: SidebarAnchorProps) {
  return (
    <a
      data-slot="sidebar-row"
      {...props}
      className={cn(sidebarRowClasses, collapsed && 'justify-center px-0', className)}
    >
      {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted" /> : leading}
      <span className={cn('min-w-0 flex-1 truncate', collapsed && 'sr-only')}>{label}</span>
      {count && count > 0 ? (
        <span
          className={cn(
            'tabular text-caption text-sidebar-muted',
            collapsed && 'absolute top-1 right-1.5 text-[10px] leading-none text-sidebar-foreground',
          )}
        >
          {count}
          {countLabel ? <span className="sr-only"> {countLabel}</span> : null}
        </span>
      ) : null}
    </a>
  );
}

/** Router-aware sidebar row (typed `to`/`params`, `data-status="active"` from the router). */
const SidebarLink = createLink(SidebarAnchor);

function Keys({ binding, className }: { binding: string; className?: string }) {
  return (
    <KbdGroup aria-hidden className={className}>
      {formatHotkey(binding).flatMap((chord, i) => chord.map((key, j) => <Kbd key={`${i}-${j}`}>{key}</Kbd>))}
    </KbdGroup>
  );
}

/** On the rail, the label (and its shortcut) as a tooltip; the row also carries the label as its name. */
function Tip({
  show,
  label,
  shortcut,
  children,
}: {
  show: boolean;
  label: string;
  shortcut?: string | undefined;
  children: ReactNode;
}) {
  return (
    <SimpleTooltip
      side="right"
      disabled={!show}
      content={
        <span className="flex items-center gap-2">
          {label}
          {shortcut ? <Keys binding={shortcut} /> : null}
        </span>
      }
    >
      {children}
    </SimpleTooltip>
  );
}

export interface SidebarContentProps {
  me: Me;
  workspace: Workspace;
  collapsed?: boolean;
  /** Called after any navigation (closes the overlay panel). */
  onNavigate?: () => void;
  onOpenSearch: () => void;
  /** "View all" under the conversations: the palette, filtered to conversations. */
  onViewAllConversations?: () => void;
  onOpenShortcuts: () => void;
  onOpenDataUse: () => void;
  onOpenReportProblem: () => void;
  /** Collapse / close control shown next to the switcher. */
  headerAction?: ReactNode;
}

/**
 * The side panel's contents, shared by the docked panel (and its rail) and the overlay: the workspace
 * switcher, New chat and Search, the conversations (or a staff workspace's sections), the venture's pages and
 * the account. Calls start from the composer and from ⌘K, so the panel has no Call entry of its own.
 */
export function SidebarContent({
  me,
  workspace,
  collapsed = false,
  onNavigate,
  onOpenSearch,
  onViewAllConversations,
  onOpenShortcuts,
  onOpenDataUse,
  onOpenReportProblem,
  headerAction,
}: SidebarContentProps) {
  const tenant = me.tenant.slug;
  const ventures = useVentures();
  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;
  // Program leads and platform admins may open a venture's team without reading the venture: nothing else of
  // it is requested or linked for them.
  const readable = ventureId !== null && canAccessVenture(me, ventureId);
  const venture = useQuery({ ...ventureQueryOptions(ventureId ?? ''), enabled: readable });
  const ventureName = useVentureName(me, ventureId);
  const writable = ventureId !== null && canWrite(me, ventureId);
  // Only founders and team members hold conversations; read-only roles never request them.
  const hasConversations = writesAnyVenture(me);
  const ventureNames = useMemo(
    () => new Map(me.memberships.map((m) => [m.ventureId, m.ventureName])),
    [me.memberships],
  );
  const staff = workspace.kind === 'eir' || workspace.kind === 'program' || workspace.kind === 'admin';
  // Lessons waiting in every vEIR the person curates, counted on "Lessons to review" in the EIR studio.
  const lessonsToReview = useLessonsToReview({ enabled: workspace.kind === 'eir' });
  const assigned =
    workspace.kind === 'eir' ? (ventures.data ?? []).filter((v) => me.assignedVentureIds.includes(v.id)) : [];

  const search = (
    <Tip show={collapsed} label="Search" shortcut="mod+k">
      <button
        type="button"
        data-slot="sidebar-row"
        onClick={onOpenSearch}
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
        className={cn(sidebarRowClasses, collapsed && 'justify-center px-0')}
      >
        <Search aria-hidden className="size-4 shrink-0 text-sidebar-muted" />
        <span className={cn('min-w-0 flex-1 truncate text-left', collapsed && 'sr-only')}>Search</span>
        {collapsed ? null : <Keys binding="mod+k" className="pointer-coarse:hidden" />}
      </button>
    </Tip>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex shrink-0 items-center gap-1 p-2', collapsed && 'flex-col')}>
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

      <div className="grid shrink-0 gap-px px-2">
        {ventureId && writable ? (
          <Tip show={collapsed} label="New chat" shortcut="g n">
            <SidebarLink
              to="/$tenant/app/v/$ventureId"
              params={{ tenant, ventureId }}
              activeOptions={{ exact: true, includeSearch: false }}
              onClick={onNavigate}
              icon={SquarePen}
              label="New chat"
              collapsed={collapsed}
            />
          </Tip>
        ) : null}
        {search}
      </div>

      {staff ? (
        <div className="grid shrink-0 gap-px px-2 pt-4">
          {staffSections(me, workspace.kind).map((section) => (
            <Tip key={section.id} show={collapsed} label={section.label}>
              <SidebarLink
                to={section.to}
                params={{ tenant }}
                onClick={onNavigate}
                icon={section.icon}
                label={section.label}
                count={section.id === 'lessons' ? lessonsToReview.data?.total : undefined}
                countLabel="to review"
                collapsed={collapsed}
              />
            </Tip>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {hasConversations && !collapsed ? (
          <RecentConversations
            tenant={tenant}
            ventureNames={ventureNames}
            onNavigate={onNavigate}
            onViewAll={onViewAllConversations}
          />
        ) : null}
        {assigned.length > 0 && !collapsed ? (
          <div role="group" aria-labelledby="sidebar-assigned">
            <h2 id="sidebar-assigned" className={sidebarGroupLabelClasses}>
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
        <div className="grid shrink-0 gap-px px-2 pt-2 pb-1">
          <div aria-hidden className="mx-2.5 mb-2 border-t border-sidebar-border" />
          {ventureDestinations(me, ventureId).map((destination) => {
            // Counts are things to act on (open requests for help), which only the venture team can open;
            // read-only roles see the pages without them. Memory is never one: it is kept automatically.
            const count = writable && destination.id === 'help' ? venture.data?.openEscalations : undefined;
            return (
              <Tip
                key={destination.id}
                show={collapsed}
                label={destination.label}
                shortcut={destination.shortcut}
              >
                <SidebarLink
                  to={destination.to}
                  params={{ tenant, ventureId }}
                  onClick={onNavigate}
                  icon={destination.icon}
                  label={destination.label}
                  count={count}
                  countLabel="open"
                  collapsed={collapsed}
                />
              </Tip>
            );
          })}
        </div>
      ) : null}

      <div className={cn('shrink-0 p-2', collapsed && 'flex justify-center')}>
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
