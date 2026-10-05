import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { buttonVariants } from './button';
import { overlayClasses } from './dialog';

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogPrimitive.Overlay className={overlayClasses} />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4',
          'rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-xl outline-none',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] duration-150',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('grid gap-1.5', className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
  );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('text-base leading-tight font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
}

interface AlertDialogActionProps extends ComponentProps<typeof AlertDialogPrimitive.Action> {
  destructive?: boolean;
}

export function AlertDialogAction({ className, destructive = false, ...props }: AlertDialogActionProps) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant: destructive ? 'destructive' : 'default' }), className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: 'secondary' }), className)}
      {...props}
    />
  );
}
