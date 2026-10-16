import './pdf-reader.css';

import {
  getDocument,
  GlobalWorkerOptions,
  PasswordException,
  type PDFDocumentProxy,
  type RenderTask,
  TextLayer,
} from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { scrollBehavior } from './motion';
import { citedRuns, findInPages, type PageMatch, type PageRuns } from './pdf-text';

/*
 * PDFs with pdf.js, loaded only when a PDF is opened (its own chunk). The worker is a same-origin asset
 * (CSP worker/script-src 'self'); pdf.js 6 has no eval path at all (the old `isEvalSupported` option is gone),
 * and WebAssembly decoders stay off (no 'wasm-unsafe-eval'). Pages render near the viewport only, each a
 * canvas plus a text layer that find and the cited passage mark.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

/** Zoom limits (a multiple of "fit width"). */
export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 4;
/** Widest a page is drawn at "fit width" unless the reader widened the page. */
const READING_PAGE_WIDTH = 860;
const PAGE_GAP = 16;
const SIDE_PADDING = 16;

export interface PdfReport {
  readonly pages: number;
  /** 1-based page at the reading position. */
  readonly page: number;
  readonly matches: number;
  /** The text of every page is read (find counts are final). */
  readonly textReady: boolean;
  readonly cited: boolean;
}

interface PdfReaderProps {
  data: ArrayBuffer;
  /** A multiple of the fit-to-width size. */
  zoom: number;
  wide: boolean;
  query: string;
  activeMatch: number;
  citedText: string | null;
  /** Increments to scroll to the cited passage. */
  jumpToCited: number;
  /** Scroll to a page (1-based); `seq` repeats a request for the same page. */
  pageRequest: { readonly page: number; readonly seq: number } | null;
  /** The dialog's scroll container: pages render as they come near it. */
  scrollRoot: HTMLElement | null;
  onReport: (report: PdfReport) => void;
  /** A pinch on a touch screen asks for another zoom. */
  onZoom: (zoom: number) => void;
  onError: (message: string) => void;
}

interface PageSize {
  readonly width: number;
  readonly height: number;
}

interface RenderedPage {
  scale: number;
  task: RenderTask | null;
  layer: TextLayer | null;
}

const clampZoom = (zoom: number): number => Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom));

/** Marks find matches and the cited passage in one page's text layer (its spans are pdf.js's own). */
function markPage(
  layer: TextLayer,
  matches: readonly { index: number; match: PageMatch }[],
  cited: ReadonlySet<number> | undefined,
): void {
  const divs = layer.textDivs;
  const texts = layer.textContentItemsStr;
  const parts = new Map<number, { from: number; to: number; index: number }[]>();
  for (const { index, match } of matches) {
    for (const part of match.parts) {
      const list = parts.get(part.item) ?? [];
      list.push({ from: part.from, to: part.to, index });
      parts.set(part.item, list);
    }
  }
  divs.forEach((div, item) => {
    const text = texts[item] ?? '';
    div.classList.toggle('pdf-cited', cited?.has(item) ?? false);
    const ranges = parts.get(item);
    if (!ranges) {
      if (div.childElementCount > 0) div.textContent = text;
      return;
    }
    const nodes: Node[] = [];
    let at = 0;
    for (const range of ranges.sort((a, b) => a.from - b.from)) {
      if (range.from > at) nodes.push(document.createTextNode(text.slice(at, range.from)));
      const mark = document.createElement('mark');
      mark.dataset.findIndex = String(range.index);
      mark.textContent = text.slice(range.from, range.to);
      nodes.push(mark);
      at = range.to;
    }
    if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
    div.replaceChildren(...nodes);
  });
}

