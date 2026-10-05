import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-3', className)} {...props} />;
}

export function TabsList({
  className,
  variant = 'pill',
  ...props
}: ComponentProps<typeof TabsPrimitive.List> & { variant?: 'pill' | 'underline' }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        'inline-flex w-fit items-center text-muted-foreground',
        variant === 'pill' && 'h-9 gap-0.5 rounded-lg border border-border bg-muted p-0.5',
        variant === 'underline' && 'h-10 w-full justify-start gap-4 border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-full items-center justify-center gap-1.5 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
        'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
        // pill
        'in-data-[variant=pill]:rounded-md in-data-[variant=pill]:data-[state=active]:bg-card in-data-[variant=pill]:data-[state=active]:text-foreground in-data-[variant=pill]:data-[state=active]:shadow-xs',
        // underline (active state also gets a heavier weight, not just colour)
        'in-data-[variant=underline]:-mb-px in-data-[variant=underline]:border-b-2 in-data-[variant=underline]:border-transparent in-data-[variant=underline]:px-0.5',
        'in-data-[variant=underline]:data-[state=active]:border-foreground in-data-[variant=underline]:data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none focus-visible:outline-2 focus-visible:outline-ring', className)}
      {...props}
    />
  );
}
