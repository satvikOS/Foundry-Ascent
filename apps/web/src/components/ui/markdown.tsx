import { ExternalLink } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

/*
 * Safe Markdown for model answers, memory content and documents:
 *   - raw HTML is never rendered (`skipHtml`), only Markdown + GFM (tables, task lists, strikethrough);
 *   - links pass react-markdown's protocol allow-list and then must be https: or mailto: (no
 *     javascript:/data:/http:/relative links; those render as plain text);
 *   - images are NOT loaded (a model could be steered into emitting tracking/exfiltration URLs) —
 *     they render as their alt text;
 *   - links open in a new tab with rel="noopener noreferrer nofollow" and an external-link icon;
 *   - evidence citations like [E3] can be rendered as custom chips via `renderCitation`.
 */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const CITATION = /\[(E\d{1,3})\]/g;
const CITATION_SCHEME = 'evidence:';

/** remark plugin: turns "[E1]" text into link nodes with an `evidence:E1` URL. */
function remarkCitations() {
  const visit = (node: MdNode): void => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && child.value && CITATION.test(child.value)) {
        CITATION.lastIndex = 0;
        let last = 0;
        for (const match of child.value.matchAll(CITATION)) {
          const index = match.index;
          if (index > last) next.push({ type: 'text', value: child.value.slice(last, index) });
          next.push({
            type: 'link',
            url: `${CITATION_SCHEME}${match[1] ?? ''}`,
            children: [{ type: 'text', value: match[1] ?? '' }],
          });
          last = index + match[0].length;
        }
        if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) });
      } else {
        if (child.type !== 'link' && child.type !== 'code' && child.type !== 'inlineCode') visit(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => {
    visit(tree);
  };
}

/** Links that may be followed from model or user content: https and mailto only (no http, no relative). */
const SAFE_LINK = /^(?:https:\/\/|mailto:)/i;

/** Keeps citation links, allows only https:/mailto: URLs; anything else renders as plain text. */
export function urlTransform(url: string): string {
  if (url.startsWith(CITATION_SCHEME)) return url;
  const allowed = defaultUrlTransform(url);
  return SAFE_LINK.test(allowed) ? allowed : '';
}

interface MarkdownProps {
  children: string;
  className?: string;
  /** Render an evidence key (e.g. "E2") as an interactive chip. Without it, keys render as plain text. */
  renderCitation?: (key: string) => ReactNode;
  /** Smaller type for side panels. */
  size?: 'default' | 'sm';
}

function buildComponents(renderCitation: MarkdownProps['renderCitation']): Components {
  return {
    a: ({ href, children }) => {
      if (href?.startsWith(CITATION_SCHEME)) {
        const key = href.slice(CITATION_SCHEME.length);
        return renderCitation ? <>{renderCitation(key)}</> : <span className="font-medium">[{key}]</span>;
      }
      if (!href) return <span>{children}</span>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-baseline gap-0.5 font-medium text-foreground underline decoration-border-strong underline-offset-[3px] hover:decoration-foreground"
        >
          {children}
          <ExternalLink aria-hidden className="size-3 shrink-0 self-center opacity-70" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      );
    },
    img: ({ alt }) => (
      <span className="rounded-sm border border-dashed border-border px-1 text-muted-foreground">
        [image{alt ? `: ${alt}` : ''}]
      </span>
    ),
    h1: ({ children }) => (
      <h3 className="mt-5 mb-2 text-base font-semibold tracking-tight first:mt-0">{children}</h3>
    ),
    h2: ({ children }) => (
      <h4 className="mt-5 mb-2 text-[15px] font-semibold tracking-tight first:mt-0">{children}</h4>
    ),
    h3: ({ children }) => <h5 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">{children}</h5>,
    h4: ({ children }) => <h6 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">{children}</h6>,
    h5: ({ children }) => <p className="mt-3 mb-1 font-semibold first:mt-0">{children}</p>,
    h6: ({ children }) => <p className="mt-3 mb-1 font-semibold first:mt-0">{children}</p>,
    p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children, className }) => (
      <ul
        className={cn(
          'my-2.5 list-disc space-y-1 pl-5 marker:text-subtle-foreground',
          className?.includes('contains-task-list') && 'list-none pl-1',
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2.5 list-decimal space-y-1 pl-5 marker:text-subtle-foreground">{children}</ol>
    ),
    li: ({ children }) => <li className="pl-1 [&>input]:mr-2 [&>input]:align-middle">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-border-strong pl-3 text-muted-foreground">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-border" />,
    code: ({ children, className }) => {
      const block = (className ?? '').includes('language-');
      return block ? (
        <code className="font-mono text-[13px]">{children}</code>
      ) : (
        <code className="rounded-sm border border-border bg-muted px-1 py-px font-mono text-[0.85em]">
          {children}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-muted p-3 leading-relaxed">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left text-[13px]">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    th: ({ children }) => <th className="border-b border-border px-3 py-2 font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{children}</td>,
    input: ({ checked, type }) =>
      type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={Boolean(checked)}
          disabled
          readOnly
          className="size-3.5 accent-current"
        />
      ) : null,
  };
}

const defaultComponents = buildComponents(undefined);

function MarkdownImpl({ children, className, renderCitation, size = 'default' }: MarkdownProps) {
  return (
    <div
      data-slot="markdown"
      className={cn(
        'max-w-none text-foreground [overflow-wrap:anywhere]',
        size === 'default' ? 'text-[15px] leading-7' : 'text-sm leading-6',
        className,
      )}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkCitations]}
        urlTransform={urlTransform}
        components={renderCitation ? buildComponents(renderCitation) : defaultComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
