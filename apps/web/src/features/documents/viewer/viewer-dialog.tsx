import './viewer.css';

import { type DocumentView } from '@foundry/contracts';
import { type SourceTextResponse } from '@foundry/contracts/viewer';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  FileType,
  MoveHorizontal,
  Quote,
  Search,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { getStatusDefinition } from '@/components/ui/status-badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { documentFileQueryOptions, fetchDocumentDownload } from '@/lib/api/hooks/document-viewer';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { isStaleUpload } from '@/lib/api/hooks/documents';
import { formatBytes, formatRelative } from '@/lib/format';
import { documentFailureMessage } from '@/lib/labels';
import { safeStorage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { sentenceStart, useVeirName } from '@/features/venture/veir-name';

import { MAX_FIND_MATCHES } from './find';
import { scrollBehavior } from './motion';
import type { PdfReport } from './pdf-reader';
import { PassagesReader, type ReaderReport, TextReader } from './text-reader';
import {
  documentKind,
  hasStoredFile,
  useCitedPassage,
  useDocumentBody,
  useExtractedText,
  useViewerSubject,
  type DocumentKind,
} from './viewer-subject';
import type { ViewerTarget } from './viewer-search';

const PdfReader = lazy(() => import('./pdf-reader'));

/** Reading text sizes (px); the default is the platform's reading size. */
export const TEXT_SIZES = [14, 15, 17, 19, 21, 24] as const;
const DEFAULT_TEXT_SIZE = 2;
/** PDF zoom steps (a multiple of fit-to-width). */
export const PDF_ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const;
const PDF_ZOOM_SMALLEST = 0.5;
const PDF_ZOOM_LARGEST = 4;
const PREF_TEXT_SIZE = 'fa.viewer.text-size';
const PREF_WIDE = 'fa.viewer.wide';

const KIND: Record<DocumentKind, { label: string; icon: LucideIcon }> = {
  pdf: { label: 'PDF', icon: FileType },
  markdown: { label: 'Markdown', icon: FileText },
  plain: { label: 'Text', icon: FileText },
  word: { label: 'Word', icon: FileText },
};

function storedTextSize(): number {
  const raw = safeStorage.get(PREF_TEXT_SIZE);
  if (raw === null) return DEFAULT_TEXT_SIZE;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value < TEXT_SIZES.length ? value : DEFAULT_TEXT_SIZE;
}

const SCOPE_LABEL: Record<SourceTextResponse['source']['scope'], string> = {
  venture: 'Venture document',
  program: 'Program guidance',
  public: 'Public material',
  persona: 'Library',
};

interface DialogProps {
  ventureId: string;
  target: ViewerTarget;
  onClose: () => void;
  /** Where focus goes when the viewer closes. */
  returnFocus: HTMLElement | null;
}

/** Whether `element` has keyboard focus (it shows a focus ring): the viewer was opened from the keyboard. */
function keyboardFocused(element: HTMLElement | null): boolean {
  if (element === null || document.activeElement !== element) return false;
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * The document viewer: a reading panel over a dimmed, blurred page (full screen on a phone), with the
 * file's name in the platform's display face, find (⌘F / Ctrl+F), text size or zoom, a wider page, PDF page
 * navigation, the cited passage marked, and download. Escape, Close and Back close it; focus stays inside
 * while it is open and returns to what opened it.
 */
export default function DocumentViewerDialog({ ventureId, target, onClose, returnFocus }: DialogProps) {
  const subject = useViewerSubject(ventureId, target);
  const veirName = useVeirName(ventureId);
  // One set of controls: in the top bar on a wide screen, in a bottom toolbar on a phone.
  const desktop = useMediaQuery(BREAKPOINTS.md, true);
  const findInputId = useId();

  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const query = useDeferredValue(findOpen ? findText : '');
  const [active, setActive] = useState(0);
  const [report, setReport] = useState<ReaderReport>({ matches: 0, cited: false });
  const [pdf, setPdf] = useState<PdfReport | null>(null);
  const [textSize, setTextSize] = useState(storedTextSize);
  const [wide, setWide] = useState(() => safeStorage.get(PREF_WIDE) === '1');
  const [zoom, setZoom] = useState(1);
  const [jump, setJump] = useState(0);
  const [pageRequest, setPageRequest] = useState<{ page: number; seq: number } | null>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  /**
   * The viewer focuses the text itself when it opens (arrow keys scroll at once). Opened by a pointer or a link,
   * that focus shows no ring; opened from the keyboard, or once focus has left the text and come back, it does.
   */
  const [quietFocus, setQuietFocus] = useState(() => !keyboardFocused(returnFocus));
  /** A download that could not start (said at the bottom, where the document's status shows). */
  const [notice, setNotice] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const header = useRef<HTMLDivElement | null>(null);
  /** The bottom bar (a phone's toolbar) or dock (a wide screen's status and page pills), once it shows. */
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const findInput = useRef<HTMLInputElement | null>(null);

  const document_ = subject.state === 'document' ? subject.document : null;
  const kind = document_ ? documentKind(document_.contentType) : null;
  const isPdf = kind === 'pdf';
  const passageId = target.passageId;
  const matches = isPdf ? (pdf?.matches ?? 0) : report.matches;
  const citedShown = isPdf ? (pdf?.cited ?? false) : report.cited;

  const onReport = useCallback((next: ReaderReport) => {
    setReport((prev) => (prev.matches === next.matches && prev.cited === next.cited ? prev : next));
  }, []);
  const onPdfReport = useCallback((next: PdfReport) => {
    setPdf(next);
  }, []);

  // The bars are glass over the page: the page scrolls under them, padded by their height (and by the
  // floating dock at the bottom of a wide screen, so the end of the page can scroll clear of it).
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const measure = () => {
      el.style.setProperty('--viewer-header', `${String(header.current?.offsetHeight ?? 56)}px`);
      const bottom = footer?.offsetHeight ?? 0;
      el.style.setProperty('--viewer-footer', `${String(bottom > 0 && desktop ? bottom + 20 : bottom)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (header.current) observer.observe(header.current);
    if (footer) observer.observe(footer);
    return () => {
      observer.disconnect();
    };
  }, [desktop, footer]);

  // A new query starts at its first match.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Text views: the match in focus is marked and brought into view.
  useEffect(() => {
    if (isPdf || !scrollRoot) return;
    scrollRoot.querySelectorAll('mark[data-active]').forEach((mark) => {
      mark.removeAttribute('data-active');
    });
    if (query.trim() === '' || matches === 0) return;
    // The active match is the n-th mark in reading order (a long document is rendered in parts).
    const mark = scrollRoot.querySelectorAll<HTMLElement>('mark[data-find-index]')[active];
    if (!mark) return;
    mark.dataset.active = 'true';
    mark.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  }, [isPdf, scrollRoot, query, active, matches]);

  // Text views: open at the cited passage, and go back to it on request.
  const openedAtCited = useRef(false);
  useEffect(() => {
    if (isPdf || !scrollRoot || !report.cited) return;
    if (openedAtCited.current && jump === 0) return;
    openedAtCited.current = true;
    scrollRoot
      .querySelector('[data-cited]')
      ?.scrollIntoView({ block: 'start', behavior: jump === 0 ? 'auto' : scrollBehavior() });
  }, [isPdf, scrollRoot, report.cited, jump]);

  // ⌘F / Ctrl+F (again) puts the cursor in the find field, its text selected.
  const [findFocus, setFindFocus] = useState(0);
  useEffect(() => {
    if (findFocus === 0) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [findFocus]);
  const openFind = () => {
    setFindOpen(true);
    setFindFocus((n) => n + 1);
  };
  // Closing find returns to the text (keyboard scrolling goes on where the reader was).
  const closeFind = () => {
    setFindOpen(false);
    scrollRoot?.focus({ preventScroll: true });
  };
  const step = (delta: number) => {
    if (matches === 0) return;
    setActive((current) => (current + delta + matches) % matches);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
    }
  };

  const setSize = (index: number) => {
    const next = Math.max(0, Math.min(TEXT_SIZES.length - 1, index));
    setTextSize(next);
    safeStorage.set(PREF_TEXT_SIZE, String(next));
  };
  const zoomIndex = PDF_ZOOMS.findIndex((z) => z >= zoom - 0.001);
  const zoomBy = (direction: 1 | -1) => {
    const current = zoomIndex === -1 ? PDF_ZOOMS.length - 1 : zoomIndex;
    const exact = PDF_ZOOMS[current] !== undefined && Math.abs((PDF_ZOOMS[current] ?? 0) - zoom) < 0.001;
    const next = direction === 1 ? (exact ? current + 1 : current) : current - 1;
    const value = PDF_ZOOMS[Math.max(0, Math.min(PDF_ZOOMS.length - 1, next))];
    if (value !== undefined) setZoom(value);
  };
  const toggleWide = () => {
    setWide((current) => {
      safeStorage.set(PREF_WIDE, current ? '0' : '1');
      return !current;
    });
  };
  const goToPage = (page: number) => {
    setPageRequest((prev) => ({ page, seq: (prev?.seq ?? 0) + 1 }));
  };

  const size = TEXT_SIZES[textSize] ?? 17;
  const sizeLabel = isPdf
    ? `${String(Math.round(zoom * 100))}%`
    : `${String(Math.round((size / 17) * 100))}%`;
  const smaller = isPdf ? zoom <= PDF_ZOOM_SMALLEST : textSize === 0;
  const larger = isPdf ? zoom >= PDF_ZOOM_LARGEST : textSize === TEXT_SIZES.length - 1;

  const title =
    subject.state === 'document'
      ? subject.document.filename
      : subject.state === 'source'
        ? subject.text.source.title
        : subject.state === 'missing'
          ? 'Document unavailable'
          : 'Document';
  const Icon = kind ? KIND[kind].icon : FileText;

  const findStatus =
    query.trim() === ''
      ? ''
      : isPdf && pdf && !pdf.textReady
        ? 'Searching…'
        : matches === 0
          ? 'No matches'
          : `${String(active + 1)} of ${String(matches)}${matches >= MAX_FIND_MATCHES ? '+' : ''}`;

  const sizeControls = (
    <SizeControls
      pdf={isPdf}
      label={sizeLabel}
      smallerDisabled={smaller}
      largerDisabled={larger}
      onSmaller={() => {
        if (isPdf) zoomBy(-1);
        else setSize(textSize - 1);
      }}
      onLarger={() => {
        if (isPdf) zoomBy(1);
        else setSize(textSize + 1);
      }}
    />
  );
  const citedButton =
    passageId !== null && citedShown ? (
      <Button
        variant="subtle"
        size={desktop ? 'sm' : 'icon-sm'}
        onClick={() => {
          setJump((n) => n + 1);
        }}
        aria-label="Jump to cited passage"
      >
        <Quote aria-hidden />
        {desktop ? 'Cited passage' : null}
      </Button>
    ) : null;
  // A phone's toolbar keeps to what fits its width: no separate tab there (Download opens the file).
  const fileActions =
    document_ && hasStoredFile(document_) ? (
      <FileActions document={document_} newTab={isPdf && desktop} onError={setNotice} />
    ) : null;
  const statusLine = document_ ? documentStatus(document_, veirName) : null;
  const status = statusLine ? (
    <p
      role="status"
      className={cn('text-small', statusLine.failed ? 'text-destructive' : 'text-muted-foreground')}
    >
      {statusLine.text}
    </p>
  ) : null;
  const noticeLine = notice ? (
    <p role="alert" className="text-small text-destructive">
      {notice}
    </p>
  ) : null;
  const pageCount = pdf?.pages ?? 0;
  const pageNav =
    isPdf && pageCount > 0 ? (
      <PageNav
        page={pdf?.page ?? 1}
        pages={pageCount}
        onPrevious={() => {
          goToPage(Math.max(1, (pdf?.page ?? 1) - 1));
        }}
        onNext={() => {
          goToPage(Math.min(pageCount, (pdf?.page ?? 1) + 1));
        }}
      />
    ) : null;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="viewer-overlay fixed inset-0 z-50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          ref={panel}
          aria-modal="true"
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            scrollRoot?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (findOpen) {
              event.preventDefault();
              closeFind();
            }
          }}
          className="viewer-panel"
        >
          <div
            ref={setScrollRoot}
            tabIndex={0}
            role="region"
            aria-label={title}
            data-viewer-scroll
            data-quiet-focus={quietFocus ? '' : undefined}
            onBlur={(event) => {
              if (event.target === event.currentTarget) setQuietFocus(false);
            }}
            className="viewer-scroll"
          >
            <ViewerBody
              ventureId={ventureId}
              subject={subject}
              target={target}
              veirName={veirName}
              query={query}
              activeMatch={active}
              size={size}
              wide={wide}
              zoom={zoom}
              jump={jump}
              pageRequest={pageRequest}
              scrollRoot={scrollRoot}
              onReport={onReport}
              onPdfReport={onPdfReport}
              onZoom={setZoom}
              onRetryClose={onClose}
              onNotice={setNotice}
            />
          </div>

          <div ref={header} className="glass-strong absolute inset-x-0 top-0 z-20 border-b">
            <div className="flex h-14 items-center gap-3 pr-2 pl-4">
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="grid min-w-0 flex-1 leading-tight">
                <DialogPrimitive.Title
                  className="truncate font-serif text-subheading font-medium tracking-tight"
                  title={title}
                >
                  {title}
                </DialogPrimitive.Title>
                <Meta subject={subject} veirName={veirName} />
              </div>
              {desktop ? (
                <div className="flex items-center gap-1">
                  {citedButton}
                  <IconButton
                    label="Find in document"
                    hint="Find (⌘F)"
                    icon={Search}
                    pressed={findOpen}
                    onClick={() => {
                      if (findOpen) closeFind();
                      else openFind();
                    }}
                  />
                  {sizeControls}
                  <IconButton
                    label="Wide page"
                    hint={wide ? 'Narrower page' : 'Wider page'}
                    icon={MoveHorizontal}
                    pressed={wide}
                    onClick={toggleWide}
                  />
                  {fileActions ? <span aria-hidden className="mx-0.5 h-5 w-px bg-border" /> : null}
                  {fileActions}
                </div>
              ) : null}
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close" className="ml-1">
                  <X aria-hidden />
                </Button>
              </DialogPrimitive.Close>
            </div>
            {findOpen ? (
              <div className="flex h-12 items-center gap-2 border-t px-4">
                <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <label htmlFor={findInputId} className="sr-only">
                  Find in document
                </label>
                <input
                  ref={findInput}
                  id={findInputId}
                  type="search"
                  value={findText}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Find in document"
                  onChange={(event) => {
                    setFindText(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      step(event.shiftKey ? -1 : 1);
                    }
                  }}
                  className="h-9 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle-foreground"
                />
                <span
                  role="status"
                  aria-live="polite"
                  className="tabular shrink-0 text-small text-foreground"
                >
                  {findStatus}
                </span>
                <IconButton
                  label="Previous match"
                  icon={ChevronLeft}
                  disabled={matches === 0}
                  onClick={() => {
                    step(-1);
                  }}
                />
                <IconButton
                  label="Next match"
                  icon={ChevronRight}
                  disabled={matches === 0}
                  onClick={() => {
                    step(1);
                  }}
                />
                <IconButton label="Close find" icon={X} onClick={closeFind} />
              </div>
            ) : null}
          </div>

          {desktop && (pageNav || status || noticeLine) ? (
            <div ref={setFooter} className="viewer-pill-dock" data-viewer-dock>
              {status || noticeLine ? (
                <div className="glass-strong viewer-pill viewer-status-pill rounded-2xl border px-3.5 py-1.5 shadow-lg">
                  {status}
                  {noticeLine}
                </div>
              ) : null}
              {pageNav ? (
                <div className="glass-strong viewer-pill rounded-full border px-1.5 py-1 shadow-lg">
                  {pageNav}
                </div>
              ) : null}
            </div>
          ) : null}

          {desktop ? null : (
            <div
              ref={setFooter}
              className="glass-strong viewer-toolbar absolute inset-x-0 bottom-0 z-20 border-t"
              data-viewer-dock
            >
              {status || noticeLine ? (
                <div className="border-b px-4 py-2">
                  {status}
                  {noticeLine}
                </div>
              ) : null}
              <div
                role="toolbar"
                aria-label="Document controls"
                className="viewer-toolbar-row flex h-14 items-center justify-between gap-1 overflow-x-auto px-2"
              >
                <IconButton
                  label="Find in document"
                  icon={Search}
                  pressed={findOpen}
                  onClick={() => {
                    if (findOpen) closeFind();
                    else openFind();
                  }}
                />
                {sizeControls}
                {pageNav}
                {citedButton}
                {fileActions}
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function IconButton({
  label,
  hint,
  icon: Icon,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <SimpleTooltip content={hint ?? label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(pressed && 'bg-accent text-foreground')}
      >
        <Icon aria-hidden />
      </Button>
    </SimpleTooltip>
  );
}

function SizeControls({
  pdf,
  label,
  smallerDisabled,
  largerDisabled,
  onSmaller,
  onLarger,
}: {
  pdf: boolean;
  label: string;
  smallerDisabled: boolean;
  largerDisabled: boolean;
  onSmaller: () => void;
  onLarger: () => void;
}) {
  return (
    <div role="group" aria-label={pdf ? 'Zoom' : 'Text size'} className="flex items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={pdf ? 'Zoom out' : 'Smaller text'}
        disabled={smallerDisabled}
        onClick={onSmaller}
        className="font-serif text-[13px]"
      >
        {pdf ? <ZoomOut aria-hidden /> : <span aria-hidden>A−</span>}
      </Button>
      <span className="viewer-size-label tabular text-center text-caption text-foreground" aria-live="polite">
        {label}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={pdf ? 'Zoom in' : 'Larger text'}
        disabled={largerDisabled}
        onClick={onLarger}
        className="font-serif text-[15px]"
      >
        {pdf ? <ZoomIn aria-hidden /> : <span aria-hidden>A+</span>}
      </Button>
    </div>
  );
}

function PageNav({
  page,
  pages,
  onPrevious,
  onNext,
}: {
  page: number;
  pages: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div role="group" aria-label="Pages" className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={onPrevious}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span className="viewer-page-label tabular text-center text-small text-foreground" aria-live="polite">
        <span className="sr-only">Page </span>
        {page} / {pages}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={page >= pages} onClick={onNext}>
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}

/** "PDF · 2.1 MB · Maya, 3 days ago" for a document; the kind of source and its freshness otherwise. */
function Meta({ subject, veirName }: { subject: ReturnType<typeof useViewerSubject>; veirName: string }) {
  let text: string | null = null;
  if (subject.state === 'document') {
    const doc = subject.document;
    text = `${KIND[documentKind(doc.contentType)].label} · ${formatBytes(doc.sizeBytes)} · ${doc.uploadedBy.displayName}, ${formatRelative(doc.createdAt)}`;
  } else if (subject.state === 'source') {
    const { scope, freshnessAt } = subject.text.source;
    const label = scope === 'persona' ? `${veirName}’s library` : SCOPE_LABEL[scope];
    text = `${label} · Updated ${formatRelative(freshnessAt)}`;
  }
  return (
    <DialogPrimitive.Description className="truncate text-caption text-muted-foreground">
      {text ?? ''}
    </DialogPrimitive.Description>
  );
}

/**
 * Where a document that is not ready is: uploading, being processed, or what went wrong (null when it is
 * ready). Shown at the bottom of the viewer.
 */
function documentStatus(doc: DocumentView, veirName: string): { text: string; failed: boolean } | null {
  if (doc.status === 'ready') return null;
  const stale = isStaleUpload(doc);
  const failed = doc.status === 'failed' || stale;
  const text = failed
    ? documentFailureMessage(stale ? 'upload_incomplete' : doc.failureReason)
    : doc.status === 'processing'
      ? `${getStatusDefinition('document', 'processing').label}. ${sentenceStart(veirName)} can cite it once it’s ready.`
      : `${getStatusDefinition('document', doc.status).label}…`;
  return { text, failed };
}

/** Follows a short-lived link to a document's file: in a new tab, or (a download) where the page is. */
function followFileLink(url: string, newTab: boolean, filename: string): void {
  if (newTab) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.download = filename;
  link.click();
}

/** A link this close to its expiry is renewed before it is followed (an expired one shows an error page). */
const LINK_RENEW_MS = 15_000;

/**
 * Download: the file saved under its own name, through a link signed when the button is pressed (the
 * server records each one as a download), never ahead of it.
 */
function DownloadButton({
  document: doc,
  labelled = false,
  onError,
}: {
  document: DocumentView;
  /** A labelled button (in a message) rather than an icon in a bar. */
  labelled?: boolean;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const download = () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    fetchDocumentDownload(doc.id)
      .then((file) => {
        followFileLink(file.url, false, doc.filename);
      })
      .catch(() => {
        onError('The download couldn’t start. Try again.');
      })
      .finally(() => {
        setBusy(false);
      });
  };
  if (labelled) {
    return (
      <Button variant="secondary" size="sm" onClick={download} aria-busy={busy || undefined}>
        <Download aria-hidden />
        Download
      </Button>
    );
  }
  return (
    <SimpleTooltip content="Download">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Download"
        aria-busy={busy || undefined}
        onClick={download}
      >
        <Download aria-hidden />
      </Button>
    </SimpleTooltip>
  );
}

/**
 * The PDF in a new tab: the link the viewer read it through (asked for once, when the viewer opened it;
 * never refreshed in the background), renewed only if it is about to expire when it is followed.
 */
function OpenInNewTab({ document: doc }: { document: DocumentView }) {
  const client = useQueryClient();
  const shown = useQuery({ ...documentFileQueryOptions(doc.id), enabled: false });
  const follow = (event: MouseEvent) => {
    const current = shown.data;
    if (current !== undefined && Date.parse(current.expiresAt) - Date.now() > LINK_RENEW_MS) return;
    event.preventDefault();
    void client
      .query({ ...documentFileQueryOptions(doc.id), staleTime: 0 })
      .then((file) => {
        followFileLink(file.url, true, doc.filename);
      })
      .catch(() => undefined);
  };
  return (
    <SimpleTooltip content="Open in a new tab">
      <Button variant="ghost" size="icon-sm" asChild>
        <a
          href={shown.data?.url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open in a new tab"
          onClick={follow}
        >
          <ExternalLink aria-hidden />
        </a>
      </Button>
    </SimpleTooltip>
  );
}

/** A stored document's file actions: Download, and (a PDF on a wide screen) the file in a new tab. */
function FileActions({
  document: doc,
  newTab,
  onError,
}: {
  document: DocumentView;
  newTab: boolean;
  onError: (message: string | null) => void;
}) {
  if (!hasStoredFile(doc)) return null;
  return (
    <>
      {newTab ? <OpenInNewTab document={doc} /> : null}
      <DownloadButton document={doc} onError={onError} />
    </>
  );
}

interface BodyProps {
  ventureId: string;
  subject: ReturnType<typeof useViewerSubject>;
  target: ViewerTarget;
  veirName: string;
  query: string;
  activeMatch: number;
  size: number;
  wide: boolean;
  zoom: number;
  jump: number;
  pageRequest: { page: number; seq: number } | null;
  scrollRoot: HTMLElement | null;
  onReport: (report: ReaderReport) => void;
  onPdfReport: (report: PdfReport) => void;
  onZoom: (zoom: number) => void;
  onRetryClose: () => void;
  /** Says something at the bottom of the viewer (a download that could not start); null clears it. */
  onNotice: (message: string | null) => void;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="viewer-centered flex flex-col items-center justify-center px-6 py-16 text-center">
      {children}
    </div>
  );
}

function Opening() {
  return (
    <Centered>
      <p role="status" className="text-small text-muted-foreground">
        Opening…
      </p>
    </Centered>
  );
}

function ViewerBody(props: BodyProps) {
  const { subject } = props;
  switch (subject.state) {
    case 'loading':
      return <Opening />;
    case 'missing':
      return (
        <Centered>
          <p className="font-serif text-subheading">This document is no longer here</p>
          <p className="mt-2 max-w-sm text-small text-muted-foreground">
            It may have been deleted, or it isn’t shared with you.
          </p>
          <Button variant="secondary" size="sm" className="mt-5" onClick={props.onRetryClose}>
            Close
          </Button>
        </Centered>
      );
    case 'error':
      return (
        <Centered>
          <ErrorState error={subject.error} onRetry={subject.retry} headingLevel={3} />
        </Centered>
      );
    case 'document':
      return <DocumentBody {...props} document={subject.document} />;
    case 'source':
      return <SourceBody {...props} text={subject.text} />;
  }
}

/** The reading column: the platform's 68ch measure unless the reader widened it. */
function Column({ size, wide, children }: { size: number; wide: boolean; children: ReactNode }) {
  return (
    <div className="viewer-column">
      <div
        className="mx-auto font-serif"
        style={{
          ['--reader-size' as string]: `${String(size)}px`,
          fontSize: `${String(size)}px`,
          // 68 characters of the reading face at the chosen size.
          maxWidth: wide ? '100%' : '68ch',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ExtractedNote() {
  return (
    <p className="mb-6 font-sans text-caption text-muted-foreground" data-extracted-note>
      Shown as extracted text.
    </p>
  );
}

/** The cited passage, quoted, when it cannot be marked in the file's own layout. */
function CitedCallout({ text }: { text: string }) {
  return (
    <aside aria-label="Cited passage" className="viewer-cited-callout">
      <p className="label-mono mb-1.5">Cited passage</p>
      <p className="whitespace-pre-wrap">{text}</p>
    </aside>
  );
}

function DocumentBody(props: BodyProps & { document: DocumentView }) {
  const { document: doc, ventureId, target } = props;
  const kind = documentKind(doc.contentType);
  const stored = hasStoredFile(doc);
  const original = stored && kind !== 'word';
  const body = useDocumentBody(doc, original);
  const originalFailed = original && body.isError;
  const [pdfError, setPdfError] = useState<string | null>(null);
  const showExtracted = (kind === 'word' || originalFailed || pdfError !== null) && doc.status === 'ready';
  const extracted = useExtractedText(ventureId, doc.sourceId ?? null, showExtracted);
  const passageId = target.passageId;
  const cited = useCitedPassage(
    ventureId,
    doc.sourceId ?? null,
    original && !showExtracted ? passageId : null,
  );
  const text = useMemo(
    () => (body.data && kind !== 'pdf' ? new TextDecoder('utf-8').decode(body.data) : ''),
    [body.data, kind],
  );
  const onPdfError = useCallback((message: string) => {
    setPdfError(message);
  }, []);

  if (showExtracted) {
    if (extracted.isPending) return <Opening />;
    if (extracted.isError) {
      return (
        <Centered>
          <ErrorState error={extracted.error} onRetry={() => void extracted.refetch()} headingLevel={3} />
        </Centered>
      );
    }
    return (
      <Column size={props.size} wide={props.wide}>
        {pdfError ? <p className="mb-2 font-sans text-caption text-muted-foreground">{pdfError}</p> : null}
        <ExtractedNote />
        <PassagesReader
          passages={extracted.data.passages}
          query={props.query}
          citedPassageId={passageId}
          onReport={props.onReport}
        />
      </Column>
    );
  }

  // A PDF that pdf.js cannot open (password-protected, damaged) and has no extracted text to show instead.
  if (pdfError !== null) {
    return (
      <Centered>
        <p className="max-w-md font-serif text-subheading">{pdfError}</p>
        <p className="mt-2 max-w-sm text-small text-muted-foreground">
          Download it to open it in another app.
        </p>
        <div className="mt-5">
          <DownloadButton document={doc} labelled onError={props.onNotice} />
        </div>
      </Centered>
    );
  }

  if (!original) {
    const [heading, detail] = !stored
      ? ['Nothing to show yet', 'The file hasn’t finished uploading.']
      : doc.status === 'failed'
        ? ['There’s no text to show', 'The text of this document couldn’t be extracted.']
        : ['The text shows here once it’s processed', 'Word documents are shown as their extracted text.'];
    return (
      <Centered>
        <p className="font-serif text-subheading">{heading}</p>
        <p className="mt-2 max-w-sm text-small text-muted-foreground">{detail}</p>
      </Centered>
    );
  }
  if (body.isPending || cited.pending) return <Opening />;
  if (body.isError) {
    return (
      <Centered>
        <ErrorState error={body.error} onRetry={() => void body.refetch()} headingLevel={3} />
      </Centered>
    );
  }

  if (kind === 'pdf') {
    return (
      <Suspense fallback={<Opening />}>
        <PdfStage {...props} data={body.data} citedText={cited.text} onError={onPdfError} />
      </Suspense>
    );
  }
  return (
    <Column size={props.size} wide={props.wide}>
      <TextWithCallout
        text={text}
        format={kind === 'markdown' ? 'markdown' : 'plain'}
        query={props.query}
        citedText={cited.text}
        onReport={props.onReport}
      />
    </Column>
  );
}

/** A text document, with the cited passage quoted above it when it cannot be marked in place. */
function TextWithCallout({
  text,
  format,
  query,
  citedText,
  onReport,
}: {
  text: string;
  format: 'markdown' | 'plain';
  query: string;
  citedText: string | null;
  onReport: (report: ReaderReport) => void;
}) {
  const [cited, setCited] = useState(true);
  const report = useCallback(
    (next: ReaderReport) => {
      setCited(next.cited);
      onReport(next);
    },
    [onReport],
  );
  return (
    <>
      {citedText && !cited ? <CitedCallout text={citedText} /> : null}
      <TextReader text={text} format={format} query={query} citedText={citedText} onReport={report} />
    </>
  );
}

function PdfStage(
  props: BodyProps & { data: ArrayBuffer; citedText: string | null; onError: (message: string) => void },
) {
  const [report, setReport] = useState<PdfReport | null>(null);
  const { onPdfReport } = props;
  const onReport = useCallback(
    (next: PdfReport) => {
      setReport(next);
      onPdfReport(next);
    },
    [onPdfReport],
  );
  return (
    <>
      {props.citedText && report?.textReady && !report.cited ? (
        <div className="viewer-column-top">
          <CitedCallout text={props.citedText} />
        </div>
      ) : null}
      <PdfReader
        data={props.data}
        zoom={props.zoom}
        wide={props.wide}
        query={props.query}
        activeMatch={props.activeMatch}
        citedText={props.citedText}
        jumpToCited={props.jump}
        pageRequest={props.pageRequest}
        scrollRoot={props.scrollRoot}
        onReport={onReport}
        onZoom={props.onZoom}
        onError={props.onError}
      />
    </>
  );
}

function SourceBody(props: BodyProps & { text: SourceTextResponse }) {
  const { text, target } = props;
  const cited = target.passageId
    ? (text.passages.find((p) => p.id === target.passageId)?.text ?? null)
    : null;
  return (
    <Column size={props.size} wide={props.wide}>
      {text.body !== null ? (
        <TextWithCallout
          text={text.body}
          format="markdown"
          query={props.query}
          citedText={cited}
          onReport={props.onReport}
        />
      ) : (
        <>
          <ExtractedNote />
          <PassagesReader
            passages={text.passages}
            query={props.query}
            citedPassageId={target.passageId}
            onReport={props.onReport}
          />
        </>
      )}
      {text.truncated ? (
        <p className="mt-10 font-sans text-caption text-muted-foreground">
          The rest of this source is too long to show here.
        </p>
      ) : null}
      {text.passages.length === 0 && text.body === null ? (
        <p className="font-sans text-small text-muted-foreground">This source has no text to show.</p>
      ) : null}
    </Column>
  );
}
