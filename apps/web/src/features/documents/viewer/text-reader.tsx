import { ExternalLink } from 'lucide-react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type JSX,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { urlTransform } from '@/components/ui/markdown';

import { rehypeFindMarks, segmentText, type TextSegment } from './find';
import { citedBlocks, comparableWords, rehypeCitedBlocks } from './passage-match';

/*
 * Reading views of text: a Markdown or plain-text document as prose, and a source's extracted passages.
 * Markdown follows the app's safety rules (no raw HTML, https/mailto links only, images never loaded).
 * Find matches are <mark data-find-index> and the cited passage's blocks carry data-cited, all rendered by
 * React; the dialog reads them back after each render.
 */

/** What a reading view reports after it renders: how many find matches it marked, and the cited passage. */
export interface ReaderReport {
  readonly matches: number;
  readonly cited: boolean;
}

/** Counts what a rendered view marked (the find matches and the cited passage's blocks). */
export function reportOf(root: ParentNode): ReaderReport {
  return {
    matches: root.querySelectorAll('mark[data-find-index]').length,
    cited: root.querySelector('[data-cited]') !== null,
  };
}

function Marked({ segments }: { segments: readonly TextSegment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.match === null ? (
          segment.text
        ) : (
          <mark key={i} data-find-index={segment.match}>
            {segment.text}
          </mark>
        ),
      )}
    </>
  );
}

type Rest<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & { node?: unknown };

/** Markdown elements as reading prose; heading levels sit under the viewer's own title. */
const READING: Components = {
  h1: ({ node: _node, ...props }: Rest<'h3'>) => <h3 {...props} className="reader-h1" />,
  h2: ({ node: _node, ...props }: Rest<'h4'>) => <h4 {...props} className="reader-h2" />,
  h3: ({ node: _node, ...props }: Rest<'h5'>) => <h5 {...props} className="reader-h3" />,
  h4: ({ node: _node, ...props }: Rest<'h6'>) => <h6 {...props} className="reader-h4" />,
  h5: ({ node: _node, ...props }: Rest<'h6'>) => <h6 {...props} className="reader-h4" />,
  h6: ({ node: _node, ...props }: Rest<'h6'>) => <h6 {...props} className="reader-h4" />,
  a: ({ node: _node, href, children }: Rest<'a'>) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="reader-link">
        {children}
        <ExternalLink aria-hidden />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }: Rest<'img'>) => <span className="reader-image">[image{alt ? `: ${alt}` : ''}]</span>,
  input: ({ checked, type }: Rest<'input'>) =>
    type === 'checkbox' ? <input type="checkbox" checked={Boolean(checked)} disabled readOnly /> : null,
  table: ({ node: _node, ...props }: Rest<'table'>) => (
    <div className="reader-table">
      <table {...props} />
    </div>
  ),
};

interface TextReaderProps {
  text: string;
  format: 'markdown' | 'plain';
  /** The find query ('' marks nothing). */
  query: string;
  /** Text of the cited passage, marked where it shows in the document. */
  citedText: string | null;
  onReport: (report: ReaderReport) => void;
}

/** A long document is shown in parts of about this many characters, the next one as the reader nears it. */
export const SEGMENT_CHARS = 60_000;

/**
 * Splits a long text into parts at paragraph breaks (and, for Markdown, before headings), never inside a
 * fenced code block. A text under {@link SEGMENT_CHARS} is one part.
 */
