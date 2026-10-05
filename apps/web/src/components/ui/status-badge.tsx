import type {
  ClaimKind,
  EscalationPriority,
  MemoryStatus,
  PersonaReleaseStatus,
  PersonaStatus,
  DocumentStatus,
  EscalationStatus,
  SessionStatus,
  VentureStatus,
} from '@foundry/contracts';
import {
  Archive,
  BadgeCheck,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
  CircleX,
  Clock,
  Diamond,
  FileClock,
  Hand,
  Hourglass,
  Lightbulb,
  LoaderCircle,
  OctagonAlert,
  Pencil,
  Quote,
  Send,
  Sparkles,
  SquareCheck,
  Trash,
  TriangleAlert,
  Undo2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { z } from 'zod';

import { cn } from '@/lib/utils';

/**
 * Status vocabulary for every stateful object in the product. Each status is conveyed by THREE
 * redundant cues so it never depends on colour alone (WCAG 1.4.1):
 *   1. a text label (always rendered, never hidden),
 *   2. an icon with a distinct silhouette (circle / triangle / octagon / diamond / square / dashed),
 *   3. a border shape (solid, dashed for pending/unconfirmed, dotted for inactive/ended).
 * Colour (tone) is a fourth, supplementary cue.
 */
export type StatusTone = 'neutral' | 'success' | 'warning' | 'destructive' | 'info' | 'primary';
export type StatusShape = 'solid' | 'dashed' | 'dotted' | 'filled';

export interface StatusDefinition {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
  shape: StatusShape;
  /** Longer explanation for tooltips and screen readers. */
  description: string;
}

type Defs<T extends string> = Record<T, StatusDefinition>;

type DbStatus = 'awake' | 'resuming' | 'unavailable';
type ResourceStatus = 'active' | 'stale' | 'retired';

export interface StatusKinds {
  memory: MemoryStatus;
  escalationPriority: EscalationPriority;
  escalationStatus: EscalationStatus;
  document: z.infer<typeof DocumentStatus>;
  persona: z.infer<typeof PersonaStatus>;
  personaRelease: z.infer<typeof PersonaReleaseStatus>;
  session: z.infer<typeof SessionStatus>;
  venture: z.infer<typeof VentureStatus>;
  resource: ResourceStatus;
  claim: ClaimKind;
  db: DbStatus;
}
export type StatusKind = keyof StatusKinds;

export const STATUS_DEFINITIONS: { [K in StatusKind]: Defs<StatusKinds[K]> } = {
  memory: {
    proposed: {
      label: 'Proposed',
      icon: CircleDashed,
      tone: 'warning',
      shape: 'dashed',
      description: 'Suggested from a session; waiting for founder approval before it is used as memory.',
    },
    confirmed: {
      label: 'Confirmed',
      icon: CircleCheck,
      tone: 'success',
      shape: 'solid',
      description: 'Approved by the venture team and used as trusted context.',
    },
    disputed: {
      label: 'Disputed',
      icon: TriangleAlert,
      tone: 'destructive',
      shape: 'solid',
      description: 'Someone flagged this as wrong or contested. It is not treated as fact.',
    },
    superseded: {
      label: 'Superseded',
      icon: Undo2,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Replaced by a newer version. Kept for history.',
    },
    expired: {
      label: 'Expired',
      icon: Clock,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Past its expiry date and no longer used.',
    },
    rejected: {
      label: 'Rejected',
      icon: CircleX,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Declined by the venture team. Never used as memory.',
    },
    deleted: {
      label: 'Deleted',
      icon: Trash,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Removed. Only the audit record remains.',
    },
  },
  escalationPriority: {
    P0: {
      label: 'P0 · Critical',
      icon: OctagonAlert,
      tone: 'destructive',
      shape: 'filled',
      description: 'Immediate human attention required.',
    },
    P1: {
      label: 'P1 · Urgent',
      icon: TriangleAlert,
      tone: 'warning',
      shape: 'solid',
      description: 'Needs a human response within one business day.',
    },
    P2: {
      label: 'P2 · Standard',
      icon: Diamond,
      tone: 'info',
      shape: 'solid',
      description: 'Routine expert review.',
    },
    P3: {
      label: 'P3 · Low',
      icon: CircleMinus,
      tone: 'neutral',
      shape: 'dashed',
      description: 'Low urgency; handle when convenient.',
    },
  },
  escalationStatus: {
    draft: {
      label: 'Draft',
      icon: Pencil,
      tone: 'neutral',
      shape: 'dashed',
      description: 'Being prepared; nothing has been shared yet.',
    },
    awaiting_consent: {
      label: 'Awaiting consent',
      icon: Hand,
      tone: 'warning',
      shape: 'dashed',
      description: 'Waiting for the founder to approve what is shared.',
    },
    awaiting_assignment: {
      label: 'Waiting for assignment',
      icon: Hourglass,
      tone: 'info',
      shape: 'dashed',
      description: 'The founder approved sharing; the program team will assign the right person.',
    },
    routed: {
      label: 'Routed',
      icon: Send,
      tone: 'info',
      shape: 'solid',
      description: 'Shared with the requested human role.',
    },
    acknowledged: {
      label: 'Acknowledged',
      icon: CircleDot,
      tone: 'info',
      shape: 'solid',
      description: 'A person has picked this up.',
    },
    resolved: {
      label: 'Resolved',
      icon: CircleCheck,
      tone: 'success',
      shape: 'solid',
      description: 'Closed with a resolution and next steps.',
    },
    declined: {
      label: 'Declined',
      icon: Ban,
      tone: 'destructive',
      shape: 'dotted',
      description: 'The assignee declined; see the reason.',
    },
    withdrawn: {
      label: 'Withdrawn',
      icon: Undo2,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Withdrawn by the founder.',
    },
  },
  document: {
    pending_upload: {
      label: 'Uploading',
      icon: Hourglass,
      tone: 'neutral',
      shape: 'dashed',
      description: 'Waiting for the file upload to finish.',
    },
    processing: {
      label: 'Processing',
      icon: LoaderCircle,
      tone: 'info',
      shape: 'dashed',
      description: 'Extracting text and building the search index.',
    },
    ready: {
      label: 'Ready',
      icon: CircleCheck,
      tone: 'success',
      shape: 'solid',
      description: 'Indexed and available as evidence.',
    },
    failed: {
      label: 'Failed',
      icon: TriangleAlert,
      tone: 'destructive',
      shape: 'solid',
      description: 'Processing failed. Retry or upload a different file.',
    },
    deleted: {
      label: 'Deleted',
      icon: Trash,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Removed from the venture.',
    },
  },
  persona: {
    draft: {
      label: 'Draft',
      icon: Pencil,
      tone: 'neutral',
      shape: 'dashed',
      description: 'Not released; cannot coach ventures.',
    },
    active: {
      label: 'Active',
      icon: CircleCheck,
      tone: 'success',
      shape: 'solid',
      description: 'Released and coaching assigned ventures.',
    },
    suspended: {
      label: 'Suspended',
      icon: CirclePause,
      tone: 'warning',
      shape: 'solid',
      description: 'Paused by a human. No new turns until resumed.',
    },
    retired: {
      label: 'Retired',
      icon: Archive,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Permanently out of service.',
    },
  },
  personaRelease: {
    draft: {
      label: 'Draft',
      icon: Pencil,
      tone: 'neutral',
      shape: 'dashed',
      description: 'Awaiting approval.',
    },
    approved: {
      label: 'Approved',
      icon: BadgeCheck,
      tone: 'success',
      shape: 'solid',
      description: 'Approved for use.',
    },
    superseded: {
      label: 'Superseded',
      icon: Undo2,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Replaced by a newer release.',
    },
    withdrawn: {
      label: 'Withdrawn',
      icon: CircleSlash,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Withdrawn before or after approval.',
    },
  },
  session: {
    active: {
      label: 'Active',
      icon: CircleDot,
      tone: 'success',
      shape: 'solid',
      description: 'In progress.',
    },
    ended: {
      label: 'Ended',
      icon: SquareCheck,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Finished; recap available.',
    },
    suspended: {
      label: 'Suspended',
      icon: CirclePause,
      tone: 'warning',
      shape: 'solid',
      description: 'Paused by a safety control.',
    },
  },
  venture: {
    active: {
      label: 'Active',
      icon: CircleDot,
      tone: 'success',
      shape: 'solid',
      description: 'Active venture.',
    },
    paused: {
      label: 'Paused',
      icon: CirclePause,
      tone: 'warning',
      shape: 'dashed',
      description: 'Temporarily paused.',
    },
    graduated: {
      label: 'Graduated',
      icon: BadgeCheck,
      tone: 'info',
      shape: 'solid',
      description: 'Graduated from the program.',
    },
    archived: {
      label: 'Archived',
      icon: Archive,
      tone: 'neutral',
      shape: 'dotted',
      description: 'Read-only archive.',
    },
  },
  resource: {
    active: {
      label: 'Current',
      icon: CircleCheck,
      tone: 'success',
      shape: 'solid',
      description: 'Up to date.',
    },
    stale: {
      label: 'Stale',
      icon: FileClock,
      tone: 'warning',
      shape: 'dashed',
      description: 'Not reviewed recently; verify before relying on it.',
    },
    retired: {
      label: 'Retired',
      icon: Archive,
      tone: 'neutral',
      shape: 'dotted',
      description: 'No longer offered.',
    },
  },
  claim: {
    fact: {
      label: 'Fact',
      icon: Quote,
      tone: 'success',
      shape: 'solid',
      description: 'Supported by cited evidence.',
    },
    inference: {
      label: 'Inference',
      icon: Workflow,
      tone: 'info',
      shape: 'solid',
      description: 'Reasoned from evidence; not directly stated in it.',
    },
    hypothesis: {
      label: 'Hypothesis',
      icon: Lightbulb,
      tone: 'warning',
      shape: 'dashed',
      description: 'Untested assumption worth validating.',
    },
    recommendation: {
      label: 'Recommendation',
      icon: Sparkles,
      tone: 'primary',
      shape: 'solid',
      description: 'Suggested next step; your decision.',
    },
  },
  db: {
    awake: {
      label: 'Workspace ready',
      icon: CircleCheck,
      tone: 'success',
      shape: 'solid',
      description: 'The database is awake.',
    },
    resuming: {
      label: 'Waking up',
      icon: LoaderCircle,
      tone: 'warning',
      shape: 'dashed',
      description: 'The database was paused to save cost and is resuming (about 15 seconds).',
    },
    unavailable: {
      label: 'Unavailable',
      icon: TriangleAlert,
      tone: 'destructive',
      shape: 'solid',
      description: 'The database cannot be reached right now.',
    },
  },
};

const TONE_CLASSES: Record<StatusTone, { base: string; filled: string }> = {
  neutral: {
    base: 'border-border-strong text-muted-foreground',
    filled: 'bg-muted-foreground text-background',
  },
  success: {
    base: 'border-success/45 bg-success/10 text-success',
    filled: 'bg-success text-success-foreground',
  },
  warning: {
    base: 'border-warning/45 bg-warning/10 text-warning',
    filled: 'bg-warning text-warning-foreground',
  },
  destructive: {
    base: 'border-destructive/45 bg-destructive/10 text-destructive',
    filled: 'bg-destructive-strong text-destructive-foreground',
  },
  info: { base: 'border-info/45 bg-info/10 text-info', filled: 'bg-info text-info-foreground' },
  primary: {
    base: 'border-foreground/35 bg-foreground/5 text-foreground',
    filled: 'bg-primary text-primary-foreground',
  },
};

const SHAPE_CLASSES: Record<StatusShape, string> = {
  solid: 'border-solid',
  dashed: 'border-dashed',
  dotted: 'border-dotted',
  filled: 'border-solid border-transparent',
};

function humanise(value: string): string {
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function getStatusDefinition<K extends StatusKind>(
  kind: K,
  status: StatusKinds[K] | string,
): StatusDefinition {
  const defs = STATUS_DEFINITIONS[kind] as Record<string, StatusDefinition | undefined>;
  return (
    defs[status] ?? {
      label: humanise(status),
      icon: CircleQuestionMark,
      tone: 'neutral',
      shape: 'dashed',
      description: 'Unrecognised status.',
    }
  );
}

export interface StatusBadgeProps<K extends StatusKind> {
  kind: K;
  status: StatusKinds[K];
  size?: 'sm' | 'md';
  /** Override the visible label (the icon and shape still come from the status). */
  label?: string;
  /** Adds the long description as a native title tooltip. */
  withTitle?: boolean;
  className?: string;
}

/**
 * Status indicator: icon + visible label + border shape (+ colour). Use it for every status in the
 * product so the vocabulary is consistent. Never render a coloured dot or colour-only chip instead.
 */
export function StatusBadge<K extends StatusKind>({
  kind,
  status,
  size = 'sm',
  label,
  withTitle = false,
  className,
}: StatusBadgeProps<K>) {
  const def = getStatusDefinition(kind, status);
  const Icon = def.icon;
  const tone = TONE_CLASSES[def.tone];
  const spinning = Icon === LoaderCircle;
  return (
    <span
      data-slot="status-badge"
      data-kind={kind}
      data-status={status}
      data-tone={def.tone}
      data-shape={def.shape}
      title={withTitle ? def.description : undefined}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-md border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-1.5 text-xs' : 'h-6 px-2 text-[13px]',
        SHAPE_CLASSES[def.shape],
        def.shape === 'filled' ? tone.filled : tone.base,
        className,
      )}
    >
      <Icon
        aria-hidden
        data-slot="status-icon"
        className={cn(
          size === 'sm' ? 'size-3' : 'size-3.5',
          'shrink-0',
          spinning && 'motion-safe:animate-spin',
        )}
        strokeWidth={2.25}
      />
      <span data-slot="status-label">{label ?? def.label}</span>
    </span>
  );
}
