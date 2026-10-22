import type { DocumentView } from '@foundry/contracts';
import type { SourceTextResponse } from '@foundry/contracts/viewer';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { json, problem, stubFetch, testQueryClient, urlOf } from '@/features/knowledge/test-utils';
import { IDS, makeDocument, NOW } from '@/features/knowledge/testing';

import { DocumentViewerHost } from './document-viewer-host';
import type { PdfReport } from './pdf-reader';
import { type OpenDocumentInput, viewerSearchFor } from './viewer-search';

// pdf.js does not run in jsdom: a stand-in reports what the real reader reports (or, with `error` set,
// fails to open the file the way the real one does).
const pdfStub = vi.hoisted(() => ({ error: null as string | null }));
vi.mock('./pdf-reader', () => ({
  default: function PdfStub(props: {
    onReport: (r: PdfReport) => void;
    onError: (message: string) => void;
    zoom: number;
    citedText: string | null;
  }) {
    const { onReport, onError, citedText } = props;
    useEffect(() => {
      if (pdfStub.error !== null) onError(pdfStub.error);
      else onReport({ pages: 3, page: 1, matches: 0, textReady: true, cited: citedText !== null });
    }, [onReport, onError, citedText]);
    return pdfStub.error === null ? (
      <p data-testid="pdf-stub">PDF pages at {props.zoom}</p>
    ) : (
      <p role="status">Opening the PDF…</p>
    );
  },
}));

const SOURCE = '11111111-1111-4111-8111-111111111111';
const PASSAGE = '22222222-2222-4222-8222-222222222222';
const PDF_ID = '33333333-3333-4333-8333-333333333333';
const WORD_ID = '44444444-4444-4444-8444-444444444444';
const LIBRARY = '55555555-5555-4555-8555-555555555555';
const LOCKED_ID = '66666666-6666-4666-8666-666666666666';
const PROCESSING_ID = '77777777-7777-4777-8777-777777777777';

const NOTES = makeDocument({ filename: 'exam-week-interviews.md', sourceId: SOURCE });
const PDF_SOURCE = '88888888-8888-4888-8888-888888888888';
const PDF = makeDocument({
  id: PDF_ID,
  filename: 'seat-survey.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2_200_000,
  sourceId: PDF_SOURCE,
});
/** A PDF ingestion could not read (as a password-protected one fails), which pdf.js cannot open either. */
const LOCKED = makeDocument({
  id: LOCKED_ID,
  filename: 'locked.pdf',
  contentType: 'application/pdf',
  status: 'failed',
  failureReason: 'extract_failed',
  chunkCount: 0,
});
const PROCESSING = makeDocument({
  id: PROCESSING_ID,
  filename: 'field-notes.md',
  status: 'processing',
  chunkCount: 0,
});
const WORD = makeDocument({
  id: WORD_ID,
  filename: 'pilot-terms.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sourceId: SOURCE,
});

const MARKDOWN = [
  '# Exam week interviews',
  '',
  'Students look for a seat before nine.',
  '',
  'By noon every seat on the third floor is taken, so students leave the library.',
  '',
  'The cafe seat count was not recorded.',
].join('\n');

const CITED = 'By noon every seat on the third floor is taken, so students leave the library.';

function sourceText(overrides: Partial<SourceTextResponse> = {}): SourceTextResponse {
  return {
    source: {
      id: SOURCE,
      scope: 'venture',
      kind: 'document',
      title: 'exam-week-interviews.md',
      documentId: IDS.document,
      freshnessAt: NOW,
    },
    body: null,
    passages: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ordinal: 1,
        heading: 'Findings',
        text: 'Seats fill by nine.',
      },
      { id: PASSAGE, ordinal: 2, heading: 'Findings', text: CITED },
    ],
    truncated: false,
    ...overrides,
  };
}

let requests: string[] = [];
/** Answers `GET /documents/:id/file?disposition=attachment` with this status instead (0: signs it). */
let downloadFails = 0;

/** The API's requests for a document's file (`inline` ones, or with `?disposition=attachment`). */
const fileRequests = (id: string, disposition: 'inline' | 'attachment' = 'inline') =>
  requests.filter(
    (r) =>
      r.includes(`/documents/${id}/file`) &&
      (disposition === 'attachment') === r.includes('disposition=attachment'),
  );

