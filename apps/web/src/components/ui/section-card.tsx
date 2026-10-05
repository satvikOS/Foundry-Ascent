import type { LucideIcon } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SectionCardProps extends Omit<ComponentProps<'section'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned header actions (e.g. "View all"). */
  actions?: ReactNode;
  /** Footer row. */
  footer?: ReactNode;
  /** Remove body padding (for tables and lists that run edge to edge). */
  flush?: boolean;
  headingLevel?: 2 | 3;
}

/** A titled, landmark-labelled card section for dashboards and detail pages. */
export function SectionCard({
  title,
  description,
  icon: Icon,
  actions,
  footer,
  flush = false,
  headingLevel = 2,
  className,
  children,
  ...props
}: SectionCardProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      data-slot="section-card"
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm',
        className,
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon ? <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
          <div className="min-w-0">
            <Heading id={headingId} className="text-sm leading-5 font-semibold tracking-tight">
              {title}
            </Heading>
            {description ? <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className={cn('flex-1', !flush && 'px-5 py-4')}>{children}</div>
      {footer ? <div className="border-t border-border px-5 py-3">{footer}</div> : null}
    </section>
  );
}
