import type { PersonaView } from '@foundry/contracts';

import type { EirProfile } from '@/lib/api/hooks/veir-pools';

/** EIRs who can get a vEIR: active, and not already the source of a live one (one per EIR). */
export function eirsWithoutVeir(
  profiles: readonly EirProfile[],
  personas: readonly Pick<PersonaView, 'kind' | 'status' | 'eirProfile'>[],
): EirProfile[] {
  const taken = new Set(
    personas
      .filter((p) => p.kind === 'eir_persona' && p.status !== 'retired')
      .map((p) => p.eirProfile?.id)
      .filter((id): id is string => id !== undefined),
  );
  return profiles.filter((profile) => profile.status === 'active' && !taken.has(profile.id));
}

/** "Corin Halvorsen" → "Corin's vEIR" (the naming every vEIR follows). */
export function defaultVeirName(eirDisplayName: string): string {
  const first = eirDisplayName.trim().split(/\s+/)[0] ?? eirDisplayName;
  return `${first}'s vEIR`;
}

/**
 * The disclosure a new vEIR starts with: it is an AI built from the EIR's approved material, not the EIR,
 * and no human wrote or approved its answers.
 */
export function veirDisclosure(veirName: string, eirDisplayName: string): string {
  const first = eirDisplayName.trim().split(/\s+/)[0] ?? eirDisplayName;
  return (
    `You are talking with ${veirName}, an AI coach built from ${eirDisplayName}'s approved frameworks and ` +
    `coaching style. It is not a person, and no human EIR, including ${first}, wrote or approved these responses.`
  );
}
