import { ExternalLink } from 'lucide-react';
import { memo, useLayoutEffect, useMemo, useRef, type ComponentProps, type JSX } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { urlTransform } from '@/components/ui/markdown';

import { rehypeFindMarks, segmentText, type TextSegment } from './find';
import { citedBlocks, rehypeCitedBlocks } from './passage-match';

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

/** A Markdown or plain-text document as reading prose. */
export const TextReader = memo(function TextReader({
  text,
  format,
  query,
  citedText,
  onReport,
}: TextReaderProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (root.current) onReport(reportOf(root.current));
  });
  return (
    <div ref={root} data-reader="text" className="reader-prose">
      {format === 'markdown' ? (
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
      ) : (
        <PlainText text={text} query={query} citedText={citedText} />
      )}
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

/** A source's extracted text: its passages in order, a heading where a new section starts. */
export const PassagesReader = memo(function PassagesReader({
  passages,
  query,
  citedPassageId,
  onReport,
}: PassagesReaderProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (root.current) onReport(reportOf(root.current));
  });
  const counter = { next: 0 };
  return (
    <div ref={root} data-reader="passages" className="reader-prose">
      {passages.map((passage, i) => {
        const previous = passages[i - 1];
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
    </div>
  );
});
