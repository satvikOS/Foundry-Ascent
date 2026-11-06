import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { OverGlassContext } from '@/components/ui/glass-context';
import { InspectorPanel } from '@/components/ui/inspector-panel';
import { useLayerEscape } from '@/components/ui/layers';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';

/*
 * The right-hand panel of the venture workspace: the venture's context on New chat and in a conversation, the
 * memory detail on Knowledge. Pages FILL it; the VentureLayout HOSTS it:
 *
 *   // in a page under /v/$ventureId/…
 *   <Inspector title="Context" remember="context" defaultOpen>…</Inspector>
 *
 * The children are portalled into one detached DOM node that the layout moves between the desktop column
 * (≥ 1280 px: frosted glass floating at the right, the side panel's mirror) and a floating sheet over the content
 * (smaller screens), so page state survives the switch and there is no render loop between page and layout. On
 * desktop the person's last choice is remembered per panel (`remember`); a panel never opens by itself over the
 * content on a smaller screen. Only one <Inspector> should be mounted at a time.
 *
 * A conversation's panel opens by default from 1600 px only (`defaultOpen="wide"`): on a laptop (1280-1599 px) both
 * panels open would leave the conversation window little wider than its reading column (owner, 2026-11-06: the
 * window "larger"), so there the conversation starts in a wide window with the panel one click from its toggle (a
 * citation opens it too). New chat's panel stays open by default at every desktop width: the memory choice is in it.
 * Once the person opens or closes the panel, that choice is remembered at every width.
 */

/** Which remembered choice a panel uses: the venture context (New chat and conversations share it) or the rest. */
export type InspectorMemory = 'context' | 'default';

interface InspectorMeta {
  title: string;
  description?: string | undefined;
  remember: InspectorMemory;
  /** Open on desktop (true) or on a wide screen only ('wide', from 1600 px) until the person chooses. */
  defaultOpen: boolean | 'wide';
  /** The close button's and the toggle's name ("context panel"). */
  label: string;
}

interface InspectorContextValue {
  target: HTMLDivElement | null;
  meta: InspectorMeta | null;
  register: (meta: InspectorMeta) => () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  isDesktop: boolean;
}

const InspectorContext = createContext<InspectorContextValue | null>(null);

const STORAGE: Record<InspectorMemory, string> = {
  context: STORAGE_KEYS.contextPanelOpen,
  default: STORAGE_KEYS.inspectorOpen,
};

function storedChoice(memory: InspectorMemory): boolean | null {
  const value = safeStorage.get(STORAGE[memory]);
  return value === '1' ? true : value === '0' ? false : null;
}

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [target] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const node = document.createElement('div');
    node.dataset.slot = 'inspector-target';
    return node;
  });
  const [meta, setMeta] = useState<InspectorMeta | null>(null);
  const isDesktop = useMediaQuery(BREAKPOINTS.xl);
  const roomy = useMediaQuery(BREAKPOINTS.roomy);
  // The desktop choice per panel, read from storage once and kept here after a change.
  const [desktopChoice, setDesktopChoice] = useState<Partial<Record<InspectorMemory, boolean>>>(() => ({
    context: storedChoice('context') ?? undefined,
    default: storedChoice('default') ?? undefined,
  }));
  const [mobileOpen, setMobileOpen] = useState(false);

  const register = useCallback((next: InspectorMeta) => {
    setMeta(next);
    // A new page's panel starts closed over the content on a smaller screen.
    setMobileOpen(false);
    return () => {
      setMeta((current) => (current === next ? null : current));
    };
  }, []);

  const memory = meta?.remember ?? 'default';
  const desktopOpen =
    desktopChoice[memory] ?? (meta?.defaultOpen === true || (meta?.defaultOpen === 'wide' && roomy));

  const setOpen = useCallback(
    (open: boolean) => {
      if (isDesktop) {
        setDesktopChoice((current) => ({ ...current, [memory]: open }));
        safeStorage.set(STORAGE[memory], open ? '1' : '0');
      } else {
        setMobileOpen(open);
      }
    },
    [isDesktop, memory],
  );

  const value = useMemo<InspectorContextValue>(
    () => ({ target, meta, register, open: isDesktop ? desktopOpen : mobileOpen, setOpen, isDesktop }),
    [target, meta, register, isDesktop, desktopOpen, mobileOpen, setOpen],
  );

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

function useInspectorContext(): InspectorContextValue {
  const ctx = useContext(InspectorContext);
  if (!ctx)
    throw new Error('Inspector components must be rendered inside <InspectorProvider> (VentureLayout).');
  return ctx;
}

