import { useParams } from '@tanstack/react-router';

/** `{ tenant, ventureId }` for any component rendered inside the venture workspace layout. */
export function useVentureParams(): { tenant: string; ventureId: string } {
  return useParams({ from: '/$tenant/app/ventures/$ventureId' });
}
