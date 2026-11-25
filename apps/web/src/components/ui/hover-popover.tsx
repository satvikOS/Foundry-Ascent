import { Popover as PopoverPrimitive } from 'radix-ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useOverGlassClass } from '@/components/ui/glass-context';
import { cn } from '@/lib/utils';

/** Time on the trigger before it opens, and off it (or its panel) before it closes. */
const OPEN_MS = 180;
const CLOSE_MS = 160;

/** What the trigger element takes (spread onto a button or a link). */
export interface HoverPopoverTriggerProps {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

interface HoverPopoverProps {
  /** The panel's accessible name ("Source 2"). */
  label: string;
  /** The trigger: a button or a link that takes these props. */
  children: (props: HoverPopoverTriggerProps) => ReactElement;
  content: ReactNode;
  /** A click with a mouse or the keyboard (a tap shows the panel instead); left out, a click shows the panel too. */
  onActivate?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
}

/**
 * A small glass panel shown beside its trigger while it is hovered or focused from the keyboard, and on a tap where
 * there is no hover; it stays while the pointer is over it and closes with Escape (WCAG 1.4.13: dismissible,
 * hoverable, persistent). Focus never moves into it by itself on hover; a tap moves it in, so what it offers is next.
 */
export function HoverPopover({ label, children, content, onActivate, className }: HoverPopoverProps) {
  const overGlass = useOverGlassClass();
  const [open, setOpen] = useState<'hover' | 'tap' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<string>('');
  const anchor = useRef<HTMLSpanElement | null>(null);

  const schedule = useCallback((next: 'hover' | null) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        // A panel opened by a tap stays until it is closed.
        setOpen((current) => (current === 'tap' ? current : next));
      },
      next ? OPEN_MS : CLOSE_MS,
    );
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const triggerProps: HoverPopoverTriggerProps = {
    onPointerEnter: (event) => {
      if (event.pointerType === 'mouse') schedule('hover');
    },
    onPointerLeave: (event) => {
      if (event.pointerType === 'mouse') schedule(null);
    },
    onPointerDown: (event) => {
      pointer.current = event.pointerType;
    },
    onFocus: () => {
      // From the keyboard only: a press focuses too, and it has its own meaning.
      if (pointer.current === '') schedule('hover');
    },
    onBlur: () => {
      pointer.current = '';
      schedule(null);
    },
    onClick: (event) => {
      const touch = pointer.current === 'touch' || pointer.current === 'pen';
      pointer.current = '';
      clearTimeout(timer.current);
      if (onActivate && !touch) {
        setOpen(null);
        onActivate(event);
        return;
      }
      event.preventDefault();
      setOpen((current) => (current === 'tap' ? null : 'tap'));
    },
  };

  return (
    <PopoverPrimitive.Root
      open={open !== null}
      onOpenChange={(next) => {
        clearTimeout(timer.current);
        if (!next) setOpen(null);
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <span ref={anchor} className="inline">
          {children(triggerProps)}
        </span>
      </PopoverPrimitive.Anchor>
      {open === null ? null : (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            aria-label={label}
            data-slot="hover-popover"
            data-print="hide"
            sideOffset={6}
            collisionPadding={12}
            align="start"
            onOpenAutoFocus={(event) => {
              if (open === 'hover') event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (open === 'tap') anchor.current?.querySelector<HTMLElement>('button, a')?.focus();
            }}
            onInteractOutside={(event) => {
              if (event.target instanceof Node && anchor.current?.contains(event.target))
                event.preventDefault();
            }}
            onPointerEnter={() => {
              clearTimeout(timer.current);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') schedule(null);
            }}
            className={cn(
              'glass-strong z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border p-3.5 text-left text-small text-popover-foreground shadow-glass outline-none',
              'animate-in fade-in-0',
              overGlass,
              className,
            )}
          >
            {content}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </PopoverPrimitive.Root>
  );
}
