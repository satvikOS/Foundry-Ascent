import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Primary and secondary actions (buttons or links). */
  action?: ReactNode;
  className?: string;
  /** Compact variant for cards and side panels. */
  size?: 'default' | 'sm';
  /** Heading level for the title (keep the document outline correct). */
  headingLevel?: 1 | 2 | 3 | 4;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = 'default',
  headingLevel = 3,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'default' ? 'gap-2 px-6 py-16' : 'gap-1.5 px-4 py-8',
        className,
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden
          className={cn('text-subtle-foreground', size === 'default' ? 'mb-1 size-6' : 'size-5')}
          strokeWidth={1.5}
        />
      ) : null}
      <Heading className={cn('font-medium tracking-tight', size === 'default' ? 'text-base' : 'text-sm')}>
        {title}
      </Heading>
      {description ? (
        <div className={cn('max-w-md text-muted-foreground', size === 'default' ? 'text-sm' : 'text-[13px]')}>
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
