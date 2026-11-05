import { MemoryStatus, MemoryType } from '@foundry/contracts';
import { z } from 'zod';

/**
 * Sections of the Knowledge page besides the memory list (which has no `view`): the vEIR's notebook, the
 * evidence it can cite, and You (the student's own coaching profile and learning log).
 */
export const KNOWLEDGE_VIEWS = ['notebook', 'evidence', 'you'] as const;
export type KnowledgeView = (typeof KNOWLEDGE_VIEWS)[number];

/** URL state of the Knowledge page: shareable and back-button friendly. */
export interface KnowledgeSearch {
  /** Absent is the memory list. */
  view?: KnowledgeView | undefined;
  type?: MemoryType | undefined;
  status?: MemoryStatus | undefined;
  pinned?: boolean | undefined;
  q?: string | undefined;
  /** Selected memory item, shown in the side panel. */
  m?: string | undefined;
  /** A cited source to show highlighted in Evidence (its knowledge source id). */
  source?: string | undefined;
  /** Opens "Add memory" on arrival (the command palette's action); dropped from the URL once opened. */
  add?: true | undefined;
}

function isView(value: unknown): value is KnowledgeView {
  return typeof value === 'string' && (KNOWLEDGE_VIEWS as readonly string[]).includes(value);
}

/**
 * Parses the Knowledge search params. Older links keep working: `view=all`, the review queue that is gone
 * (`view=proposed`), a `status=proposed` filter and the conversations list that is gone
 * (`view=conversations`: the side panel and ⌘K list them) all open the memory list, which shows everything
 * the vEIR knows.
 */
export function validateKnowledgeSearch(search: Record<string, unknown>): KnowledgeSearch {
  const type = MemoryType.safeParse(search.type);
  const status = MemoryStatus.safeParse(search.status);
  const id = z.uuid().safeParse(search.m);
  const source = z.uuid().safeParse(search.source);
  const proposed = status.success && status.data === 'proposed';
  return {
    view: isView(search.view) ? search.view : undefined,
    type: type.success ? type.data : undefined,
    status: status.success && !proposed ? status.data : undefined,
    pinned: search.pinned === true || search.pinned === 'true' ? true : undefined,
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim().slice(0, 200) : undefined,
    m: id.success ? id.data : undefined,
    source: source.success ? source.data : undefined,
    add:
      search.add === true || search.add === 'true' || search.add === 1 || search.add === '1'
        ? true
        : undefined,
  };
}
