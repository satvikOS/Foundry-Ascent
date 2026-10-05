import { createLink } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SubNavAnchorProps extends ComponentProps<'a'> {
  icon?: LucideIcon;
  /** Optional count/badge shown after the label. */
  badge?: ReactNode;
}

function SubNavAnchor({ icon: Icon, badge, className, children, ...props }: SubNavAnchorProps) {
  return (
    <a
      {...props}
      className={cn(
        'group relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors',
        'hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        // Active: foreground text + 2px underline bar (shape, not colour alone) + aria-current from the router.
        'data-[status=active]:text-foreground',
        'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent data-[status=active]:after:bg-foreground',
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden className="size-4 opacity-80 group-data-[status=active]:opacity-100" />
      ) : null}
      {children}
      {badge}
    </a>
  );
}

/** Router-aware tab link for secondary navigation (typed `to`/`params` like <Link>). */
export const SubNavLink = createLink(SubNavAnchor);

/** Horizontal, scrollable secondary navigation bar (venture sections, console areas). */
export function SubNav({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <nav aria-label={label} className={cn('-mb-px overflow-x-auto [scrollbar-width:none]', className)}>
      <div className="flex min-w-max items-center gap-0.5">{children}</div>
    </nav>
  );
}
