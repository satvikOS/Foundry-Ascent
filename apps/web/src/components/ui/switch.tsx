import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/** On/off toggle. The thumb position (not only colour) shows the state; pair it with a visible label. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-input p-0.5 transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3.5 rounded-full shadow-xs ring-0 transition-transform',
          'data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-foreground/70',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
