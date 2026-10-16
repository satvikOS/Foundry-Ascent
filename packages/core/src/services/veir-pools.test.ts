import { notebooksRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { measureCalls, currentCallMinutes, remainingCallMinutes } from './call-usage.js';
import { summarize } from './knowledge-library.js';
import { applyNotebookEdit, isSuppressed, notebookFingerprint } from './notebook.js';
import { isSpeakable, speakableText } from './speech.js';
import { embodimentView, shortName } from './veir.js';
import { speechCostUsd, speechEngines } from './voices.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const SESSION = '6f1c3a52-9d7e-4b0a-8f2e-3c5d7a9b1e04';

const notebook: notebooksRepo.NotebookContent = {
  summary: 'Testing exam-week demand.',
  founderProfile: [
    { id: 'fp-1', text: 'Prefers short answers.', sourceSessionId: SESSION, createdAt: NOW.toISOString() },
    { id: 'fp-2', text: 'Likes numbers first.', sourceSessionId: null, createdAt: NOW.toISOString() },
  ],
  commitments: [
    {
      id: 'c-1',
      text: 'Interview five library staff',
      due: '2026-10-20',
      status: 'open',
      sourceSessionId: SESSION,
      createdAt: NOW.toISOString(),
    },
  ],
  openQuestions: [],
  lastAdvice: [],
  nextOpener: 'How did the interviews go?',
};

describe('notebook edits', () => {
  it('fingerprints lines by their words only', () => {
    expect(notebookFingerprint('Prefers SHORT answers!')).toBe(
      notebookFingerprint('prefers short   answers'),
    );
    expect(notebookFingerprint('Prefers short answers')).not.toBe(
      notebookFingerprint('Prefers long answers'),
    );
    expect(notebookFingerprint('x')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('corrects and removes lines, remembering what was replaced', () => {
    const edited = applyNotebookEdit(
      notebook,
      [],
      { action: 'edit_entry', section: 'founderProfile', id: 'fp-1', text: 'Prefers detailed answers.' },
      NOW,
    );
    expect(edited.content.founderProfile[0]).toMatchObject({ id: 'fp-1', text: 'Prefers detailed answers.' });
    expect(isSuppressed(edited.suppressed, 'founderProfile', 'prefers short answers')).toBe(true);
    const removed = applyNotebookEdit(
      edited.content,
      edited.suppressed,
      { action: 'remove_entry', section: 'founderProfile', id: 'fp-2' },
      NOW,
    );
    expect(removed.content.founderProfile.map((e) => e.id)).toEqual(['fp-1']);
    expect(removed.suppressed).toHaveLength(2);
    expect(() =>
      applyNotebookEdit(notebook, [], { action: 'remove_entry', section: 'lastAdvice', id: 'nope' }, NOW),
    ).toThrow(/not found/);
  });

  it('updates commitments, validating due dates', () => {
    const done = applyNotebookEdit(
      notebook,
      [],
      { action: 'edit_commitment', id: 'c-1', status: 'done' },
      NOW,
    );
    expect(done.content.commitments[0]).toMatchObject({
      status: 'done',
      text: 'Interview five library staff',
    });
    expect(done.suppressed).toEqual([]);
    expect(() =>
      applyNotebookEdit(notebook, [], { action: 'edit_commitment', id: 'c-1', due: '2026-02-31' }, NOW),
    ).toThrow(/due date/);
    const gone = applyNotebookEdit(notebook, [], { action: 'remove_commitment', id: 'c-1' }, NOW);
    expect(gone.content.commitments).toEqual([]);
    expect(isSuppressed(gone.suppressed, 'commitments', 'Interview five library staff')).toBe(true);
  });

  it('clears everything and suppresses every line', () => {
    const cleared = applyNotebookEdit(notebook, [], { action: 'clear' }, NOW);
    expect(cleared.content).toEqual(notebooksRepo.EMPTY_NOTEBOOK);
    expect(cleared.suppressed.map((s) => s.section).sort()).toEqual(
      ['commitments', 'founderProfile', 'founderProfile', 'nextOpener', 'summary'].sort(),
    );
  });
});

describe('speech text', () => {
  const source = {
    spoken: 'Run the map only in exam weeks. Under fifteen percent means stop.',
    answer:
      'Not yet. **38 of 200** is 19% [E1], below your bar.\n\n- Rerun in [finals](https://x.test) weeks (E2)',
  };

  it('reads answers as plain sentences', () => {
    expect(speakableText(source.answer)).toBe(
      'Not yet. 38 of 200 is 19%, below your bar. Rerun in finals weeks',
    );
  });

  it('accepts only passages of the stored validated reply', () => {
    expect(isSpeakable('Run the map only in exam weeks.', source)).toBe(true);
    expect(isSpeakable('under fifteen percent means stop.', source)).toBe(true);
    expect(isSpeakable('38 of 200 is 19%', source)).toBe(true);
    expect(isSpeakable('Rerun in finals weeks', source)).toBe(true);
    expect(isSpeakable('Run the map every week.', source)).toBe(false);
    expect(isSpeakable('   ', source)).toBe(false);
    expect(isSpeakable('Not yet.', { spoken: null, answer: null })).toBe(false);
  });
});

describe('call minutes', () => {
  const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

  it('groups spoken turns into calls and measures them', () => {
    const usage = measureCalls(
      [
        // A finished call: 08:00–08:12 plus the tail minute.
        { sessionId: 'a', at: at(240) },
        { sessionId: 'a', at: at(234) },
        { sessionId: 'a', at: at(228) },
        // An ongoing call in another conversation, started 6 minutes ago.
        { sessionId: 'b', at: at(6) },
        { sessionId: 'b', at: at(2) },
      ],
      NOW,
    );
    expect(usage.segments).toHaveLength(2);
    expect(usage.minutesToday).toBeCloseTo(13 + 6, 5);
    expect(currentCallMinutes(usage, 'b')).toBeCloseTo(6, 5);
    expect(currentCallMinutes(usage, 'a')).toBe(0);
    expect(remainingCallMinutes(usage, 60)).toBe(41);
    expect(remainingCallMinutes(usage, 10)).toBe(0);
  });

  it('splits a conversation into two calls after a long pause', () => {
    const usage = measureCalls(
      [
        { sessionId: 'a', at: at(120) },
        { sessionId: 'a', at: at(100) },
      ],
      NOW,
    );
    expect(usage.segments.map((s) => s.minutes)).toEqual([1, 1]);
  });
});

describe('embodiment and voices', () => {
  it('shows a voice only with consent (the neutral guide needs none) and never a portrait yet', () => {
    const embodiment = { provider: 'builtin' as const, voiceId: 'Matthew', portraitKey: 'k' };
    expect(embodimentView({ kind: 'eir_persona', embodiment }, ['doctrine'])).toEqual({
      provider: 'builtin',
      voiceId: null,
      portraitUrl: null,
      voiceConsented: false,
      likenessConsented: false,
    });
    expect(embodimentView({ kind: 'eir_persona', embodiment }, ['voice', 'likeness'])).toMatchObject({
      voiceId: 'Matthew',
      voiceConsented: true,
      likenessConsented: true,
    });
    expect(embodimentView({ kind: 'neutral_guide', embodiment }, [])).toMatchObject({ voiceId: 'Matthew' });
  });

  it('names the vEIR by the EIR’s first name', () => {
    expect(shortName({ kind: 'eir_persona', name: "Corin's vEIR" }, 'Corin Halvorsen')).toBe('Corin');
    expect(shortName({ kind: 'neutral_guide', name: 'Foundry Guide' }, null)).toBe('Foundry Guide');
  });

  it('prefers the generative engine and prices characters', () => {
    expect(speechEngines('Ruth')).toEqual(['generative', 'neural']);
    expect(speechEngines('Gregory')).toEqual(['neural']);
    expect(speechEngines('Unknown')).toEqual(['generative', 'neural']);
    expect(speechCostUsd(1_000_000, 'generative')).toBe(30);
    expect(speechCostUsd(500, 'neural')).toBeCloseTo(0.008, 6);
  });
});

describe('authored note summaries', () => {
  it('takes the first real paragraph, cut at a word', () => {
    expect(summarize('## Heading\n\nShort.\n\nThe first **real** paragraph of the note is here.')).toBe(
      'The first real paragraph of the note is here.',
    );
    const long = summarize(`${'word '.repeat(100)}end`);
    expect(long?.length).toBeLessThanOrEqual(281);
    expect(long?.endsWith('…')).toBe(true);
    expect(summarize('tiny')).toBeNull();
  });
});
