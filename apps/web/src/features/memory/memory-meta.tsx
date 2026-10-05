import type { MemoryObjectView, MemoryType, SourceRef, Visibility } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import {
  Bot,
  Brain,
  FileText,
  Globe,
  Lock,
  MessagesSquare,
  PenLine,
  Pin,
  ScanText,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { formatPercent } from '@/lib/format';
import { MEMORY_TYPE_LABELS, VISIBILITY_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

/** Memory type as icon + label (neutral chip; type is not a status). */
export function MemoryTypeLabel({
  type,
  className,
  iconOnly = false,
}: {
  type: MemoryType;
  className?: string;
  iconOnly?: boolean;
}) {
  const def = MEMORY_TYPE_LABELS[type];
  const Icon = def.icon;
  if (iconOnly) {
    return (
      <span className={cn('inline-flex shrink-0 text-muted-foreground', className)} title={def.label}>
        <Icon aria-hidden className="size-4" />
        <span className="sr-only">{def.label}</span>
      </span>
    );
  }
  return (
    <span
      data-slot="memory-type"
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {def.label}
    </span>
  );
}

const VISIBILITY_ICONS: Record<Visibility, LucideIcon> = {
  founder_private: Lock,
  team: Users,
  venture: Globe,
  advisors: UserRound,
};

export function VisibilityLabel({ visibility, className }: { visibility: Visibility; className?: string }) {
  const Icon = VISIBILITY_ICONS[visibility];
  const def = VISIBILITY_LABELS[visibility];
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}
      title={def.description}
    >
      <Icon aria-hidden className="size-3.5" />
      {def.label}
    </span>
  );
}

/** 0–1 confidence as a five-segment meter plus a visible percentage (never colour alone). */
export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const clamped = Math.min(1, Math.max(0, value));
  const filled = Math.round(clamped * 5);
  const label = clamped >= 0.75 ? 'High' : clamped >= 0.45 ? 'Medium' : 'Low';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span aria-hidden className="flex items-center gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={cn('h-2 w-1.5 rounded-[1px]', i < filled ? 'bg-foreground/80' : 'bg-border-strong')}
          />
        ))}
      </span>
      <span className="tabular">
        {formatPercent(clamped)}
        <span className="sr-only"> confidence ({label.toLowerCase()})</span>
      </span>
    </span>
  );
}

export function PinnedMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium text-foreground', className)}>
      <Pin aria-hidden className="size-3.5" />
      Pinned
    </span>
  );
}

export function OriginLabel({ origin }: { origin: MemoryObjectView['origin'] }) {
  const map = {
    founder: { icon: PenLine, label: 'Added by the team' },
    ai: { icon: Bot, label: 'Suggested by Foundry Guide (AI)' },
    eir: { icon: UserRound, label: 'Added by an EIR' },
    import: { icon: FileText, label: 'Imported' },
  } satisfies Record<MemoryObjectView['origin'], { icon: LucideIcon; label: string }>;
  const def = map[origin];
  const Icon = def.icon;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
      {def.label}
    </span>
  );
}

const SOURCE_KIND: Record<SourceRef['kind'], { icon: LucideIcon; label: string }> = {
  session: { icon: MessagesSquare, label: 'Coaching session' },
  turn: { icon: MessagesSquare, label: 'Coach response' },
  document: { icon: FileText, label: 'Document' },
  chunk: { icon: ScanText, label: 'Document excerpt' },
  manual: { icon: PenLine, label: 'Added manually' },
  memory: { icon: Brain, label: 'Earlier memory' },
};

const linkClasses =
  'font-medium text-foreground underline decoration-border-strong underline-offset-[3px] hover:decoration-foreground';

/** Provenance: where a memory object came from, linking to the source when it lives in the workspace. */
export function SourceRefList({
  refs,
  tenant,
  ventureId,
  className,
}: {
  refs: readonly SourceRef[];
  tenant: string;
  ventureId: string;
  className?: string;
}) {
  if (refs.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No source recorded.</p>;
  }
  return (
    <ul className={cn('grid gap-1.5', className)}>
      {refs.map((ref, index) => {
        const def = SOURCE_KIND[ref.kind];
        const Icon = def.icon;
        const text = ref.label ?? def.label;
        let body = <span>{text}</span>;
        if (ref.kind === 'session') {
          body = (
            <Link
              to="/$tenant/app/ventures/$ventureId/coach/$sessionId"
              params={{ tenant, ventureId, sessionId: ref.id }}
              className={linkClasses}
            >
              {text}
            </Link>
          );
        } else if (ref.kind === 'document' || ref.kind === 'chunk') {
          body = (
            <Link
              to="/$tenant/app/ventures/$ventureId/documents"
              params={{ tenant, ventureId }}
              className={linkClasses}
            >
              {text}
            </Link>
          );
        } else if (ref.kind === 'memory') {
          body = (
            <Link
              to="/$tenant/app/ventures/$ventureId/memory"
              params={{ tenant, ventureId }}
              search={{ m: ref.id }}
              className={linkClasses}
            >
              {text}
            </Link>
          );
        }
        return (
          <li key={`${ref.kind}-${ref.id}-${index}`} className="flex items-start gap-2 text-[13px]">
            <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="sr-only">{def.label}: </span>
              {body}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
