import type { Me, VentureSummary } from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Settings2 } from 'lucide-react';

import { VentureMark } from '@/components/faces/user-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { canWrite } from '@/lib/auth/roles';
import { STAGE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { staffWorkspace, staffWorkspaces, type Workspace } from './nav';

interface WorkspaceSwitcherProps {
  me: Me;
  workspace: Workspace;
  ventures: readonly VentureSummary[];
  /** The current venture's name when it is not among `ventures` (staff opening a venture's Team). */
  ventureName?: string | null;
  /** Icon-only trigger for the collapsed rail. */
  compact?: boolean;
}

/**
 * Top of the sidebar: the current venture or staff workspace, and the menu to switch. Venture
 * settings (name, stage, goal) live here too.
 */
export function WorkspaceSwitcher({
  me,
  workspace,
  ventures,
  ventureName: knownVentureName = null,
  compact = false,
}: WorkspaceSwitcherProps) {
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const workspaces = staffWorkspaces(me);
  const currentVenture =
    workspace.kind === 'venture' ? (ventures.find((v) => v.id === workspace.ventureId) ?? null) : null;
  const ventureName =
    workspace.kind === 'venture'
      ? (currentVenture?.name ??
        me.memberships.find((m) => m.ventureId === workspace.ventureId)?.ventureName ??
        knownVentureName ??
        'Venture')
      : null;
  const staff = workspace.kind === 'eir' || workspace.kind === 'program' || workspace.kind === 'admin';
  const current = staff ? staffWorkspace(workspace.kind) : null;
  const label = ventureName ?? current?.label ?? 'Choose a workspace';
  const sublabel = currentVenture
    ? STAGE_LABELS[currentVenture.stage]
    : current
      ? 'Workspace'
      : me.tenant.name;
  const Icon = current?.icon;

  const mark = ventureName ? (
    <VentureMark name={ventureName} size="md" />
  ) : (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border-strong bg-card"
    >
      {Icon ? <Icon className="size-4" /> : null}
    </span>
  );

  const trigger = (
    <DropdownMenuTrigger
      aria-label={`Switch venture or workspace. Current: ${label}`}
      className={cn(
        'group flex min-w-0 items-center gap-2.5 rounded-lg text-left transition-colors',
        'hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring',
        'data-[state=open]:bg-sidebar-accent',
        compact ? 'size-10 justify-center' : 'h-12 flex-1 px-2',
      )}
    >
      {mark}
      {compact ? null : (
        <>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
              {label}
            </span>
            <span className="block truncate text-caption text-sidebar-muted">{sublabel}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-sidebar-muted" />
        </>
      )}
    </DropdownMenuTrigger>
  );

  const ventureId = workspace.kind === 'venture' ? workspace.ventureId : null;

  return (
    <DropdownMenu>
      {compact ? (
        <SimpleTooltip content={label} side="right">
          {trigger}
        </SimpleTooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" className="w-72">
        {ventures.length > 0 ? (
          <>
            <DropdownMenuLabel>Ventures</DropdownMenuLabel>
            <DropdownMenuGroup>
              {ventures.map((venture) => {
                const selected = venture.id === ventureId;
                return (
                  <DropdownMenuItem
                    key={venture.id}
                    aria-current={selected ? 'true' : undefined}
                    onSelect={() => {
                      void navigate({
                        to: '/$tenant/app/v/$ventureId',
                        params: { tenant, ventureId: venture.id },
                      });
                    }}
                  >
                    <VentureMark name={venture.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{venture.name}</span>
                      <span className="block truncate text-caption text-muted-foreground">
                        {STAGE_LABELS[venture.stage]}
                        {venture.myRole ? '' : ' · assigned'}
                      </span>
                    </span>
                    {selected ? <Check aria-hidden className="text-foreground" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        ) : null}
        {ventureId && canWrite(me, ventureId) ? (
          <DropdownMenuGroup>
            {ventures.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onSelect={() => {
                void navigate({ to: '/$tenant/app/v/$ventureId/settings', params: { tenant, ventureId } });
              }}
            >
              <Settings2 aria-hidden />
              Venture settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : null}
        {workspaces.length > 0 ? (
          <>
            {ventures.length > 0 || ventureId ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            <DropdownMenuGroup>
              {workspaces.map((item) => {
                const selected = workspace.kind === item.id;
                return (
                  <DropdownMenuItem
                    key={item.id}
                    aria-current={selected ? 'true' : undefined}
                    onSelect={() => {
                      void navigate({ to: item.to, params: { tenant } });
                    }}
                  >
                    <item.icon aria-hidden />
                    <span className="flex-1">{item.label}</span>
                    {selected ? <Check aria-hidden className="text-foreground" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
