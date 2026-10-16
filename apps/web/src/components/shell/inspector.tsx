import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { InspectorPanel } from '@/components/ui/inspector-panel';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';

/*
 * Right-hand context panel for the venture workspace (sources, memory detail, handoffs). Closed by
 * default: it opens from a citation, a selection or the page's panel toggle, and on desktop the
 * person's last choice is remembered. Pages FILL it; the VentureLayout HOSTS it:
 *
 *   // in a page under /v/$ventureId/…
 *   <Inspector title="Evidence" description="Sources used in this answer">
 *     <InspectorSection title="Sources" meta={3}>…</InspectorSection>
 *   </Inspector>
 *
 * The children are portalled into one detached DOM node that the layout moves between the desktop
 * column (≥ 1280 px) and a right-hand sheet (smaller screens), so page state survives the switch and
 * there is no render loop between page and layout. Only one <Inspector> should be mounted at a time.
 */

interface InspectorMeta {
  title: string;
  description?: string | undefined;
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

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [target] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const node = document.createElement('div');
    node.dataset.slot = 'inspector-target';
    return node;
  });
  const [meta, setMeta] = useState<InspectorMeta | null>(null);
  const isDesktop = useMediaQuery(BREAKPOINTS.xl);
  const [desktopOpen, setDesktopOpen] = useState(() => safeStorage.get(STORAGE_KEYS.inspectorOpen) === '1');
  const [mobileOpen, setMobileOpen] = useState(false);

  const register = useCallback((next: InspectorMeta) => {
    setMeta(next);
    return () => {
      setMeta((current) => (current === next ? null : current));
    };
  }, []);

  const setOpen = useCallback(
    (open: boolean) => {
      if (isDesktop) {
        setDesktopOpen(open);
        safeStorage.set(STORAGE_KEYS.inspectorOpen, open ? '1' : '0');
      } else {
        setMobileOpen(open);
      }
    },
    [isDesktop],
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
    isDesktop,
  };
}

interface InspectorProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/** Page-side: declares inspector content for the current page. */
export function Inspector({ title, description, children }: InspectorProps) {
  const { target, register } = useInspectorContext();
  useEffect(() => register({ title, description }), [register, title, description]);
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

/** Layout-side: renders the inspector column (desktop) or sheet (mobile). Renders nothing if no page filled it. */
export function InspectorRegion() {
  const { target, meta, open, setOpen, isDesktop } = useInspectorContext();
  if (!meta) return null;

  if (isDesktop) {
    if (!open) return null;
    return (
      <aside
        aria-label={`${meta.title} inspector`}
        className="sticky top-(--mini-call-height) hidden h-[calc(100dvh_-_var(--mini-call-height))] w-(--inspector-width) shrink-0 border-l border-border bg-background xl:block"
      >
        <InspectorPanel
          title={meta.title}
          description={meta.description}
          onClose={() => {
            setOpen(false);
          }}
        >
          <MountTarget target={target} />
        </InspectorPanel>
      </aside>
    );
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="p-0" hideClose>
        <SheetTitle className="sr-only">{meta.title}</SheetTitle>
        <SheetDescription className="sr-only">
          {meta.description ?? `${meta.title} for this page`}
        </SheetDescription>
        <InspectorPanel
          title={meta.title}
          description={meta.description}
          onClose={() => {
            setOpen(false);
          }}
        >
          <MountTarget target={target} />
        </InspectorPanel>
      </SheetContent>
    </Sheet>
  );
}

/** Page-header button that opens/closes the context panel (hidden when the page has no panel). */
export function InspectorToggle({ className }: { className?: string }) {
  const { meta, open, setOpen } = useInspectorContext();
  if (!meta) return null;
  const label = open ? `Hide ${meta.title.toLowerCase()} panel` : `Show ${meta.title.toLowerCase()} panel`;
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
