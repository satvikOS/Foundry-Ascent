import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}

interface CommandDialogProps extends ComponentProps<typeof Dialog> {
  title?: string;
  description?: string;
  children: ReactNode;
  /** Forwarded to cmdk (e.g. a custom filter or `shouldFilter={false}`). */
  commandProps?: ComponentProps<typeof CommandPrimitive>;
}

export function CommandDialog({
  title = 'Command palette',
  description = 'Search for a page or action, then press Enter.',
  children,
  commandProps,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        hideClose
        className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:top-[18vh]"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          loop
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
          {...commandProps}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-12 items-center gap-2.5 border-b border-border px-4"
    >
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-full w-full bg-transparent text-[15px] outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[min(60vh,420px)] scroll-py-2 overflow-x-hidden overflow-y-auto p-2', className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-10 text-center text-sm text-muted-foreground"
      {...props}
    />
  );
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn('overflow-hidden text-foreground [&+&]:mt-1', className)}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('-mx-2 my-1 h-px bg-border', className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'relative flex h-10 cursor-default items-center gap-3 rounded-md px-2.5 text-sm outline-none select-none',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)} {...props} />
  );
}
