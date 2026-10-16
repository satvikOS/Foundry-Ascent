import { eirRepo, type personasRepo } from '@foundry/db';

import { fail } from '../errors.js';
import { type RequestScope } from '../internal/kit.js';
import { hasAnyRole, loadPrincipalRoles } from './roles.js';

/** How the caller curates a persona: as a program lead of its tenant, or as the EIR it is built from. */
export type CuratorVia = 'program_lead' | 'linked_eir';

/**
 * Requires the caller to curate `persona` (the rule RLS applies to its common pool, `app.can_curate_persona`):
 * a program lead of the tenant, or an EIR whose own profile the persona is built from. A platform admin is a
 * curator only through one of those. Denials are audited (`authz.denied`) and reported as `forbidden`.
 */
export async function requirePersonaCurator(
  scope: RequestScope,
  persona: Pick<personasRepo.PersonaRecord, 'id' | 'eirProfileId'>,
  options: { readonly message?: string } = {},
): Promise<CuratorVia> {
  const roles = await loadPrincipalRoles(scope.tx, scope.ctx);
  if (hasAnyRole(roles, ['program_lead'])) return 'program_lead';
  if (persona.eirProfileId !== null && hasAnyRole(roles, ['eir'])) {
    const profile = await eirRepo.getEirProfile(scope.tx, persona.eirProfileId);
    if (profile?.principalId === scope.ctx.principalId) return 'linked_eir';
  }
  scope.deferAudit({
    action: 'authz.denied',
    outcome: 'denied',
    objectType: 'persona',
    objectId: persona.id,
    policyReason: 'requires_persona_curator',
  });
  throw fail.forbidden('requires_persona_curator', options.message);
}