export function splitIntoSegments(text: string, format: 'markdown' | 'plain'): string[] {
  if (text.length <= SEGMENT_CHARS) return [text];
  const segments: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fenced = false;
  for (const line of text.split('\n')) {
    const fence = format === 'markdown' && /^\s{0,3}(```|~~~)/.test(line);
    const breakable = !fenced && (line.trim() === '' || (format === 'markdown' && /^#{1,6}\s/.test(line)));
    if (breakable && size >= SEGMENT_CHARS) {
      segments.push(current.join('\n'));
      current = [];
      size = 0;
    }
    if (fence) fenced = !fenced;
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) segments.push(current.join('\n'));
  return segments;
}

/** The part a passage starts in (by its first words), or -1. */
export function segmentOfPassage(segments: readonly string[], passage: string): number {
  if (segments.length === 1) return 0;
  const head = comparableWords(passage).slice(0, 8).join(' ');
  if (head === '') return -1;
  return segments.findIndex((segment) => ` ${comparableWords(segment).join(' ')} `.includes(` ${head} `));
}

/**
 * How many parts of a long document are shown: the first (and the one with the cited passage), more as a
 * marker past the last one nears the reading area, and all of them while find is open.
 */
function useReveal(total: number, minimum: number, all: boolean) {
  const [shown, setShown] = useState(Math.min(total, Math.max(1, minimum)));
  const marker = useRef<HTMLDivElement | null>(null);
  const count = all ? total : Math.min(total, Math.max(shown, minimum));
  useEffect(() => {
    const el = marker.current;
    if (!el || count >= total) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(total);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown(count + 1);
      },
      { root: el.closest('[data-viewer-scroll]'), rootMargin: '1500px 0px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [count, total]);
  return { count, marker };
}

function PlainText({ text, query, citedText }: Pick<TextReaderProps, 'text' | 'query' | 'citedText'>) {
  const paragraphs = useMemo(() => text.split(/\n[ \t]*\n/).filter((p) => p.trim() !== ''), [text]);
  const cited = useMemo(
    () => new Set(citedText ? citedBlocks(paragraphs, citedText) : []),
    [paragraphs, citedText],
  );
  const counter = { next: 0 };
  return (
    <>
      {paragraphs.map((paragraph, i) => (
        <p key={i} className="whitespace-pre-wrap" data-cited={cited.has(i) || undefined}>
          <Marked segments={segmentText(paragraph, query, counter)} />
        </p>
      ))}
    </>
  );
}

const MarkdownPart = memo(function MarkdownPart({
  text,
  query,
  citedText,
}: Pick<TextReaderProps, 'text' | 'query' | 'citedText'>) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[
        [rehypeCitedBlocks, { passage: citedText }],
        [rehypeFindMarks, { query }],
      ]}
      urlTransform={urlTransform}
      components={READING}
    >
      {text}
    </ReactMarkdown>
  );
});

/**
 * A Markdown or plain-text document as reading prose. A long one is shown part by part as the reader
 * scrolls (all of it while find is open, so every match is counted).
 */
export const TextReader = memo(function TextReader({
  text,
  format,
  query,
  citedText,
  onReport,
}: TextReaderProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const segments = useMemo(() => splitIntoSegments(text, format), [text, format]);
  const citedSegment = useMemo(
    () => (citedText ? segmentOfPassage(segments, citedText) : -1),
    [segments, citedText],
  );
  const { count, marker } = useReveal(segments.length, citedSegment + 1, query.trim() !== '');
  useLayoutEffect(() => {
    if (root.current) onReport(reportOf(root.current));
  });
  return (
    <div ref={root} data-reader="text" className="reader-prose">
      {segments.slice(0, count).map((segment, i) => {
        const cited = i === citedSegment ? citedText : null;
        return format === 'markdown' ? (
          <MarkdownPart key={i} text={segment} query={query} citedText={cited} />
        ) : (
          <PlainText key={i} text={segment} query={query} citedText={cited} />
        );
      })}
      {count < segments.length ? <div ref={marker} aria-hidden data-more /> : null}
    </div>
  );
});

export interface ReaderPassage {
  readonly id: string;
  readonly heading: string | null;
  readonly text: string;
}

interface PassagesReaderProps {
  passages: readonly ReaderPassage[];
  query: string;
  /** The cited passage (by id), marked. */
  citedPassageId: string | null;
  onReport: (report: ReaderReport) => void;
}

/** The last part of a heading path ("Findings › Pricing" → "Pricing"). */
function headingTitle(heading: string): string {
  return heading.split(' › ').at(-1) ?? heading;
}

/** Passages shown at a time in a long source (more as the reader scrolls). */
export const PASSAGES_PER_PART = 40;

/** A source's extracted text: its passages in order, a heading where a new section starts. */
export const PassagesReader = memo(function PassagesReader({
  passages,
  query,
  citedPassageId,
  onReport,
}: PassagesReaderProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const parts = Math.max(1, Math.ceil(passages.length / PASSAGES_PER_PART));
  const citedIndex = citedPassageId === null ? -1 : passages.findIndex((p) => p.id === citedPassageId);
  const { count, marker } = useReveal(
    parts,
    citedIndex === -1 ? 1 : Math.floor(citedIndex / PASSAGES_PER_PART) + 1,
    query.trim() !== '',
  );
  useLayoutEffect(() => {
    if (root.current) onReport(reportOf(root.current));
  });
  const counter = { next: 0 };
  const shown = passages.slice(0, count * PASSAGES_PER_PART);
  return (
    <div ref={root} data-reader="passages" className="reader-prose">
      {shown.map((passage, i) => {
        const previous = shown[i - 1];
        const heading =
          passage.heading !== null && passage.heading !== previous?.heading ? passage.heading : null;
        return (
          <section key={passage.id} data-passage-id={passage.id} aria-label={heading ?? undefined}>
            {heading ? <h3 className="reader-h2">{headingTitle(heading)}</h3> : null}
            <div data-cited={passage.id === citedPassageId || undefined}>
              {passage.text
                .split(/\n[ \t]*\n/)
                .filter((p) => p.trim() !== '')
                .map((paragraph, j) => (
                  <p key={j} className="whitespace-pre-wrap">
                    <Marked segments={segmentText(paragraph, query, counter)} />
                  </p>
                ))}
            </div>
          </section>
        );
      })}
      {count < parts ? <div ref={marker} aria-hidden data-more /> : null}
    </div>
  );
});
