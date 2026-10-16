import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Skeleton } from './skeleton';

interface PageSectionProps extends Omit<ComponentProps<'section'>, 'title'> {
  /** Small mono label above the title (e.g. "AI notes"). */
  label?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions for the section. */
  actions?: ReactNode;
  headingLevel?: 2 | 3;
}

/**
 * An editorial section of a page: small label → title → description → body, divided from the section
 * before it by a hairline rule instead of a card. Named by its title, so it is a landmark region.
 */
export function PageSection({
  label,
  title,
  description,
  actions,
  headingLevel = 2,
  className,
  children,
  ...props
}: PageSectionProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      data-slot="page-section"
      aria-labelledby={headingId}
      className={cn('grid gap-4 border-t border-border pt-6 first:border-t-0 first:pt-0', className)}
      {...props}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1.5">
          {label ? <p className="label-mono">{label}</p> : null}
          <Heading
            id={headingId}
            className={cn(
              'font-serif font-normal text-balance',
              headingLevel === 2 ? 'text-subheading' : 'text-[1.0625rem] leading-snug',
            )}
          >
            {title}
          </Heading>
          {description ? (
            <p className="max-w-[64ch] text-small text-pretty text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Placeholder rows while a hairline list loads (announced once as busy). */
export function HairlineSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div aria-busy="true" className="divide-y divide-border border-y border-border">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid gap-2 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}