function stubApi(documents: DocumentView[] = [NOTES, PDF, WORD, LOCKED, PROCESSING]) {
  requests = [];
  downloadFails = 0;
  stubFetch().mockImplementation((input) => {
    const url = urlOf(input);
    requests.push(url);
    if (url.startsWith('https://docs.test/')) return Promise.resolve(new Response(MARKDOWN));
    if (url.endsWith(`/ventures/${IDS.venture}/documents`))
      return Promise.resolve(json({ items: documents }));
    const file = /\/documents\/([0-9a-f-]+)\/file(\?disposition=attachment)?$/.exec(url);
    if (file) {
      if (file[2] && downloadFails !== 0) return Promise.resolve(problem(downloadFails, 'conflict'));
      return Promise.resolve(
        json({
          url: `https://docs.test/${file[1] ?? ''}/${file[2] ? 'download' : 'view'}`,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }),
      );
    }
    if (url.includes(`/sources/${LIBRARY}/text`)) {
      return Promise.resolve(
        json(
          sourceText({
            source: {
              id: LIBRARY,
              scope: 'program',
              kind: 'note',
              title: 'Program handbook',
              documentId: null,
              freshnessAt: NOW,
            },
            body: '## Interviews\n\nTalk to five students before you build anything.',
          }),
        ),
      );
    }
    if (url.includes(`/sources/${PDF_SOURCE}/text`)) {
      return Promise.resolve(json(sourceText({ passages: sourceText().passages.slice(1) })));
    }
    if (url.includes(`/sources/${SOURCE}/text`)) {
      if (url.includes('passage=')) {
        return Promise.resolve(json(sourceText({ passages: sourceText().passages.slice(1) })));
      }
      return Promise.resolve(json(sourceText()));
    }
    if (url.includes('/sources/')) return Promise.resolve(problem(404, 'not_found'));
    return Promise.resolve(json({ items: [] }));
  });
}

