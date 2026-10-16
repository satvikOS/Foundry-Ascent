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

function firstName(eirDisplayName: string): string {
  return eirDisplayName.trim().split(/\s+/)[0] ?? eirDisplayName;
}

/** "Corin Halvorsen" → "Corin's vEIR" (the naming every vEIR follows). */
export function defaultVeirName(eirDisplayName: string): string {
  return `${firstName(eirDisplayName)}'s vEIR`;
}

/**
 * Why a vEIR can't take this name (null = it can). Founders see it in chat and on calls, so it must say it
 * is a vEIR and never read as the EIR in person; the API applies the same rule.
 */
export function veirNameProblem(
  name: string,
  eirDisplayName: string,
  personas: readonly Pick<PersonaView, 'name'>[],
): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return 'Use 3 to 80 characters.';
  if (!/\bveir\b/i.test(trimmed)) {
    return `Include “vEIR” so founders never take it for ${firstName(eirDisplayName)}, e.g. ${defaultVeirName(eirDisplayName)}.`;
  }
  if (personas.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    return 'Another persona already uses this name.';
  }
  return null;
}

/**
 * The disclosure a new vEIR starts with: it is an AI built from the EIR's approved material, not the EIR,
 * and no human wrote or approved its answers.
 */
export function veirDisclosure(veirName: string, eirDisplayName: string): string {
  return (
    `You are talking with ${veirName}, an AI coach built from ${eirDisplayName}'s approved frameworks and ` +
    `coaching style. It is not a person, and no human EIR, including ${firstName(eirDisplayName)}, wrote or approved these responses.`
  );
}
