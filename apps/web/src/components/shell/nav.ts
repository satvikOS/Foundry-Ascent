import type { Me } from '@foundry/contracts';
import { linkOptions } from '@tanstack/react-router';
import {
  BookOpenCheck,
  Briefcase,
  ChartColumn,
  ClipboardCheck,
  Compass,
  FileText,
  Flag,
  FlaskConical,
  Gavel,
  Gauge,
  House,
  Inbox,
  LayoutDashboard,
  Library,
  ListTree,
  Milestone,
  MessagesSquare,
  Rocket,
  ScrollText,
  Settings,
  ShieldCheck,
  Siren,
  Users,
  UserSquare,
  Brain,
  type LucideIcon,
} from 'lucide-react';

import { canUseAdminConsole, canUseEirStudio, canUseProgramConsole } from '@/lib/auth/roles';

/** Primary navigation (left rail), filtered by role. Shortcuts are listed in the shortcuts dialog. */
export function primaryNav(me: Me) {
  const tenant = me.tenant.slug;
  const items = [
    {
      id: 'home',
      label: 'Home',
      icon: House,
      shortcut: 'g h',
      link: linkOptions({ to: '/$tenant/app', params: { tenant }, activeOptions: { exact: true } }),
    },
    {
      id: 'ventures',
      label: 'Ventures',
      icon: Rocket,
      shortcut: 'g v',
      link: linkOptions({ to: '/$tenant/app/ventures', params: { tenant } }),
    },
  ];
  const consoles = [
    canUseEirStudio(me)
      ? {
          id: 'eir',
          label: 'EIR studio',
          icon: BookOpenCheck,
          shortcut: 'g e',
          link: linkOptions({ to: '/$tenant/app/eir', params: { tenant } }),
        }
      : null,
    canUseProgramConsole(me)
      ? {
          id: 'program',
          label: 'Program',
          icon: LayoutDashboard,
          shortcut: 'g p',
          link: linkOptions({ to: '/$tenant/app/program', params: { tenant } }),
        }
      : null,
    canUseAdminConsole(me)
      ? {
          id: 'admin',
          label: 'Admin',
          icon: ShieldCheck,
          shortcut: 'g a',
          link: linkOptions({ to: '/admin' }),
        }
      : null,
  ].filter((item) => item !== null);
  return { items, consoles };
}

export type VentureSectionId =
  | 'overview'
  | 'coach'
  | 'memory'
  | 'evidence'
  | 'decisions'
  | 'experiments'
  | 'milestones'
  | 'documents'
  | 'team'
  | 'escalations';

export interface VentureSection {
  id: VentureSectionId;
  label: string;
  icon: LucideIcon;
  description: string;
  shortcut?: string;
}

/** Venture workspace sections, in navigation order. */
export const VENTURE_SECTIONS: VentureSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: Compass,
    description: 'Since your last session',
    shortcut: 'g o',
  },
  {
    id: 'coach',
    label: 'Coach',
    icon: MessagesSquare,
    description: 'Sessions with Foundry Guide',
    shortcut: 'g c',
  },
  { id: 'memory', label: 'Memory', icon: Brain, description: 'What the coach remembers', shortcut: 'g m' },
  { id: 'evidence', label: 'Evidence', icon: Library, description: 'Sources and evidence' },
  { id: 'decisions', label: 'Decisions', icon: Gavel, description: 'Confirmed decisions' },
  { id: 'experiments', label: 'Experiments', icon: FlaskConical, description: 'Tests and results' },
  { id: 'milestones', label: 'Milestones', icon: Milestone, description: 'Goals and dates' },
  { id: 'documents', label: 'Documents', icon: FileText, description: 'Uploaded files', shortcut: 'g d' },
  { id: 'team', label: 'Team', icon: Users, description: 'Members and roles' },
  { id: 'escalations', label: 'Escalations', icon: Siren, description: 'Human handoffs', shortcut: 'g x' },
];

/** Typed route for each venture section (params: { tenant, ventureId }). */
export const VENTURE_SECTION_ROUTES = {
  overview: '/$tenant/app/ventures/$ventureId/overview',
  coach: '/$tenant/app/ventures/$ventureId/coach',
  memory: '/$tenant/app/ventures/$ventureId/memory',
  evidence: '/$tenant/app/ventures/$ventureId/evidence',
  decisions: '/$tenant/app/ventures/$ventureId/decisions',
  experiments: '/$tenant/app/ventures/$ventureId/experiments',
  milestones: '/$tenant/app/ventures/$ventureId/milestones',
  documents: '/$tenant/app/ventures/$ventureId/documents',
  team: '/$tenant/app/ventures/$ventureId/team',
  escalations: '/$tenant/app/ventures/$ventureId/escalations',
} as const satisfies Record<VentureSectionId, string>;

export const EIR_SECTIONS = [
  { id: 'personas', label: 'Personas', icon: UserSquare, to: '/$tenant/app/eir/personas' },
  { id: 'reviews', label: 'Reviews', icon: ClipboardCheck, to: '/$tenant/app/eir/reviews' },
  { id: 'inbox', label: 'Inbox', icon: Inbox, to: '/$tenant/app/eir/inbox' },
] as const;

export const PROGRAM_SECTIONS = [
  { id: 'portfolio', label: 'Portfolio', icon: ChartColumn, to: '/$tenant/app/program/portfolio' },
  { id: 'ventures', label: 'Ventures', icon: Briefcase, to: '/$tenant/app/program/ventures' },
  { id: 'resources', label: 'Resources', icon: ListTree, to: '/$tenant/app/program/resources' },
  { id: 'escalations', label: 'Escalations', icon: Flag, to: '/$tenant/app/program/escalations' },
] as const;

export const ADMIN_SECTIONS = [
  { id: 'principals', label: 'Principals', icon: Users, to: '/admin/principals' },
  { id: 'settings', label: 'Settings', icon: Settings, to: '/admin/settings' },
  { id: 'usage', label: 'Usage', icon: Gauge, to: '/admin/usage' },
  { id: 'audit', label: 'Audit log', icon: ScrollText, to: '/admin/audit' },
] as const;