export default function PdfReader({
  data,
  zoom,
  wide,
  query,
  activeMatch,
  citedText,
  jumpToCited,
  pageRequest,
  scrollRoot,
  onReport,
  onZoom,
  onError,
}: PdfReaderProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [runs, setRuns] = useState<(PageRuns | undefined)[]>([]);
  const [width, setWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const contents = useRef(new Map<number, TextContent>());
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const rendered = useRef(new Map<number, RenderedPage>());
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const pendingScroll = useRef<'match' | 'cited' | null>(null);

  // Open the document (a copy of the bytes: pdf.js hands its buffer to the worker).
  useEffect(() => {
    const life = { cancelled: false };
    const cancelled = (): boolean => life.cancelled;
    const task = getDocument({
      data: new Uint8Array(data.slice(0)),
      useWasm: false,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      verbosity: 0,
    });
    task.promise.then(
      async (doc) => {
        if (cancelled()) return;
        const first = await doc.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        if (cancelled()) return;
        setSizes(
          Array.from({ length: doc.numPages }, () => ({ width: viewport.width, height: viewport.height })),
        );
        setRuns(Array.from({ length: doc.numPages }, () => undefined));
        setPdf(doc);
      },
      (error: unknown) => {
        if (cancelled()) return;
        onError(
          error instanceof PasswordException
            ? 'This PDF is password-protected, so it can’t be shown here.'
            : 'This file couldn’t be read as a PDF.',
        );
      },
    );
    return () => {
      life.cancelled = true;
      void task.destroy();
    };
  }, [data, onError]);

  // Every page's size and text, page by page in the background (find and the cited passage need them all).
  useEffect(() => {
    if (!pdf) return;
    const life = { cancelled: false };
    const cancelled = (): boolean => life.cancelled;
    void (async () => {
      for (let i = 1; i <= pdf.numPages && !cancelled(); i += 1) {
        try {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          if (cancelled()) return;
          contents.current.set(i - 1, content);
          const items = content.items.filter((item): item is TextItem => 'str' in item);
          setSizes((prev) => {
            const next = [...prev];
            next[i - 1] = { width: viewport.width, height: viewport.height };
            return next;
          });
          setRuns((prev) => {
            const next = [...prev];
            next[i - 1] = { items: items.map((item) => item.str), eol: items.map((item) => item.hasEOL) };
            return next;
          });
        } catch {
          // A page that cannot be read keeps its placeholder; the rest still renders.
        }
      }
    })();
    return () => {
      life.cancelled = true;
    };
  }, [pdf]);

  // The width pages fit.
  useLayoutEffect(() => {
    if (!scrollRoot) return;
    const measure = () => {
      setWidth(scrollRoot.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollRoot);
    return () => {
      observer.disconnect();
    };
  }, [scrollRoot]);

  const firstWidth = sizes[0]?.width ?? 612;
  const fitWidth = Math.max(200, Math.min(width - SIDE_PADDING * 2, wide ? Infinity : READING_PAGE_WIDTH));
  const scale = (fitWidth / firstWidth) * clampZoom(zoom);

  const textReady = runs.length > 0 && runs.every((r) => r !== undefined);
  const matches = useMemo(() => findInPages(runs, query), [runs, query]);
  const cited = useMemo(
    () => (citedText && textReady ? citedRuns(runs, citedText) : new Map<number, Set<number>>()),
    [citedText, runs, textReady],
  );
  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, { index: number; match: PageMatch }[]>();
    matches.forEach((match, index) => {
      const list = byPage.get(match.page) ?? [];
      list.push({ index, match });
      byPage.set(match.page, list);
    });
    return byPage;
  }, [matches]);

  const marks = useRef({ matchesByPage, cited });
  marks.current = { matchesByPage, cited };

  // Render a page near the viewport (again after a zoom), and drop pages far from it.
  useEffect(() => {
    if (!pdf || !scrollRoot) return;
    const drawn = rendered.current;
    const unload = (index: number) => {
      const entry = drawn.get(index);
      if (!entry) return;
      entry.task?.cancel();
      entry.layer?.cancel();
      drawn.delete(index);
      const el = pageEls.current.get(index);
      const canvas = el?.querySelector('canvas');
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      el?.querySelector('.textLayer')?.replaceChildren();
    };
    const draw = async (index: number) => {
      if (drawn.get(index)?.scale === scale) return;
      unload(index);
      const entry: RenderedPage = { scale, task: null, layer: null };
      drawn.set(index, entry);
      const el = pageEls.current.get(index);
      const canvas = el?.querySelector('canvas');
      const textDiv = el?.querySelector<HTMLDivElement>('.textLayer');
      if (!el || !canvas || !textDiv) return;
      try {
        const page = await pdf.getPage(index + 1);
        if (drawn.get(index) !== entry) return;
        const viewport = page.getViewport({ scale });
        // Drawn at the screen's pixel density (at most 2x) and shown at the page's CSS size.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const pixels = page.getViewport({ scale: scale * ratio });
        canvas.width = Math.floor(pixels.width);
        canvas.height = Math.floor(pixels.height);
        entry.task = page.render({ canvas, viewport: pixels });
        await entry.task.promise;
        const content = contents.current.get(index) ?? (await page.getTextContent());
        if (drawn.get(index) !== entry) return;
        textDiv.replaceChildren();
        entry.layer = new TextLayer({ textContentSource: content, container: textDiv, viewport });
        await entry.layer.render();
        if (drawn.get(index) !== entry) return;
        markPage(entry.layer, marks.current.matchesByPage.get(index) ?? [], marks.current.cited.get(index));
        el.dataset.rendered = 'true';
      } catch {
        // Cancelled (scrolled away or zoomed again) or unreadable: the placeholder stays.
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (entry.isIntersecting) void draw(index);
          else unload(index);
        }
      },
      { root: scrollRoot, rootMargin: '150% 0px' },
    );
    for (const el of pageEls.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [pdf, scrollRoot, scale, sizes.length]);

  // Unload everything when the document goes away.
  useEffect(() => {
    const drawn = rendered.current;
    return () => {
      for (const entry of drawn.values()) {
        entry.task?.cancel();
        entry.layer?.cancel();
      }
      drawn.clear();
    };
  }, []);

  // Re-mark the drawn pages when the query or the cited passage changes.
  useEffect(() => {
    for (const [index, entry] of rendered.current) {
      if (entry.layer) markPage(entry.layer, matchesByPage.get(index) ?? [], cited.get(index));
    }
  }, [matchesByPage, cited]);

  // The active match: its mark when its page is drawn, else its page (the mark follows once drawn).
  useEffect(() => {
    const root = pagesRef.current;
    if (!root) return;
    root.querySelectorAll('mark[data-active]').forEach((mark) => {
      mark.removeAttribute('data-active');
    });
    const match = matches[activeMatch];
    if (!match) return;
    const mark = root.querySelector<HTMLElement>(`mark[data-find-index="${String(activeMatch)}"]`);
    if (mark) {
      mark.dataset.active = 'true';
      mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: scrollBehavior() });
      pendingScroll.current = null;
    } else {
      pageEls.current.get(match.page)?.scrollIntoView({ block: 'start', behavior: 'auto' });
      pendingScroll.current = 'match';
    }
  }, [matches, activeMatch]);

  // Scroll to the cited passage when it is found and when the reader asks again.
  const citedFound = cited.size > 0;
  useEffect(() => {
    if (!citedFound) return;
    const first = Math.min(...cited.keys());
    const root = pagesRef.current;
    const span = root?.querySelector<HTMLElement>(`[data-page-index="${String(first)}"] .pdf-cited`);
    if (span) span.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    else {
      pageEls.current.get(first)?.scrollIntoView({ block: 'start', behavior: 'auto' });
      pendingScroll.current = 'cited';
    }
  }, [citedFound, cited, jumpToCited]);

  // Finish a scroll that waited for its page to be drawn.
  useEffect(() => {
    const root = pagesRef.current;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (pendingScroll.current === 'match') {
        const mark = root.querySelector<HTMLElement>(`mark[data-find-index="${String(activeMatch)}"]`);
        if (mark) {
          pendingScroll.current = null;
          mark.dataset.active = 'true';
          mark.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      } else if (pendingScroll.current === 'cited') {
        const span = root.querySelector<HTMLElement>('.pdf-cited');
        if (span) {
          pendingScroll.current = null;
          span.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      }
    });
    observer.observe(root, { attributes: true, subtree: true, attributeFilter: ['data-rendered'] });
    return () => {
      observer.disconnect();
    };
  }, [activeMatch]);

  // Go to a page.
  useEffect(() => {
    if (!pageRequest) return;
    pageEls.current.get(pageRequest.page - 1)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  }, [pageRequest]);

  // The page at the reading position (a third down the visible area).
  useEffect(() => {
    if (!scrollRoot) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = scrollRoot.getBoundingClientRect().top + scrollRoot.clientHeight / 3;
      let page = 1;
      for (const [index, el] of pageEls.current) {
        if (el.getBoundingClientRect().top <= line) page = Math.max(page, index + 1);
      }
      setCurrentPage(page);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      scrollRoot.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRoot, sizes.length]);

  useEffect(() => {
    onReport({
      pages: sizes.length,
      page: currentPage,
      matches: matches.length,
      textReady,
      cited: citedFound,
    });
  }, [onReport, sizes.length, currentPage, matches.length, textReady, citedFound]);

  // Pinch to zoom on touch screens: the pages scale while the fingers move, then redraw at the new zoom.
  useEffect(() => {
    const root = pagesRef.current;
    if (!root || !scrollRoot) return;
    const touches = new Map<number, { x: number; y: number }>();
    let startDistance = 0;
    let ratio = 1;
    const distance = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        startDistance = distance();
        const [a, b] = [...touches.values()];
        const box = root.getBoundingClientRect();
        if (a && b) {
          root.style.setProperty('--pinch-x', `${String((a.x + b.x) / 2 - box.left)}px`);
          root.style.setProperty('--pinch-y', `${String((a.y + b.y) / 2 - box.top)}px`);
        }
      }
    };
    const move = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2 && startDistance > 0) {
        ratio = Math.min(PDF_ZOOM_MAX / zoom, Math.max(PDF_ZOOM_MIN / zoom, distance() / startDistance));
        root.style.scale = String(ratio);
      }
    };
    const up = (event: PointerEvent) => {
      if (!touches.delete(event.pointerId)) return;
      if (startDistance > 0 && touches.size < 2) {
        root.style.scale = '';
        if (Math.abs(ratio - 1) > 0.02) onZoom(clampZoom(zoom * ratio));
        startDistance = 0;
        ratio = 1;
      }
    };
    scrollRoot.addEventListener('pointerdown', down);
    scrollRoot.addEventListener('pointermove', move);
    scrollRoot.addEventListener('pointerup', up);
    scrollRoot.addEventListener('pointercancel', up);
    return () => {
      scrollRoot.removeEventListener('pointerdown', down);
      scrollRoot.removeEventListener('pointermove', move);
      scrollRoot.removeEventListener('pointerup', up);
      scrollRoot.removeEventListener('pointercancel', up);
    };
  }, [scrollRoot, zoom, onZoom]);

  if (!pdf) {
    return (
      <p className="py-16 text-center text-small text-muted-foreground" role="status">
        Opening the PDF…
      </p>
    );
  }

  return (
    <div ref={pagesRef} className="pdf-pages" style={{ gap: PAGE_GAP }} data-reader="pdf">
      {sizes.map((size, index) => {
        const w = Math.floor(size.width * scale);
        const h = Math.floor(size.height * scale);
        return (
          <div
            key={index}
            ref={(el) => {
              if (el) pageEls.current.set(index, el);
              else pageEls.current.delete(index);
            }}
            data-page-index={index}
            role="group"
            aria-label={`Page ${String(index + 1)} of ${String(sizes.length)}`}
            className="pdf-page"
            style={{ width: w, height: h, ['--scale-factor' as string]: String(scale) }}
          >
            <canvas aria-hidden style={{ width: w, height: h }} />
            <div className="textLayer" />
          </div>
        );
      })}
    </div>
  );
}
