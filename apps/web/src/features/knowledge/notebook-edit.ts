import type { NotebookEdit, VeirNotebook } from '@foundry/contracts';

/**
 * The notebook as it looks right after a person's edit, for the optimistic update. Mirrors the server's
 * rule (`applyNotebookEdit` in core): the response replaces it, so only what the person sees matters
 * here. The version is left alone; the server bumps it.
 */
export function applyNotebookEditLocally(
  notebook: VeirNotebook,
  edit: NotebookEdit,
  now: string = new Date().toISOString(),
): VeirNotebook {
  const touched = { lastEditedBy: 'person' as const, updatedAt: now };
  switch (edit.action) {
    case 'edit_summary':
      return { ...notebook, ...touched, summary: edit.summary.trim() };
    case 'edit_entry':
      return {
        ...notebook,
        ...touched,
        [edit.section]: notebook[edit.section].map((entry) =>
          entry.id === edit.id ? { ...entry, text: edit.text.trim() } : entry,
        ),
      };
    case 'remove_entry':
      return {
        ...notebook,
        ...touched,
        [edit.section]: notebook[edit.section].filter((entry) => entry.id !== edit.id),
      };
    case 'edit_commitment':
      return {
        ...notebook,
        ...touched,
        commitments: notebook.commitments.map((commitment) =>
          commitment.id === edit.id
            ? {
                ...commitment,
                ...(edit.text === undefined ? {} : { text: edit.text.trim() }),
                ...(edit.due === undefined ? {} : { due: edit.due }),
                ...(edit.status === undefined ? {} : { status: edit.status }),
              }
            : commitment,
        ),
      };
    case 'remove_commitment':
      return {
        ...notebook,
        ...touched,
        commitments: notebook.commitments.filter((commitment) => commitment.id !== edit.id),
      };
    // The greeting New chat shows is the server's checked copy of the opener: none until the server answers.
    case 'edit_opener':
      return { ...notebook, ...touched, nextOpener: edit.text.trim(), greeting: null };
    case 'remove_opener':
      return { ...notebook, ...touched, nextOpener: null, greeting: null };
    case 'clear':
      return {
        ...notebook,
        ...touched,
        summary: '',
        founderProfile: [],
        commitments: [],
        openQuestions: [],
        lastAdvice: [],
        nextOpener: null,
        greeting: null,
      };
  }
}

/** True when the notebook holds nothing (a fresh one, or one a person cleared). */
export function isNotebookEmpty(notebook: VeirNotebook): boolean {
  return (
    notebook.summary.trim() === '' &&
    notebook.founderProfile.length === 0 &&
    notebook.commitments.length === 0 &&
    notebook.openQuestions.length === 0 &&
    notebook.lastAdvice.length === 0 &&
    notebook.nextOpener === null
  );
}
