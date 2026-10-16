import {
  CreateSessionRequest,
  CreateSessionResponse,
  EndSessionResponse,
  SessionDetailResponse,
  SessionPageResponse,
  TurnFeedbackRequest,
  UpdateSessionRequest,
  UpdateSessionResponse,
  type SessionView,
} from '@foundry/contracts';
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, apiSend, createIdempotencyKey, path } from '../client';
import { queryKeys, type ConversationFilters } from '../query-keys';

export type SessionDetail = z.infer<typeof SessionDetailResponse>;
export type EndSessionResult = z.infer<typeof EndSessionResponse>;
type SessionPage = z.infer<typeof SessionPageResponse>;

/** Conversations per page of `GET /sessions` (the API allows up to 100). */
const CONVERSATION_PAGE_SIZE = 50;

/**
 * `GET /sessions`: the signed-in person's conversations across every venture they work on, latest activity
 * first, one page at a time. `scope: 'mine'` lists the ones they started (the sidebar's recents); pass a
 * `ventureId` to keep one venture's. Links use each conversation's own `ventureId`.
 */
export const conversationsQueryOptions = (filters: ConversationFilters) =>
  infiniteQueryOptions({
    queryKey: queryKeys.conversations.list(filters),
    queryFn: ({ signal, pageParam }) =>
      api.get('/sessions', SessionPageResponse, {
        signal,
        query: {
          scope: filters.scope,
          ventureId: filters.ventureId,
          limit: CONVERSATION_PAGE_SIZE,
          cursor: pageParam ?? undefined,
        },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: SessionPage) => page.nextCursor,
  });

/**
 * The person's own conversations for the sidebar and ⌘K. Read-only roles (advisors, assigned EIRs) never
 * start conversations, so callers pass `enabled: false` for them and nothing is requested.
 */
export function useRecentConversations({ enabled }: { enabled: boolean }) {
  const query = useInfiniteQuery({ ...conversationsQueryOptions({ scope: 'mine' }), enabled });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}

/** GET /sessions/:id — a conversation with its turns (founders and team only). */
export const sessionQueryOptions = (sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.session.detail(sessionId),
    queryFn: ({ signal }) => api.get(path`/sessions/${sessionId}`, SessionDetailResponse, { signal }),
  });

/**
 * A conversation. While an ended conversation's digest is being written (distillation runs after the end),
 * the detail is re-read every few seconds for up to two minutes.
 */
export function useSession(sessionId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    ...sessionQueryOptions(sessionId),
    enabled,
    refetchInterval: (query) => (awaitingDigest(query.state.data?.session) ? DIGEST_POLL_MS : false),
  });
}

const DIGEST_POLL_MS = 4_000;
const DIGEST_WAIT_MS = 120_000;

/** Whether a digest for this conversation may still arrive (standard, ended within the last two minutes). */
export function awaitingDigest(
  session: Pick<SessionView, 'status' | 'privacy' | 'digest' | 'endedAt'> | undefined,
  now: number = Date.now(),
): boolean {
  if (session?.status !== 'ended' || session.privacy !== 'standard' || session.digest) return false;
  return session.endedAt !== null && now - Date.parse(session.endedAt) < DIGEST_WAIT_MS;
}

/** Refresh every list a conversation appears in, plus the venture data a conversation changes. */
function invalidateConversation(client: QueryClient, session: Pick<SessionView, 'id' | 'ventureId'>) {
  void client.invalidateQueries({ queryKey: queryKeys.conversations.all() });
  void client.invalidateQueries({ queryKey: queryKeys.venture.overview(session.ventureId) });
  void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
}

export type CreateSessionInput = z.input<typeof CreateSessionRequest>;

/** POST /ventures/:id/sessions → 201 `SessionView` (the only way a conversation starts). */
export function useCreateSession(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionInput) =>
      api.post(
        path`/ventures/${ventureId}/sessions`,
        CreateSessionResponse,
        encodeBody(CreateSessionRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (session) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(session.id), { session, turns: [] });
      invalidateConversation(client, session);
    },
  });
}

/** PATCH /sessions/:id `{ title }` → the renamed conversation. */
export function useRenameSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api.patch(
        path`/sessions/${sessionId}`,
        UpdateSessionResponse,
        encodeBody(UpdateSessionRequest, { title }),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (session) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(session.id), (previous) =>
        previous ? { ...previous, session } : previous,
      );
      void client.invalidateQueries({ queryKey: queryKeys.conversations.all() });
    },
  });
}

/** DELETE /sessions/:id → 204. The conversation's content is erased and it leaves every list. */
export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (session: Pick<SessionView, 'id' | 'ventureId'>) =>
      api.delete(path`/sessions/${session.id}`, { idempotencyKey: createIdempotencyKey() }),
    onSuccess: (_result, session) => {
      client.removeQueries({ queryKey: queryKeys.session.detail(session.id) });
      invalidateConversation(client, session);
      // Proposals and notebook lines drawn from the conversation are removed with it.
      void client.invalidateQueries({ queryKey: queryKeys.venture.scope(session.ventureId) });
    },
  });
}

/**
 * POST /sessions/:id/end → `{ session, recap }`. `recap` is null for temporary chats; its
 * `memory_candidate_ids` are proposals waiting for a person's approval. The digest follows asynchronously.
 */
export function useEndSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post(path`/sessions/${sessionId}/end`, EndSessionResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: (result) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(result.session.id), (previous) =>
        previous ? { ...previous, session: result.session } : previous,
      );
      void client.invalidateQueries({ queryKey: queryKeys.session.detail(result.session.id) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.scope(result.session.ventureId) });
      invalidateConversation(client, result.session);
    },
  });
}

/** DELETE /sessions/:id/digest → the conversation without its digest (never written again). */
export function useDeleteDigest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiSend(path`/sessions/${sessionId}/digest`, {
        method: 'DELETE',
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: (_result, sessionId) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(sessionId), (previous) =>
        previous ? { ...previous, session: { ...previous.session, digest: null } } : previous,
      );
      void client.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) });
    },
  });
}

export type TurnFeedbackInput = z.input<typeof TurnFeedbackRequest>;

/** POST /turns/:id/feedback → 201 `{ feedbackId }` (body not needed). */
export function useTurnFeedback() {
  return useMutation({
    mutationFn: ({ turnId, feedback }: { turnId: string; feedback: TurnFeedbackInput }) =>
      apiSend(path`/turns/${turnId}/feedback`, {
        method: 'POST',
        body: encodeBody(TurnFeedbackRequest, feedback),
        idempotencyKey: createIdempotencyKey(),
      }),
  });
}
