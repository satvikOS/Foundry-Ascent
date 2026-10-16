import { describe, expect, it } from 'vitest';

import { applyNotebookEditLocally, isNotebookEmpty } from './notebook-edit';
import { makeNotebook } from './testing';

const AT = '2026-10-02T08:00:00.000Z';

describe('applyNotebookEditLocally', () => {
  const notebook = makeNotebook();

  it('edits and removes a line in the named section only', () => {
    const edited = applyNotebookEditLocally(
      notebook,
      {
        action: 'edit_entry',
        section: 'founderProfile',
        id: 'fp-numbers',
        text: '  Numbers first, always. ',
      },
      AT,
    );
    expect(edited.founderProfile[0]?.text).toBe('Numbers first, always.');
    expect(edited.openQuestions).toEqual(notebook.openQuestions);
    expect(edited.lastEditedBy).toBe('person');
    expect(edited.updatedAt).toBe(AT);
    // The server owns the version.
    expect(edited.version).toBe(notebook.version);

    const removed = applyNotebookEditLocally(
      notebook,
      { action: 'remove_entry', section: 'openQuestions', id: 'q-chat' },
      AT,
    );
    expect(removed.openQuestions).toEqual([]);
    expect(removed.founderProfile).toEqual(notebook.founderProfile);
  });

  it('changes only the commitment fields that were sent', () => {
    const done = applyNotebookEditLocally(
      notebook,
      { action: 'edit_commitment', id: 'c-interviews', status: 'done' },
      AT,
    );
    expect(done.commitments[0]).toMatchObject({
      status: 'done',
      text: 'Interview five library staff',
      due: '2026-10-08',
    });

    const undated = applyNotebookEditLocally(
      notebook,
      { action: 'edit_commitment', id: 'c-interviews', due: null },
      AT,
    );
    expect(undated.commitments[0]).toMatchObject({ status: 'open', due: null });

    const gone = applyNotebookEditLocally(notebook, { action: 'remove_commitment', id: 'c-interviews' }, AT);
    expect(gone.commitments).toEqual([]);
  });

  it('edits the summary and the opener, and removes the opener', () => {
    expect(
      applyNotebookEditLocally(notebook, { action: 'edit_summary', summary: ' Short. ' }, AT).summary,
    ).toBe('Short.');
    expect(
      applyNotebookEditLocally(notebook, { action: 'edit_opener', text: 'How did it go?' }, AT).nextOpener,
    ).toBe('How did it go?');
    expect(applyNotebookEditLocally(notebook, { action: 'remove_opener' }, AT).nextOpener).toBeNull();
  });

  it('clears everything', () => {
    const cleared = applyNotebookEditLocally(notebook, { action: 'clear' }, AT);
    expect(isNotebookEmpty(cleared)).toBe(true);
    expect(isNotebookEmpty(notebook)).toBe(false);
    expect(cleared.personaName).toBe(notebook.personaName);
  });
});
