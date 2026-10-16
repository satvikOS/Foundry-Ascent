import { CallConfigResponse, type AvatarProviderId, type VeirIdentity } from '@foundry/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { api, path } from '@/lib/api/client';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { queryKeys } from '@/lib/api/query-keys';
import { veirDisplay } from '@/lib/veir';

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

/** Who the founder is calling, as the call screen and mini bar show it. */
export interface CallVeir {
  readonly name: string;
  readonly shortName: string;
  readonly kind: VeirIdentity['kind'];
  readonly disclosure: string;
  /** Only with likeness consent; otherwise the monogram is the face. */
  readonly portraitUrl: string | null;
  readonly provider: AvatarProviderId;
}

/**
 * The vEIR of a venture for the call UI: from the call config when loaded, otherwise from the venture
 * (already cached by the sidebar), so the screen has a face and a name from its first frame.
 */
export function useCallVeir(ventureId: string | null, config?: VeirIdentity | null): CallVeir | null {
  const venture = useQuery({ ...ventureQueryOptions(ventureId ?? ''), enabled: ventureId !== null });
  if (config) {
    return {
      name: config.name,
      shortName: config.shortName,
      kind: config.kind,
      disclosure: config.disclosure,
      portraitUrl: config.embodiment.likenessConsented ? config.embodiment.portraitUrl : null,
      provider: config.embodiment.provider,
    };
  }
  const display = ventureId ? veirDisplay(venture.data) : null;
  if (!display) return null;
  return {
    name: display.name,
    shortName: display.shortName,
    kind: display.kind,
    disclosure: display.disclosure,
    portraitUrl: display.portraitUrl,
    provider: 'builtin',
  };
}
