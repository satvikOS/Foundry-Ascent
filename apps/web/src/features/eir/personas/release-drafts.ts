import type { PersonaView } from '@foundry/contracts';

type ReleaseSummary = PersonaView['releases'][number];

/**
 * Whether the viewer can open `release`. Published releases (approved, superseded) open for every studio
 * role; drafts and withdrawn releases only for the persona's curators, because `GET /persona-releases/:id`
 * refuses them to anyone else (403).
 */
export function canOpenRelease(
  persona: Pick<PersonaView, 'canCurate'>,
  release: Pick<ReleaseSummary, 'status'>,
): boolean {
  const unpublished = release.status === 'draft' || release.status === 'withdrawn';
  return !unpublished || persona.canCurate === true;
}

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

/**
 * Drafts newer than the active release, newest first: the ones still waiting for approval. Empty for people
 * who can't open drafts, so nothing points them to a review they'd be refused.
 */
export function pendingDrafts(
  persona: Pick<PersonaView, 'activeRelease' | 'releases' | 'canCurate'>,
): ReleaseSummary[] {
  return persona.releases
    .filter((r) => r.status === 'draft' && !isOutdatedDraft(persona, r) && canOpenRelease(persona, r))
    .sort((a, b) => b.version - a.version);
}
