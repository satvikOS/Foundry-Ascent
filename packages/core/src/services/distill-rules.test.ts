import {
  type DistillDraft,
  ModelOutputInvalidError,
  ModelRefusalError,
  ModelUnavailableError,
} from '@foundry/ai';
import { type notebooksRepo, type sessionsRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import {
  distillSkipReason,
  dropSuppressed,
  filenameWords,
  humanAdviceIds,
  withoutAdviceRewrites,
  keepHumanAdvice,
  modelFailure,
  personaCanDistill,
  previousNeedsDistill,
  removedSince,
  sameNotebook,
  staleWriteReason,
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

  it('leaves a job queued at fewer turns to the job of the later turn (one model call per burst)', () => {
    const idle = { ...state, lastActivityAt: minutesAgo(9) };
    expect(distillSkipReason(idle, NOW, ACTIVE_WINDOW, 3)).toBe('superseded');
    expect(distillSkipReason(idle, NOW, ACTIVE_WINDOW, 4)).toBeNull();
    // The backstop queues nothing: no turn count, no supersession.
    expect(distillSkipReason(idle, NOW, ACTIVE_WINDOW)).toBeNull();
    // Up to date wins over superseded (nothing to do either way, the cheaper reason is reported).
    expect(distillSkipReason({ ...idle, distillVersion: 4 }, NOW, ACTIVE_WINDOW, 3)).toBe('up_to_date');
  });

  it('never skips a settled conversation as active: a call in it ended, or its person moved on', () => {
    const recent = { ...state, lastActivityAt: minutesAgo(0.5) };
    expect(distillSkipReason(recent, NOW, ACTIVE_WINDOW)).toBe('active');
    expect(distillSkipReason(recent, NOW, ACTIVE_WINDOW, 4, true)).toBeNull();
    // Settling never overrides the other checks.
    expect(distillSkipReason({ ...recent, privacy: 'ephemeral' }, NOW, ACTIVE_WINDOW, 4, true)).toBe(
      'ephemeral',
    );
    expect(distillSkipReason({ ...recent, distillVersion: 4 }, NOW, ACTIVE_WINDOW, 4, true)).toBe(
      'up_to_date',
    );
    expect(distillSkipReason(recent, NOW, ACTIVE_WINDOW, 3, true)).toBe('superseded');
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

describe('personaCanDistill', () => {
  const consent = { revokedAt: null, expiresAt: null };
  const eirPersona = { status: 'active' as const, kind: 'eir_persona' as const };

  it('distils for an active persona whose EIR consent is in force', () => {
    expect(personaCanDistill(eirPersona, consent, NOW)).toBe(true);
    expect(personaCanDistill(eirPersona, { ...consent, expiresAt: minutesAgo(-60) }, NOW)).toBe(true);
    expect(personaCanDistill({ status: 'active', kind: 'neutral_guide' }, null, NOW)).toBe(true);
  });

  it('never distils for a suspended or retired persona, or one whose consent was revoked or lapsed', () => {
    expect(personaCanDistill({ ...eirPersona, status: 'suspended' }, consent, NOW)).toBe(false);
    expect(personaCanDistill({ ...eirPersona, status: 'retired' }, consent, NOW)).toBe(false);
    expect(personaCanDistill(eirPersona, null, NOW)).toBe(false);
    expect(personaCanDistill(eirPersona, { ...consent, revokedAt: minutesAgo(5) }, NOW)).toBe(false);
    expect(personaCanDistill(eirPersona, { ...consent, expiresAt: minutesAgo(1) }, NOW)).toBe(false);
  });
});

describe('modelFailure (what a failed model call means for the queued job)', () => {
  const queued = { answers: 0, lastDelivery: false };
  const last = { answers: 0, lastDelivery: true };

  it('retries an unavailable, throttled or timed-out model, and a call cancelled at the deadline', () => {
    expect(modelFailure(new ModelUnavailableError('throttled', 'm'), last)).toBeNull();
    expect(modelFailure(new ModelUnavailableError('timeout', 'm'), last)).toBeNull();
    expect(modelFailure(new ModelUnavailableError('aborted', 'm'), queued)).toBeNull();
  });

  it('records a configuration or request error at once: retrying never helps', () => {
    expect(modelFailure(new ModelUnavailableError('config', 'm'), queued)).toBe('model_unavailable:config');
    expect(modelFailure(new ModelUnavailableError('client_error', 'm'), queued)).toBe(
      'model_unavailable:client_error',
    );
  });

  it('gives an invalid or refused answer one more delivery, then records it; inline runs record at once', () => {
    const invalid = new ModelOutputInvalidError('m', ['(root): x']);
    expect(modelFailure(invalid, { answers: 1, lastDelivery: false })).toBeNull();
    expect(modelFailure(invalid, { answers: 2, lastDelivery: false })).toBe('model_output_invalid');
    expect(modelFailure(new ModelRefusalError('m', 'model'), { answers: 1, lastDelivery: false })).toBeNull();
    expect(modelFailure(new ModelRefusalError('m', 'model'), { answers: 2, lastDelivery: false })).toBe(
      'model_refusal',
    );
    // An inline run (the backstop) is its own last delivery.
    expect(modelFailure(invalid, { answers: 1, lastDelivery: true })).toBe('model_output_invalid');
  });

  it('counts the answers the model gave, not the deliveries the worker deferred before calling it', () => {
    const invalid = new ModelOutputInvalidError('m', ['(root): x']);
    // A second delivery whose first was deferred unstarted: this is the first answer, so it is tried again.
    expect(modelFailure(invalid, { answers: 1, lastDelivery: false })).toBeNull();
    // The queue's last delivery records it whatever the count: nothing would retry it.
    expect(modelFailure(invalid, { answers: 1, lastDelivery: true })).toBe('model_output_invalid');
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

  it('a second call minutes after the first finds the first distilled: only a short grace applies', () => {
    const GRACE = 60;
    expect(previousNeedsDistill({ ...previous, lastActivityAt: minutesAgo(3) }, NOW, GRACE)).toBe(true);
    expect(previousNeedsDistill({ ...previous, lastActivityAt: minutesAgo(1.5) }, NOW, GRACE)).toBe(true);
    // A turn within the grace may still be going on in another tab.
    expect(previousNeedsDistill({ ...previous, lastActivityAt: minutesAgo(0.5) }, NOW, GRACE)).toBe(false);
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

describe('withoutAdviceRewrites', () => {
  it('drops model rewrites of human-help advice and keeps every other line', () => {
    const draft = draftWith({
      summary: 'x',
      founder_profile: [{ id: 'fp-1', text: 'Likes numbers' }],
      commitments: [],
      open_questions: [],
      last_advice: [
        { id: 'esc-1', text: 'Reworded advice' },
        { id: 'la-1', text: 'Price per room' },
        { id: null, text: 'New advice' },
      ],
      next_opener: null,
    });
    const out = withoutAdviceRewrites(draft, new Set(['esc-1']));
    expect(out.notebook.last_advice.map((n) => n.id)).toEqual(['la-1', null]);
    expect(out.notebook.founder_profile).toHaveLength(1);
    expect(withoutAdviceRewrites(draft, new Set())).toBe(draft);
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

  it('compares the six content sections only, never bookkeeping the stored document carries', () => {
    const stored = { ...notebook, summarySources: ['55555555-5555-4555-8555-000000000001'] };
    expect(sameNotebook(stored as notebooksRepo.NotebookContent, notebook)).toBe(true);
  });
});

describe('keepHumanAdvice (escalation advice outlives the distillation after it)', () => {
  const advice = (id: string, text: string, createdAt: string) => ({
    id,
    text,
    sourceSessionId: null,
    createdAt,
  });
  const human = advice(
    'esc-1',
    'From Corin Halvorsen (human help): Wait for the pilot data before signing.',
    '2026-10-12T10:00:00.000Z',
  );
  const older = advice('la-1', 'Price the pilot per room, not per seat', '2026-10-10T10:00:00.000Z');

  it('finds the human-help lines of a notebook', () => {
    expect(humanAdviceIds({ ...notebook, lastAdvice: [human, older] })).toEqual(['esc-1']);
    expect(humanAdviceIds(null)).toEqual([]);
  });

  it('puts back the advice a person gave when the model left it out, newest first', () => {
    const fresh = advice('la-9', 'Ask the second library for a letter of intent', '2026-10-16T12:00:00.000Z');
    expect(keepHumanAdvice([fresh, older], [human, older], new Set(), 5).map((e) => e.id)).toEqual([
      'la-9',
      'esc-1',
      'la-1',
    ]);
    // Already there: unchanged.
    expect(keepHumanAdvice([human, older], [human, older], new Set(), 5)).toEqual([human, older]);
  });

  it('drops a model line that restates it, and lets newer advice push it out past the cap', () => {
    const restated = advice('la-8', 'Wait for the pilot data before signing.', '2026-10-16T12:00:00.000Z');
    expect(keepHumanAdvice([restated], [human], new Set(), 5)).toEqual([human]);
    const newer = [1, 2, 3, 4, 5].map((n) =>
      advice(`la-n${String(n)}`, `New advice number ${String(n)}`, '2026-10-16T12:00:00.000Z'),
    );
    expect(keepHumanAdvice(newer, [human], new Set(), 5).map((e) => e.id)).not.toContain('esc-1');
    // A line a person edited is never the one pushed out.
    const kept = keepHumanAdvice([...newer.slice(0, 4), older], [human, older], new Set(['la-1']), 5);
    expect(kept.map((e) => e.id)).toContain('la-1');
    expect(kept).toHaveLength(5);
  });
});

describe('filenameWords', () => {
  it('turns a document name into words for the lesson denylist', () => {
    expect(filenameWords('northfield-pilot_terms.v2.pdf')).toBe('northfield pilot terms v2');
    expect(filenameWords('notes.md')).toBe('notes');
  });
});
