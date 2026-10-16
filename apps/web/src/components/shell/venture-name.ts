import type { Me } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';

import { useTeam } from '@/lib/api/hooks/team';
import { ventureQueryOptions } from '@/lib/api/hooks/ventures';
import { canAccessVenture, canManageAnyTeam } from '@/lib/auth/roles';

/**
 * The name of the venture in view: from the venture for its members and assigned EIR, and from its team for
 * program leads and platform admins who are neither (they cannot read the venture, only its team). Null until
 * known. Nothing is requested that the person may not read.
 */
export function useVentureName(me: Me, ventureId: string | null): string | null {
  const readable = ventureId !== null && canAccessVenture(me, ventureId);
  const venture = useQuery({ ...ventureQueryOptions(ventureId ?? ''), enabled: readable });
  const team = useTeam(ventureId ?? '', {
    enabled: ventureId !== null && !readable && canManageAnyTeam(me),
  });
  if (ventureId === null) return null;
  return (
    venture.data?.name ??
    me.memberships.find((m) => m.ventureId === ventureId)?.ventureName ??
    team.data?.venture?.name ??
    null
  );
}
