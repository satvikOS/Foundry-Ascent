import type { Me, PlatformRole } from '@foundry/contracts';
import {
  BookOpenCheck,
  Briefcase,
  ChartColumn,
  ClipboardCheck,
  FileText,
  Flag,
  Gauge,
  IdCard,
  Inbox,
  LayoutDashboard,
  Library,
  LifeBuoy,
  Lightbulb,
  ListTree,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  UserSquare,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';

import {
  canAccessVenture,
  canManageAnyTeam,
  hasAnyRole,
  canUseAdminConsole,
  canUseEirStudio,
  canUseProgramConsole,
} from '@/lib/auth/roles';

/*
 * One shell for every role. The sidebar shows the sections of the current workspace: a venture
 * (conversations and the venture's pages) or a staff workspace (EIR studio, Program, Admin). The
 * workspace switcher at the top of the sidebar moves between them.
 */

export type StaffWorkspaceId = 'eir' | 'program' | 'admin';

export type Workspace =
  { kind: 'venture'; ventureId: string } | { kind: StaffWorkspaceId } | { kind: 'none' };

/** Which workspace a path belongs to (`/<tenant>/app/v/<id>/…`, `/<tenant>/app/eir/…`, …). */
export function workspaceFromPath(pathname: string): Workspace {
  const match = /^\/[^/]+\/app(?:\/([^/]+)(?:\/([^/]+))?)?/.exec(pathname);
  const section = match?.[1];
  if (section === 'v' && match?.[2]) return { kind: 'venture', ventureId: decodeURIComponent(match[2]) };
  if (section === 'eir' || section === 'program' || section === 'admin') return { kind: section };
  return { kind: 'none' };
}

export interface StaffWorkspace {
  id: StaffWorkspaceId;
  label: string;
  icon: LucideIcon;
  shortcut: string;
  to: '/$tenant/app/eir' | '/$tenant/app/program' | '/$tenant/app/admin';
}

/** The staff workspaces; their `shortcut` drives both the key binding and the shortcuts list. */
export const STAFF_WORKSPACES: readonly StaffWorkspace[] = [
  { id: 'eir', label: 'EIR studio', icon: BookOpenCheck, shortcut: 'g e', to: '/$tenant/app/eir' },
  { id: 'program', label: 'Program', icon: LayoutDashboard, shortcut: 'g p', to: '/$tenant/app/program' },
  { id: 'admin', label: 'Admin', icon: ShieldCheck, shortcut: 'g a', to: '/$tenant/app/admin' },
];

/** Staff workspaces this person may open (display only; the API and RLS decide access). */
export function staffWorkspaces(me: Me): StaffWorkspace[] {
  return STAFF_WORKSPACES.filter((workspace) =>
    workspace.id === 'eir'
      ? canUseEirStudio(me)
      : workspace.id === 'program'
        ? canUseProgramConsole(me)
        : canUseAdminConsole(me),
  );
}

export function staffWorkspace(id: StaffWorkspaceId): StaffWorkspace {
  const found = STAFF_WORKSPACES.find((workspace) => workspace.id === id);
  if (!found) throw new Error(`Unknown workspace ${id}`);
  return found;
}

export type VentureDestinationId = 'knowledge' | 'documents' | 'help' | 'team';

export interface VentureDestination {
  id: VentureDestinationId;
  label: string;
  icon: LucideIcon;
  shortcut: string;
  to:
    | '/$tenant/app/v/$ventureId/knowledge'
    | '/$tenant/app/v/$ventureId/documents'
    | '/$tenant/app/v/$ventureId/help'
    | '/$tenant/app/v/$ventureId/team';
}

/** The venture's pages, under the conversations in the sidebar (`shortcut`: binding and shortcuts list). */
export const VENTURE_DESTINATIONS: readonly VentureDestination[] = [
  {
    id: 'knowledge',
    label: 'Knowledge',
    icon: Library,
    shortcut: 'g k',
    to: '/$tenant/app/v/$ventureId/knowledge',
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: FileText,
    shortcut: 'g d',
    to: '/$tenant/app/v/$ventureId/documents',
  },
  { id: 'help', label: 'Human help', icon: LifeBuoy, shortcut: 'g h', to: '/$tenant/app/v/$ventureId/help' },
  { id: 'team', label: 'Team', icon: Users, shortcut: 'g t', to: '/$tenant/app/v/$ventureId/team' },
];

/**
 * The venture's pages this person can open: all of them for its members and its assigned EIR; only Team for
 * program leads and platform admins who are neither (the other pages would refuse them).
 */
export function ventureDestinations(me: Me, ventureId: string): readonly VentureDestination[] {
  if (canAccessVenture(me, ventureId)) return VENTURE_DESTINATIONS;
  if (canManageAnyTeam(me)) return VENTURE_DESTINATIONS.filter((destination) => destination.id === 'team');
  return [];
}

export interface StaffSection {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Shown only to these roles (the API refuses everyone else); absent: everyone in the workspace. */
  roles?: readonly PlatformRole[];
  to:
    | '/$tenant/app/eir/personas'
    | '/$tenant/app/eir/eirs'
    | '/$tenant/app/eir/lessons'
    | '/$tenant/app/eir/reviews'
    | '/$tenant/app/eir/inbox'
    | '/$tenant/app/program/portfolio'
    | '/$tenant/app/program/ventures'
    | '/$tenant/app/program/assignments'
    | '/$tenant/app/program/resources'
    | '/$tenant/app/program/escalations'
    | '/$tenant/app/admin/principals'
    | '/$tenant/app/admin/settings'
    | '/$tenant/app/admin/usage'
    | '/$tenant/app/admin/audit';
}

export const STAFF_SECTIONS: Record<StaffWorkspaceId, readonly StaffSection[]> = {
  eir: [
    { id: 'personas', label: 'Personas & knowledge', icon: UserSquare, to: '/$tenant/app/eir/personas' },
    // The people vEIRs are built from: program leads and platform admins add and edit them.
    {
      id: 'eirs',
      label: 'EIRs',
      icon: IdCard,
      roles: ['program_lead', 'platform_admin'],
      to: '/$tenant/app/eir/eirs',
    },
    { id: 'lessons', label: 'Lessons to review', icon: Lightbulb, to: '/$tenant/app/eir/lessons' },
    { id: 'reviews', label: 'Calibration reviews', icon: ClipboardCheck, to: '/$tenant/app/eir/reviews' },
    { id: 'inbox', label: 'Inbox', icon: Inbox, to: '/$tenant/app/eir/inbox' },
  ],
  program: [
    { id: 'portfolio', label: 'Portfolio', icon: ChartColumn, to: '/$tenant/app/program/portfolio' },
    { id: 'ventures', label: 'Ventures', icon: Briefcase, to: '/$tenant/app/program/ventures' },
    {
      id: 'assignments',
      label: 'vEIRs & assignments',
      icon: Waypoints,
      to: '/$tenant/app/program/assignments',
    },
    { id: 'resources', label: 'Resources', icon: ListTree, to: '/$tenant/app/program/resources' },
    { id: 'escalations', label: 'Escalations', icon: Flag, to: '/$tenant/app/program/escalations' },
  ],
  admin: [
    { id: 'principals', label: 'People & access', icon: Users, to: '/$tenant/app/admin/principals' },
    { id: 'settings', label: 'Settings', icon: Settings, to: '/$tenant/app/admin/settings' },
    { id: 'usage', label: 'Usage', icon: Gauge, to: '/$tenant/app/admin/usage' },
    { id: 'audit', label: 'Audit log', icon: ScrollText, to: '/$tenant/app/admin/audit' },
  ],
};

/** The sections of a staff workspace this person sees (display only; the API and RLS decide access). */
export function staffSections(me: Me, workspace: StaffWorkspaceId): readonly StaffSection[] {
  return STAFF_SECTIONS[workspace].filter((section) => !section.roles || hasAnyRole(me, section.roles));
}

export type Landing = { kind: 'venture'; ventureId: string } | { kind: StaffWorkspaceId } | null;

/**
 * Where `/<tenant>/app` opens: venture members go to their last venture's new chat (or their first
 * venture), staff to their main workspace, and someone with neither sees the "no workspace yet" state.
 */
export function defaultLanding(me: Me, lastVentureId: string | null): Landing {
  if (me.memberships.length > 0) {
    if (lastVentureId && canAccessVenture(me, lastVentureId))
      return { kind: 'venture', ventureId: lastVentureId };
    const writable = me.memberships.find((m) => m.role === 'founder' || m.role === 'team');
    const first = writable ?? me.memberships[0];
    if (first) return { kind: 'venture', ventureId: first.ventureId };
  }
  if (canUseProgramConsole(me)) return { kind: 'program' };
  if (canUseEirStudio(me)) return { kind: 'eir' };
  if (canUseAdminConsole(me)) return { kind: 'admin' };
  return null;
}
