import { type DistillDraft } from '@foundry/ai';
import { type notebooksRepo, type sessionsRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import {
  distillSkipReason,
  dropSuppressed,
  filenameWords,
  previousNeedsDistill,
  removedSince,
  sameNotebook,
  staleWriteReason,
  withoutPinnedRewrites,
} from './distill-rules.js';
import { notebookFingerprint } from './notebook.js';

const NOW = new Date('2026-10-16T12:00:00Z');
const ACTIVE_WINDOW = 480;
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const state = {
  privacy: 'standard' as const,
  deletedAt: null,
  digestDeletedAt: null,
  completedTurns: 4,
  distillVersion: 0,
  status: 'active' as const,
  lastActivityAt: minutesAgo(9),
};

describe('distillSkipReason (the cheap checks of a queued distill_session)', () => {
  it('distils a standard conversation idle for longer than the active window', () => {
    expect(distillSkipReason(state, NOW, ACTIVE_WINDOW)).toBeNull();
  });

  it('skips a conversation that is gone, deleted, temporary or whose digest a person deleted', () => {
    expect(distillSkipReason(null, NOW, ACTIVE_WINDOW)).toBe('not_found');
    expect(distillSkipReason({ ...state, deletedAt: minutesAgo(1) }, NOW, ACTIVE_WINDOW)).toBe('deleted');
    expect(distillSkipReason({ ...state, privacy: 'ephemeral' }, NOW, ACTIVE_WINDOW)).toBe('ephemeral');
    expect(distillSkipReason({ ...state, digestDeletedAt: minutesAgo(2) }, NOW, ACTIVE_WINDOW)).toBe(
      'digest_deleted',
    );
  });

  it('is idempotent per turn count: nothing new means nothing to do', () => {
    expect(distillSkipReason({ ...state, completedTurns: 0 }, NOW, ACTIVE_WINDOW)).toBe('no_turns');
    expect(distillSkipReason({ ...state, distillVersion: 4 }, NOW, ACTIVE_WINDOW)).toBe('up_to_date');
    expect(distillSkipReason({ ...state, distillVersion: 3 }, NOW, ACTIVE_WINDOW)).toBeNull();
  });

  it('skips an active conversation: the job of its later turn covers it', () => {
    expect(distillSkipReason({ ...state, lastActivityAt: minutesAgo(7.9) }, NOW, ACTIVE_WINDOW)).toBe(
      'active',
    );
    expect(distillSkipReason({ ...state, lastActivityAt: minutesAgo(8) }, NOW, ACTIVE_WINDOW)).toBeNull();
    // Ending a conversation queues distillation at once: an ended conversation is never active.
    expect(
      distillSkipReason({ ...state, status: 'ended', lastActivityAt: minutesAgo(0) }, NOW, ACTIVE_WINDOW),
    ).toBeNull();
  });

  it('the 9-minute delay of the last turn lands after its 8-minute active window', () => {
    const delay = 540;
    expect(
      distillSkipReason({ ...state, lastActivityAt: minutesAgo(delay / 60) }, NOW, ACTIVE_WINDOW),
    ).toBeNull();
    // An earlier turn's job lands while a later turn is recent: skipped.
    expect(distillSkipReason({ ...state, lastActivityAt: minutesAgo(2) }, NOW, ACTIVE_WINDOW)).toBe('active');
  });
});

describe('staleWriteReason (re-check under the row lock)', () => {
  it('refuses to write over a deletion, a digest deletion or a run that covered as many turns', () => {
    expect(staleWriteReason(state, 4)).toBeNull();
    expect(staleWriteReason(null, 4)).toBe('not_found');
    expect(staleWriteReason({ ...state, deletedAt: minutesAgo(0) }, 4)).toBe('deleted');
    expect(staleWriteReason({ ...state, digestDeletedAt: minutesAgo(0) }, 4)).toBe('digest_deleted');
    expect(staleWriteReason({ ...state, distillVersion: 4 }, 4)).toBe('up_to_date');
    expect(staleWriteReason({ ...state, distillVersion: 5 }, 4)).toBe('up_to_date');
  });
});

describe('previousNeedsDistill (a new conversation distils the previous one)', () => {
  const previous: sessionsRepo.PreviousConversation = {
    id: '55555555-5555-4555-8555-000000000001',
    status: 'active',
    privacy: 'standard',
    lastActivityAt: minutesAgo(30),
    distillVersion: 1,
    digestDeleted: false,
    completedTurns: 3,
  };

  it('queues an idle conversation with turns no digest covers', () => {
    expect(previousNeedsDistill(previous, NOW, ACTIVE_WINDOW)).toBe(true);
    expect(
      previousNeedsDistill(
        { ...previous, status: 'ended', lastActivityAt: minutesAgo(1) },
        NOW,
        ACTIVE_WINDOW,
      ),
    ).toBe(true);
  });

  it('leaves alone a distilled, temporary, digest-deleted or still active conversation, or none', () => {
    expect(previousNeedsDistill(null, NOW, ACTIVE_WINDOW)).toBe(false);
    expect(previousNeedsDistill({ ...previous, distillVersion: 3 }, NOW, ACTIVE_WINDOW)).toBe(false);
    expect(previousNeedsDistill({ ...previous, privacy: 'ephemeral' }, NOW, ACTIVE_WINDOW)).toBe(false);
    expect(previousNeedsDistill({ ...previous, digestDeleted: true }, NOW, ACTIVE_WINDOW)).toBe(false);
    expect(previousNeedsDistill({ ...previous, lastActivityAt: minutesAgo(3) }, NOW, ACTIVE_WINDOW)).toBe(
      false,
    );
  });
});

const entry = (id: string, text: string): notebooksRepo.NotebookContent['founderProfile'][number] => ({
  id,
  text,
  sourceSessionId: null,
  createdAt: '2026-10-10T10:00:00.000Z',
});

const notebook: notebooksRepo.NotebookContent = {
  summary: 'Maya is testing a study-room finder. Two libraries agreed to a pilot.',
  founderProfile: [entry('fp-1', 'Prefers short answers'), entry('fp-2', 'Likes numbers')],
  commitments: [
    {
      id: 'cm-1',
      text: 'Interview five library staff',
      due: '2026-10-20',
      status: 'open',
      sourceSessionId: null,
      createdAt: '2026-10-10T10:00:00.000Z',
    },
  ],
  openQuestions: [entry('oq-1', 'Who pays for the pilot?')],
  lastAdvice: [entry('la-1', 'Price the pilot per room, not per seat')],
  nextOpener: 'Last time you planned five interviews. How did they go?',
};

function draftWith(notes: DistillDraft['notebook']): DistillDraft {
  return {
    title: 'Pilot pricing',
    digest: { summary: 's', topics: [], commitments: [], open_questions: [] },
    notebook: notes,
    memory_candidates: [],
    lesson_candidates: [],
  };
}

describe('withoutPinnedRewrites', () => {
  it('drops model rewrites of lines a person edited, keeps everything else', () => {
    const draft = draftWith({
      summary: 'x',
      founder_profile: [
        { id: 'fp-1', text: 'Likes thorough, detailed explanations' },
        { id: 'fp-2', text: 'Likes numbers' },
        { id: null, text: 'Thinks out loud' },
      ],
      commitments: [{ id: 'cm-1', text: 'Interview five', due: null, status: 'open' }],
      open_questions: [{ id: 'oq-1', text: 'Who pays?' }],
      last_advice: [{ id: 'la-1', text: 'Price per room' }],
      next_opener: null,
    });
    const out = withoutPinnedRewrites(draft, new Set(['fp-1', 'oq-1', 'summary']));
    expect(out.notebook.founder_profile.map((n) => n.id)).toEqual(['fp-2', null]);
    expect(out.notebook.open_questions).toEqual([]);
    expect(out.notebook.last_advice).toHaveLength(1);
    expect(out.notebook.commitments).toHaveLength(1);
    expect(draft.notebook.founder_profile).toHaveLength(3);
  });
});

describe('removedSince', () => {
  it('lists texts a person removed or reworded after the model saw them', () => {
    const after: notebooksRepo.NotebookContent = {
      ...notebook,
      founderProfile: [entry('fp-2', 'Likes numbers')],
      openQuestions: [entry('oq-1', 'Who pays for the two-library pilot?')],
      nextOpener: null,
    };
    expect(removedSince(notebook, after)).toEqual([
      'Prefers short answers',
      'Who pays for the pilot?',
      'Last time you planned five interviews. How did they go?',
    ]);
    expect(removedSince(notebook, notebook)).toEqual([]);
    expect(removedSince(null, notebook)).toEqual([]);
  });
});

describe('dropSuppressed', () => {
  const suppressed = (section: notebooksRepo.SuppressedLine['section'], text: string) => ({
    section,
    fingerprint: notebookFingerprint(text),
    at: '2026-10-11T00:00:00.000Z',
  });

  it('never writes back a line a person removed, in any section or a summary sentence', () => {
    const { content, dropped } = dropSuppressed(notebook, [
      suppressed('founderProfile', 'prefers SHORT answers!'),
      suppressed('lastAdvice', 'Two libraries agreed to a pilot.'),
      suppressed('nextOpener', 'Last time you planned five interviews. How did they go?'),
      suppressed('commitments', 'Interview five library staff'),
    ]);
    expect(content.founderProfile.map((e) => e.id)).toEqual(['fp-2']);
    expect(content.summary).toBe('Maya is testing a study-room finder.');
    expect(content.nextOpener).toBeNull();
    expect(content.commitments).toEqual([]);
    expect(dropped).toBe(4);
  });

  it('clears a summary a person removed as a whole and leaves everything when nothing is suppressed', () => {
    expect(dropSuppressed(notebook, [suppressed('summary', notebook.summary)]).content.summary).toBe('');
    expect(dropSuppressed(notebook, [])).toEqual({ content: notebook, dropped: 0 });
  });
});

describe('sameNotebook', () => {
  it('compares contents regardless of key order', () => {
    const reordered = JSON.parse(
      JSON.stringify({ ...notebook, nextOpener: notebook.nextOpener, summary: notebook.summary }),
    ) as notebooksRepo.NotebookContent;
    expect(sameNotebook(notebook, reordered)).toBe(true);
    expect(sameNotebook(notebook, { ...notebook, summary: 'other' })).toBe(false);
    expect(sameNotebook(null, notebook)).toBe(false);
  });
});

describe('filenameWords', () => {
  it('turns a document name into words for the lesson denylist', () => {
    expect(filenameWords('northfield-pilot_terms.v2.pdf')).toBe('northfield pilot terms v2');
    expect(filenameWords('notes.md')).toBe('notes');
  });
});