/** A venture page with something that opens the viewer, the viewer host, and a memory router. */
async function renderPage(open: OpenDocumentInput, initial = `/ain/app/v/${IDS.venture}/documents`) {
  const client = testQueryClient();
  const root = createRootRoute({ component: Outlet });
  const venture = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId',
    component: function Layout() {
      const { ventureId } = useParams({ strict: false });
      return (
        <>
          <Outlet />
          <DocumentViewerHost ventureId={ventureId ?? ''} />
        </>
      );
    },
  });
  const page = createRoute({
    getParentRoute: () => venture,
    path: 'documents',
    // A page with params of its own (like the real Documents page): the viewer's pass through it.
    validateSearch: (search: Record<string, unknown>) => ({
      source: typeof search.source === 'string' ? search.source : undefined,
    }),
    component: function Page() {
      // Opened the way the app's pages open it: a link to the same page with the viewer's params.
      return (
        <main>
          <h1>Documents</h1>
          <Link
            to="."
            search={(previous) => viewerSearchFor(previous, open)}
            state={(previous) => ({ ...previous, documentViewer: true })}
            resetScroll={false}
            data-opens-document
          >
            Open it
          </Link>
        </main>
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([venture.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
  return router;
}

async function openViewer(open: OpenDocumentInput) {
  const router = await renderPage(open);
  const user = userEvent.setup();
  const opener = screen.getByRole('link', { name: 'Open it' });
  await user.click(opener);
  // The viewer's code loads on first use (slow the first time under test).
  const dialog = await screen.findByRole('dialog', {}, { timeout: 10_000 });
  return { router, user, opener, dialog };
}

const scrolled = vi.fn();

/** A screen at least as wide as the md breakpoint (the toolbar sits in the top bar), or a phone. */
function screenWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width') ? wide : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  pdfStub.error = null;
  window.localStorage.clear();
  scrolled.mockReset();
  Element.prototype.scrollIntoView = scrolled;
  screenWidth(true);
  stubApi();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Captures what a link the viewer clicks for itself (a download) points at. */
function followedLinks() {
  const followed: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    followed.push({ href: this.href, download: this.download });
  });
  return followed;
}

describe('document viewer', () => {
  it('opens over the page as a modal dialog named by the file, and Escape returns focus to the opener', async () => {
    const { router, user, opener, dialog } = await openViewer({ documentId: IDS.document });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => {
      expect(dialog).toHaveAccessibleName('exam-week-interviews.md');
    });
    expect(within(dialog).getByText(/^Markdown · 769 B · /)).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ doc: IDS.document });
    // The Markdown is read as prose (rendered, not raw).
    expect(await within(dialog).findByRole('heading', { name: 'Exam week interviews' })).toBeInTheDocument();
    expect(requests).toContain('https://docs.test/' + IDS.document + '/view');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(router.state.location.search).not.toHaveProperty('doc', IDS.document);
    expect(opener).toHaveFocus();
  });

  it('focuses the text quietly when a pointer opened it, and marks keyboard focus once it comes back', async () => {
    const { user, dialog } = await openViewer({ documentId: IDS.document });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    const text = within(dialog).getByRole('region', { name: 'exam-week-interviews.md' });
    // Opened by a click: the text has focus (arrow keys scroll), with no ring drawn around the page.
    await waitFor(() => {
      expect(text).toHaveFocus();
    });
    expect(text).toHaveAttribute('data-quiet-focus');
    // Tabbing away and back is keyboard focus: the panel's edge shows it (viewer.css).
    await user.tab();
    expect(text).not.toHaveFocus();
    await user.tab({ shift: true });
    expect(text).toHaveFocus();
    expect(text).not.toHaveAttribute('data-quiet-focus');
  });

  it('marks the text’s focus at once when the keyboard opened the viewer', async () => {
    const router = await renderPage({ documentId: IDS.document });
    const opener = screen.getByRole('link', { name: 'Open it' });
    // jsdom draws no focus rings: the link that opens the viewer had keyboard focus.
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'matches')?.value as (
      this: Element,
      selector: string,
    ) => boolean;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? this === opener : original.call(this, selector);
    });
    opener.focus();
    await userEvent.setup().keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', {}, { timeout: 10_000 });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    expect(within(dialog).getByRole('region', { name: 'exam-week-interviews.md' })).not.toHaveAttribute(
      'data-quiet-focus',
    );
    expect(router.state.location.search).toMatchObject({ doc: IDS.document });
  });

  it('keeps focus inside while it is open', async () => {
    const { user, dialog } = await openViewer({ documentId: IDS.document });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    for (let i = 0; i < 20; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('finds text with ⌘F / Ctrl+F, steps through matches, and Escape closes find before the viewer', async () => {
    const { user, dialog } = await openViewer({ documentId: IDS.document });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    await user.keyboard('{Control>}f{/Control}');
    const input = within(dialog).getByRole('searchbox', { name: 'Find in document' });
    expect(input).toHaveFocus();
    await user.type(input, 'seat');
    await waitFor(() => {
      expect(within(dialog).getByText('1 of 3')).toBeInTheDocument();
    });
    expect(dialog.querySelectorAll('mark[data-find-index]')).toHaveLength(3);
    expect(dialog.querySelector('mark[data-active]')).toHaveAttribute('data-find-index', '0');
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText('2 of 3')).toBeInTheDocument();
    expect(dialog.querySelector('mark[data-active]')).toHaveAttribute('data-find-index', '1');
    await user.keyboard('{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}');
    expect(within(dialog).getByText('3 of 3')).toBeInTheDocument();
    expect(scrolled).toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'parking');
    await waitFor(() => {
      expect(within(dialog).getByText('No matches')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).queryByRole('searchbox')).toBeNull();
    // Back in the text, where the reader was.
    expect(within(dialog).getByRole('region', { name: 'exam-week-interviews.md' })).toHaveFocus();
    expect(dialog.querySelectorAll('mark[data-find-index]')).toHaveLength(0);
  });

  it('opens a citation at its passage, marked, with a way back to it', async () => {
    const { dialog, user } = await openViewer({ sourceId: SOURCE, passageId: PASSAGE });
    // The cited source is one of the venture's documents: shown as that document, in its own layout.
    await waitFor(() => {
      expect(dialog).toHaveAccessibleName('exam-week-interviews.md');
    });
    await waitFor(() => {
      expect(dialog.querySelector('[data-cited]')).toHaveTextContent(CITED);
    });
    expect(dialog.querySelectorAll('[data-cited]')).toHaveLength(1);
    expect(scrolled).toHaveBeenCalled();
    scrolled.mockClear();
    await user.click(within(dialog).getByRole('button', { name: 'Jump to cited passage' }));
    expect(scrolled).toHaveBeenCalled();
  });

  it('changes the text size and the reading width, and remembers both', async () => {
    const { dialog, user } = await openViewer({ documentId: IDS.document });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    const group = within(dialog).getByRole('group', { name: 'Text size' });
    expect(group).toHaveTextContent('100%');
    await user.click(within(group).getByRole('button', { name: 'A+ Larger text' }));
    expect(group).toHaveTextContent('112%');
    const prose = dialog.querySelector('[data-reader="text"]')?.parentElement;
    expect(prose?.style.fontSize).toBe('19px');
    expect(window.localStorage.getItem('fa.viewer.text-size')).toBe('3');
    const smaller = within(group).getByRole('button', { name: 'A− Smaller text' });
    for (let i = 0; i < 3; i += 1) await user.click(smaller);
    expect(group).toHaveTextContent('82%');
    expect(smaller).toBeDisabled();

    const wide = within(dialog).getByRole('button', { name: 'Wide page' });
    expect(prose?.style.maxWidth).toBe('68ch');
    await user.click(wide);
    expect(wide).toHaveAttribute('aria-pressed', 'true');
    expect(prose?.style.maxWidth).toBe('100%');
    expect(window.localStorage.getItem('fa.viewer.wide')).toBe('1');
  });

  it('shows a Word document as its extracted text, the cited passage marked by id', async () => {
    const { dialog } = await openViewer({ documentId: WORD_ID, passageId: PASSAGE });
    expect(await within(dialog).findByText('Shown as extracted text.')).toBeInTheDocument();
    await waitFor(() => {
      expect(dialog.querySelector('[data-cited]')).toHaveTextContent(CITED);
    });
    expect(within(dialog).getByRole('heading', { name: 'Findings' })).toBeInTheDocument();
    // Word files are never fetched to be shown (nor signed for: no "opened" is recorded for them).
    expect(requests).not.toContain(`https://docs.test/${WORD_ID}/view`);
    expect(fileRequests(WORD_ID)).toEqual([]);
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('pages and zooms a PDF, and offers it in a new tab and as a download', async () => {
    const { dialog, user } = await openViewer({ documentId: PDF_ID });
    expect(await within(dialog).findByTestId('pdf-stub')).toHaveTextContent('PDF pages at 1');
    const pages = await within(dialog).findByRole('group', { name: 'Pages' });
    expect(pages).toHaveTextContent('1 / 3');
    expect(within(pages).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    const zoom = within(dialog).getByRole('group', { name: 'Zoom' });
    await user.click(within(zoom).getByRole('button', { name: 'Zoom in' }));
    expect(within(dialog).getByTestId('pdf-stub')).toHaveTextContent('PDF pages at 1.25');
    expect(zoom).toHaveTextContent('125%');
    // A new tab gets the link the viewer read the file through; no download is signed until asked for.
    await waitFor(() => {
      expect(within(dialog).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
        'href',
        `https://docs.test/${PDF_ID}/view`,
      );
    });
    expect(fileRequests(PDF_ID)).toHaveLength(1);
    expect(fileRequests(PDF_ID, 'attachment')).toEqual([]);

    const followed = followedLinks();
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => {
      expect(followed).toEqual([
        { href: `https://docs.test/${PDF_ID}/download`, download: 'seat-survey.pdf' },
      ]);
    });
    expect(fileRequests(PDF_ID, 'attachment')).toHaveLength(1);
    expect(fileRequests(PDF_ID)).toHaveLength(1);
  });

  it('asks for the file once however long it stays open, and never in the background', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { dialog } = await openViewer({ documentId: PDF_ID });
    expect(await within(dialog).findByTestId('pdf-stub')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(dialog).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
        'href',
        `https://docs.test/${PDF_ID}/view`,
      );
    });
    // Ten minutes of reading, leaving the window and coming back now and then.
    for (let minute = 0; minute < 10; minute += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
    }
    focusManager.setFocused(undefined);
    expect(fileRequests(PDF_ID)).toHaveLength(1);
    expect(fileRequests(PDF_ID, 'attachment')).toEqual([]);
  });

  it('says so where the status shows when a download cannot start', async () => {
    const { dialog, user } = await openViewer({ documentId: IDS.document });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    downloadFails = 409;
    const followed = followedLinks();
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The download couldn’t start. Try again.');
    expect(alert.closest('[data-viewer-dock]')).not.toBeNull();
    expect(followed).toEqual([]);
  });

  it('says why a PDF it cannot open is not shown, and offers the download, when there is no text either', async () => {
    pdfStub.error = 'This PDF is password-protected, so it can’t be shown here.';
    const { dialog } = await openViewer({ documentId: LOCKED_ID });
    const message = await within(dialog).findByText(
      'This PDF is password-protected, so it can’t be shown here.',
    );
    expect(within(dialog).queryByText('Opening the PDF…')).toBeNull();
    const body = message.parentElement;
    if (!body) throw new Error('the message has no container');
    expect(within(body).getByText('Download it to open it in another app.')).toBeInTheDocument();
    expect(within(body).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    // The document's own status still says what went wrong in processing.
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Text couldn’t be extracted from this file.',
    );
  });

  it('shows a document’s status at the bottom of a wide screen', async () => {
    const { dialog } = await openViewer({ documentId: PROCESSING_ID });
    const status = await within(dialog).findByText(/^Processing\. .+ can cite it once it’s ready\.$/);
    expect(status).toHaveAttribute('role', 'status');
    expect(status.closest('[data-viewer-dock]')).not.toBeNull();
    expect(dialog.querySelector('.viewer-pill-dock')?.contains(status)).toBe(true);
  });

  it('lets the end of a PDF scroll clear of the page pill that floats over it', async () => {
    // jsdom lays nothing out: every element is 40px tall here.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
    const { dialog } = await openViewer({ documentId: PDF_ID });
    // The pill shows once the PDF reports its pages; the reading area is padded by it and its margin.
    await within(dialog).findByRole('group', { name: 'Pages' });
    await waitFor(() => {
      expect(dialog.style.getPropertyValue('--viewer-footer')).toBe('60px');
    });
  });

  it('shows a document’s status above the toolbar on a phone', async () => {
    screenWidth(false);
    const { dialog } = await openViewer({ documentId: PROCESSING_ID });
    const status = await within(dialog).findByText(/^Processing\. /);
    const dock = status.closest('[data-viewer-dock]');
    expect(dock).not.toBeNull();
    expect(dock?.contains(within(dialog).getByRole('toolbar', { name: 'Document controls' }))).toBe(true);
  });

  it('puts the controls in a bottom toolbar on a phone', async () => {
    screenWidth(false);
    const { dialog, user } = await openViewer({ documentId: IDS.document });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    const toolbar = within(dialog).getByRole('toolbar', { name: 'Document controls' });
    expect(within(toolbar).getByRole('button', { name: 'Find in document' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'A+ Larger text' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    // The width toggle is for wide screens only.
    expect(within(dialog).queryByRole('button', { name: 'Wide page' })).toBeNull();
    await user.click(within(toolbar).getByRole('button', { name: 'Find in document' }));
    expect(within(dialog).getByRole('searchbox', { name: 'Find in document' })).toHaveFocus();
  });

  it('keeps a phone’s toolbar to what fits its width when a PDF opens from a citation', async () => {
    screenWidth(false);
    const { dialog } = await openViewer({ documentId: PDF_ID, passageId: PASSAGE });
    await within(dialog).findByTestId('pdf-stub');
    const toolbar = within(dialog).getByRole('toolbar', { name: 'Document controls' });
    await waitFor(() => {
      expect(within(toolbar).getByRole('button', { name: 'Jump to cited passage' })).toBeInTheDocument();
    });
    const controls = within(toolbar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(controls).toEqual([
      'Find in document',
      'Zoom out',
      'Zoom in',
      'Previous page',
      'Next page',
      'Jump to cited passage',
      'Download',
    ]);
    // Icons only on a phone, and no separate tab (Download opens the file there).
    expect(within(toolbar).getByRole('button', { name: 'Jump to cited passage' })).not.toHaveTextContent(
      'Cited passage',
    );
    expect(within(dialog).queryByRole('link', { name: 'Open in a new tab' })).toBeNull();
  });

  it('reads program material from its written text', async () => {
    const { dialog } = await openViewer({ sourceId: LIBRARY });
    await waitFor(() => {
      expect(dialog).toHaveAccessibleName('Program handbook');
    });
    expect(within(dialog).getByText(/^Program guidance · Updated /)).toBeInTheDocument();
    expect(
      await within(dialog).findByText('Talk to five students before you build anything.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('says so when the document is no longer here', async () => {
    stubApi([]);
    const { dialog } = await openViewer({ documentId: IDS.document });
    expect(await within(dialog).findByText('This document is no longer here')).toBeInTheDocument();
  });

  it('opens straight from a link, and Close leaves the page without the viewer', async () => {
    const router = await renderPage(
      { documentId: IDS.document },
      `/ain/app/v/${IDS.venture}/documents?doc=${IDS.document}`,
    );
    const dialog = await screen.findByRole('dialog', {}, { timeout: 10_000 });
    await within(dialog).findByRole('heading', { name: 'Exam week interviews' });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(router.state.location.pathname).toBe(`/ain/app/v/${IDS.venture}/documents`);
    expect(router.state.location.search).toEqual({});
  });

  it('closes on Back when it was opened in the app', async () => {
    const { router } = await openViewer({ documentId: IDS.document });
    await act(async () => {
      router.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(router.state.location.search).toEqual({});
  });
});