/** State and controls for custom triggers ("Show sources" buttons etc.). */
export function useInspector() {
  const { open, setOpen, meta, isDesktop } = useInspectorContext();
  return {
    open,
    setOpen,
    toggle: () => {
      setOpen(!open);
    },
    hasContent: meta !== null,
    /** How the page names its panel ("context panel"); null without one. */
    label: meta?.label ?? null,
    isDesktop,
  };
}

interface InspectorProps {
  title: string;
  description?: string;
  /** Which remembered open/closed choice the panel follows on desktop (default: the shared "default"). */
  remember?: InspectorMemory;
  /**
   * Open on desktop until the person closes it; 'wide': only from 1600 px, so a laptop keeps the room for the
   * conversation window.
   */
  defaultOpen?: boolean | 'wide';
  /** How the toggle names the panel ("context panel"); default: "<title> panel", lower case. */
  label?: string;
  children: ReactNode;
}

/** Page-side: declares inspector content for the current page. */
export function Inspector({
  title,
  description,
  remember = 'default',
  defaultOpen = false,
  label,
  children,
}: InspectorProps) {
  const { target, register } = useInspectorContext();
  const name = label ?? `${title.toLowerCase()} panel`;
  useEffect(
    () => register({ title, description, remember, defaultOpen, label: name }),
    [register, title, description, remember, defaultOpen, name],
  );
  return target ? createPortal(children, target) : null;
}

function MountTarget({ target }: { target: HTMLDivElement | null }) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && target && target.parentElement !== el) el.appendChild(target);
    },
    [target],
  );
  return <div ref={ref} className="contents" />;
}

/**
 * Layout-side: renders the panel. Desktop: frosted glass floating at the right, inset like the side panel, beside
 * the content (it never covers it). Smaller screens: a floating glass sheet from the right over a soft scrim (focus
 * trapped, Escape or a click outside closes it), so the conversation is never squeezed. Renders nothing if no
 * page filled it.
 */
export function InspectorRegion() {
  const { target, meta, open, setOpen, isDesktop } = useInspectorContext();
  // About (or any dialog) opened from the sheet takes Escape, even before Radix ranks it on top (layers.ts).
  const layer = useLayerEscape();
  if (!meta) return null;
  const close = () => {
    setOpen(false);
  };
  const closeLabel = `Hide ${meta.label}`;

  if (isDesktop) {
    if (!open) return null;
    return (
      <aside
        aria-label={meta.title}
        data-slot="context-panel"
        className="glass-float sticky top-[calc(var(--mini-call-height)+var(--panel-inset))] my-(--panel-inset) mr-(--panel-inset) hidden h-[calc(100dvh_-_var(--mini-call-height)_-_var(--status-banners-height)_-_2*var(--panel-inset))] w-(--inspector-width) shrink-0 self-start overflow-hidden rounded-(--radius-panel) xl:block"
      >
        <OverGlassContext.Provider value>
          <InspectorPanel
            title={meta.title}
            description={meta.description}
            onClose={close}
            closeLabel={closeLabel}
            className="bg-transparent"
          >
            <MountTarget target={target} />
          </InspectorPanel>
        </OverGlassContext.Provider>
      </aside>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="context-sheet-overlay"
          className="fixed inset-0 z-40 bg-(--scrim-soft) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="context-sheet"
          aria-describedby={undefined}
          {...layer.layerProps}
          onEscapeKeyDown={layer.onEscapeKeyDown}
          className={cn(
            'glass-float fixed z-50 flex flex-col overflow-hidden outline-none [--glass-float-face:var(--glass-float-bg-over)]',
            'top-[calc(0.5rem+env(safe-area-inset-top))] right-[calc(0.5rem+env(safe-area-inset-right))] bottom-[calc(0.5rem+env(safe-area-inset-bottom))] w-[min(calc(100vw-3.5rem),var(--inspector-width))] rounded-(--radius-sheet)',
            'md:top-(--panel-inset) md:right-(--panel-inset) md:bottom-(--panel-inset) md:rounded-(--radius-panel)',
            'duration-(--dur-panel) ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-4 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-4',
          )}
        >
          <DialogPrimitive.Title className="sr-only">{meta.title}</DialogPrimitive.Title>
          <OverGlassContext.Provider value>
            <InspectorPanel
              title={meta.title}
              description={meta.description}
              onClose={close}
              closeLabel={closeLabel}
              className="bg-transparent"
            >
              <MountTarget target={target} />
            </InspectorPanel>
          </OverGlassContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Button that opens/closes the panel (hidden when the page has no panel). */
export function InspectorToggle({ className }: { className?: string }) {
  const { meta, open, setOpen } = useInspectorContext();
  if (!meta) return null;
  const label = open ? `Hide ${meta.label}` : `Show ${meta.label}`;
  return (
    <SimpleTooltip content={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        className={className}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
      </Button>
    </SimpleTooltip>
  );
}
