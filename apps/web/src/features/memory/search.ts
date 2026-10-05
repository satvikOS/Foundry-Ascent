import { MemoryStatus, MemoryType } from '@foundry/contracts';
import { z } from 'zod';

/** URL state for the memory explorer (shareable, back-button friendly). */
export interface MemorySearch {
  view?: 'all' | 'proposed' | undefined;
  type?: MemoryType | undefined;
  status?: MemoryStatus | undefined;
  pinned?: boolean | undefined;
  q?: string | undefined;
  /** Selected memory id (shown in the inspector). */
  m?: string | undefined;
  layout?: 'list' | 'table' | undefined;
}

export function validateMemorySearch(search: Record<string, unknown>): MemorySearch {
  const type = MemoryType.safeParse(search.type);
  const status = MemoryStatus.safeParse(search.status);
  const id = z.uuid().safeParse(search.m);
  return {
    view: search.view === 'proposed' || search.view === 'all' ? search.view : undefined,
    type: type.success ? type.data : undefined,
    status: status.success ? status.data : undefined,
    pinned: search.pinned === true || search.pinned === 'true' ? true : undefined,
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim().slice(0, 200) : undefined,
    m: id.success ? id.data : undefined,
    layout: search.layout === 'table' || search.layout === 'list' ? search.layout : undefined,
  };
}
