import { SessionView, type SessionDetailResponse, type SessionListResponse } from '@foundry/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { apiRequest, path } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/query-keys';

type SessionList = z.infer<typeof SessionListResponse>;
type SessionDetail = z.infer<typeof SessionDetailResponse>;

/**
 * `DELETE /sessions/:id/digest`: removes a conversation's digest. The vEIR stops drawing on it and
 * distillation never writes it again; the conversation itself stays. The cached list and conversation
 * take the returned session at once.
 */
export function useDeleteDigest(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiRequest(path`/sessions/${sessionId}/digest`, { method: 'DELETE', schema: SessionView }),
    onSuccess: (session) => {
      client.setQueryData<SessionList>(queryKeys.venture.sessions(ventureId), (list) =>
        list ? { items: list.items.map((item) => (item.id === session.id ? session : item)) } : list,
      );
      client.setQueryData<SessionDetail>(queryKeys.session.detail(session.id), (detail) =>
        detail ? { ...detail, session } : detail,
      );
      void client.invalidateQueries({ queryKey: queryKeys.venture.sessions(ventureId) });
    },
  });
}
