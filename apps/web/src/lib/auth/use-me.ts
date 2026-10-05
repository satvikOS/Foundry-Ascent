import type { Me } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

import { meQueryOptions } from '@/lib/api/hooks/auth';

export { useMe } from '@/lib/api/hooks/auth';

/**
 * The signed-in principal inside authenticated routes (guarded by `requireMe` in beforeLoad).
 * Keeps returning the last known principal during sign-out so screens don't flash errors while the
 * router navigates away.
 */
export function useRequiredMe(): Me {
  const { data } = useQuery(meQueryOptions());
  const last = useRef<Me | null>(null);
  if (data) last.current = data;
  if (!last.current) throw new Error('useRequiredMe() must be used inside an authenticated route.');
  return last.current;
}
