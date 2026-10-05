import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, Megaphone, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative grid w-full grid-cols-[auto_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-sm',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        info: 'border-info/40 bg-info/[0.07] text-foreground [&>svg]:text-info',
        success: 'border-success/40 bg-success/[0.07] text-foreground [&>svg]:text-success',
        warning: 'border-warning/45 bg-warning/[0.08] text-foreground [&>svg]:text-warning',
        destructive: 'border-destructive/45 bg-destructive/[0.07] text-foreground [&>svg]:text-destructive',
        disclosure:
          'border-dashed border-border-strong bg-muted/60 text-foreground [&>svg]:text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const DEFAULT_ICONS: Record<NonNullable<VariantProps<typeof alertVariants>['variant']>, LucideIcon> = {
  default: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  destructive: CircleAlert,
  disclosure: Megaphone,
};

interface AlertProps extends Omit<ComponentProps<'div'>, 'title'>, VariantProps<typeof alertVariants> {
  title?: ReactNode;
  icon?: LucideIcon | null;
  /** Right-aligned actions (buttons/links). */
  action?: ReactNode;
  /**
   * "alert" interrupts screen readers (use for errors that just appeared); "status" is polite;
   * "note" (default) is static content.
   */
  live?: 'alert' | 'status' | 'note';
}

/** Inline callout. Every variant carries an icon and text, so meaning never depends on colour. */
export function Alert({
  className,
  variant = 'default',
  title,
  icon,
  action,
  live = 'note',
  children,
  ...props
}: AlertProps) {
  const Icon = icon === null ? null : (icon ?? DEFAULT_ICONS[variant ?? 'default']);
  return (
    <div
      data-slot="alert"
      role={live === 'note' ? 'note' : live}
      className={cn(alertVariants({ variant }), !Icon && 'grid-cols-1', className)}
      {...props}
    >
      {Icon ? <Icon aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-0.5">
          {title ? <p className="leading-5 font-medium">{title}</p> : null}
          {children ? (
            <div className="leading-5 text-muted-foreground [&_p]:leading-5">{children}</div>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2 pt-1 sm:pt-0">{action}</div> : null}
      </div>
    </div>
  );
}
