import type { PersonaView } from '@foundry/contracts';

type ReleaseSummary = PersonaView['releases'][number];

/**
 * A draft at or below the active version. Approving it would roll every assigned venture back to older
 * doctrine (the API refuses it), so it is view only.
 */
export function isOutdatedDraft(
  persona: Pick<PersonaView, 'activeRelease'>,
  release: Pick<ReleaseSummary, 'status' | 'version'>,
): boolean {
  return release.status === 'draft' && release.version <= (persona.activeRelease?.version ?? 0);
}

/** Drafts newer than the active release, newest first: the ones still waiting for approval. */
export function pendingDrafts(persona: Pick<PersonaView, 'activeRelease' | 'releases'>): ReleaseSummary[] {
  return persona.releases
    .filter((r) => r.status === 'draft' && !isOutdatedDraft(persona, r))
    .sort((a, b) => b.version - a.version);
}
