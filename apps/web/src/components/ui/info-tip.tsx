import { Info } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useId, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface InfoTipProps {
  /** What the detail is about: the button reads "About {label}". */
  label: string;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/**
 * Detail a person rarely needs, behind a small info button instead of a paragraph on the page. It opens on
 * click, tap or Enter (a tooltip never opens on a phone), closes with Escape or a click elsewhere, and its
 * text is read as the button's description while closed, so a screen reader hears it without opening it.
 */
export function InfoTip({ label, children, side = 'bottom', align = 'start', className }: InfoTipProps) {
  const described = useId();
  return (
    <PopoverPrimitive.Root>
      <span id={described} hidden>
        {children}
      </span>
      <PopoverPrimitive.Trigger
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={described}
        data-slot="info-tip"
        className={cn(
          'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full align-middle text-subtle-foreground transition-colors',
          'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:text-foreground',
          className,
        )}
      >
        <Info aria-hidden className="size-4" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          data-slot="info-tip-content"
          className={cn(
            'glass-strong z-50 max-w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border px-3 py-2 text-small text-pretty text-popover-foreground shadow-lg',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
