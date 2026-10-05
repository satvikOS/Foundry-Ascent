import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { overlayClasses } from './dialog';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const sheetVariants = cva(
  [
    'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-xl outline-none',
    'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300',
  ],
  {
    variants: {
      side: {
        right:
          'inset-y-0 right-0 h-full w-[min(100vw-2.5rem,26rem)] border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
        left: 'inset-y-0 left-0 h-full w-[min(100vw-2.5rem,18rem)] border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        bottom:
          'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-border data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

interface SheetContentProps
  extends ComponentProps<typeof SheetPrimitive.Content>, VariantProps<typeof sheetVariants> {
  hideClose?: boolean;
}

export function SheetContent({ className, children, side, hideClose = false, ...props }: SheetContentProps) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className={overlayClasses} />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <SheetPrimitive.Close
            className={cn(
              'absolute top-3.5 right-3.5 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground',
              'transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
            )}
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('grid gap-1 border-b border-border px-5 py-4 pr-12', className)} {...props} />;
}

export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex gap-2 border-t border-border px-5 py-3', className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title className={cn('text-[15px] font-semibold tracking-tight', className)} {...props} />
  );
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description className={cn('text-[13px] text-muted-foreground', className)} {...props} />
  );
}
