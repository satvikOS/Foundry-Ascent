import { CallConfigResponse, type EmbodimentProviderId, type VeirIdentity } from '@foundry/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { api, path } from '@/lib/api/client';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { queryKeys } from '@/lib/api/query-keys';
import { veirDisplay, veirFromIdentity, veirName, type VeirName } from '@/lib/veir';

/**
 * `GET /ventures/:id/call-config`: the vEIR, its embodiment and today's call minutes. Keyed under the
 * venture so anything that refreshes the venture (a finished call) refreshes it too.
 */
export const callConfigQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: [...queryKeys.venture.scope(ventureId), 'call-config'] as const,
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/call-config`, CallConfigResponse, { signal }),
    staleTime: 30_000,
  });

export function useCallConfig(ventureId: string | null, enabled: boolean) {
  return useQuery({ ...callConfigQueryOptions(ventureId ?? ''), enabled: enabled && ventureId !== null });
}

/** Who the founder is calling, as the call screen and mini bar show it: the mentor's name and face. */
export interface CallVeir extends VeirName {
  readonly disclosure: string;
  /** Only with likeness consent; otherwise the monogram is the face. */
  readonly portraitUrl: string | null;
  /** Who draws the call's face (the call settings' provider; `builtin` is the presence). */
  readonly provider: EmbodimentProviderId;
}

/**
 * The name a call shows for the persona: its display name ("Thomas"), the same as every other surface shows it
 * (`veirName`: a name stored with a "vEIR" label is shown without it). The call UI never composes "…’s vEIR" or
 * "… · vEIR" around it, and puts no badge beside it.
 */
export function personaDisplayName(personaName: string): string {
  return veirName(personaName);
}

/** The call UI's naming: the persona's own display name in text and on screen, with no badge beside it. */
function named<T extends VeirName>(veir: T, personaName: string): T {
  const display = veir.kind === 'eir_persona' ? personaDisplayName(personaName) : veir.name;
  return { ...veir, name: display, shortName: display };
}

/**
 * The vEIR of a venture for the call UI: from the call config when loaded, otherwise from the venture
 * (already cached by the sidebar), so the screen has a face and a name from its first frame. Named by the
 * persona's display name ("Thomas"); what it is (an AI mentor) is said in the call's disclosure and on its tile.
 */
export function useCallVeir(
  ventureId: string | null,
  config?: VeirIdentity | null,
  provider?: EmbodimentProviderId,
): CallVeir | null {
  const venture = useQuery({ ...ventureQueryOptions(ventureId ?? ''), enabled: ventureId !== null });
  if (config) {
    return {
      ...named(veirFromIdentity(config), config.name),
      provider: provider ?? config.embodiment.provider,
    };
  }
  const display = ventureId ? veirDisplay(venture.data) : null;
  const persona = venture.data?.persona;
  if (!display || !persona) return null;
  return { ...named(display, persona.name), provider: 'builtin' };
}
