import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;

/**
 * The scrim behind every modal: dims the page and, from tablet width up, softly blurs it (a full-screen
 * blur costs too much on phones). Modal panels on it are solid (they hold forms and body text), so glass
 * never stacks on glass; only floating layers (menus, popovers, the command palette, toasts) are glass.
 */
export const overlayClasses =
  'fixed inset-0 z-50 bg-(--scrim) sm:backdrop-blur-xs data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0';

/** The modal panel surface shared by dialogs and alert dialogs: solid, with a hairline edge. */
export const modalPanelClasses =
  'rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl outline-none';
/** A floating glass panel (the command palette): blur and translucency from `.glass-strong`. */
const glassPanelClasses = 'glass-strong rounded-2xl border text-popover-foreground shadow-xl outline-none';

function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(overlayClasses, className)}
      {...props}
    />
  );
}

interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hide the top-right close button (Escape still closes). */
  hideClose?: boolean;
  /**
   * `glass` for a floating panel that holds no long text (the command palette): the scrim then only dims,
   * so the panel's own blur is the one the eye reads and glass never sits on a blurred layer.
   */
  surface?: 'solid' | 'glass';
}

export function DialogContent({
  className,
  children,
  hideClose = false,
  surface = 'solid',
  ...props
}: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay
        data-surface={surface}
        className={surface === 'glass' ? 'bg-(--scrim-soft) sm:backdrop-blur-none' : undefined}
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-surface={surface}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto p-6',
          surface === 'glass' ? glassPanelClasses : modalPanelClasses,
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] duration-150',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className={cn(
              'absolute top-4 right-4 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground',
              'transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
            )}
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('grid gap-1.5 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-base leading-tight font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
