import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
          'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

interface SimpleTooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Disable the tooltip without changing the tree (e.g. when a label is already visible). */
  disabled?: boolean;
}

/**
 * Convenience wrapper. Tooltips are supplementary: the trigger must still have an accessible name
 * (visible text or aria-label). Content is shown on hover and keyboard focus and dismissible with Esc.
 */
export function SimpleTooltip({ content, children, side = 'top', disabled = false }: SimpleTooltipProps) {
  if (disabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}
