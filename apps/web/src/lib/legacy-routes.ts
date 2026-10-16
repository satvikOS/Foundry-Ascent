/**
 * Bookmarks and links from before the conversation-first layout (`/<tenant>/app/ventures/<id>/<section>`)
 * keep working: each old section maps to its new home, keeping ids and the query that still means
 * something there.
 */
export type LegacyVentureTarget =
  | { page: 'chat' }
  | { page: 'conversation'; sessionId: string; search: { view?: 'recap' | 'transcript' } }
  | { page: 'knowledge'; search: Record<string, unknown> }
  | { page: 'documents' }
  | { page: 'help'; search: { id?: string } }
  | { page: 'team' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Old typed views became type filters on the Knowledge page. */
const TYPED_SECTIONS: Record<string, string> = {
  evidence: 'evidence',
  decisions: 'decision',
  experiments: 'experiment',
  milestones: 'milestone',
};

/** Where an old venture sub-path (the part after `/ventures/<id>/`) lives now. */
export function legacyVentureTarget(splat: string, search: Record<string, unknown>): LegacyVentureTarget {
  const parts = splat.split('/').filter(Boolean);
  const [section, child] = parts;
  switch (section) {
    case undefined:
    case 'overview':
      return { page: 'chat' };
    case 'coach': {
      if (child && UUID.test(child)) {
        const view = search.view === 'recap' || search.view === 'transcript' ? search.view : undefined;
        return { page: 'conversation', sessionId: child.toLowerCase(), search: view ? { view } : {} };
      }
      return { page: 'chat' };
    }
    case 'memory':
      return { page: 'knowledge', search };
    case 'documents':
      return { page: 'documents' };
    case 'team':
      return { page: 'team' };
    case 'escalations': {
      const id = typeof search.id === 'string' && UUID.test(search.id) ? search.id : undefined;
      return { page: 'help', search: id ? { id } : {} };
    }
    default: {
      const type = TYPED_SECTIONS[section];
      if (type) return { page: 'knowledge', search: { type } };
      return { page: 'chat' };
    }
  }
}

/** Old admin paths (`/admin/<section>`) under the tenant app. Unknown sections open the first one. */
export function legacyAdminSection(splat: string): 'principals' | 'settings' | 'usage' | 'audit' {
  const section = splat.split('/').find(Boolean);
  return section === 'settings' || section === 'usage' || section === 'audit' ? section : 'principals';
}
