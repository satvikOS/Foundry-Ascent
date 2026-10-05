import type { TurnStatusPhase, TurnView } from '@foundry/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { z } from 'zod';

import { createIdempotencyKey } from '../client';
import { errorMessage, isAbortError, isApiError } from '../errors';
import { queryKeys } from '../query-keys';
import { streamTurn, type CreateTurnBody, type TurnStreamEventT } from '../sse';
import type { SessionDetail } from './sessions';

export type TurnPhase = z.infer<typeof TurnStatusPhase>;

export interface TurnProgressStep {
  phase: TurnPhase;
  detail: string | null;
  evidenceCount: number | null;
  at: number;
}

export type TurnBlocked = Extract<TurnStreamEventT, { event: 'turn.blocked' }>;

export interface TurnStreamError {
  code: string;
  message: string;
  retryable: boolean;
  /** The request that failed (`turn.error` `requestId`, or the response's x-request-id), for support. */
  requestId: string | undefined;
  /**
   * Earliest time (epoch ms) a retry can succeed, from the server's `retryAfterSeconds` / Retry-After;
   * undefined when the server gave no hint. The UI holds "Try again" until then.
   */
  retryAt: number | undefined;
}

export interface TurnStreamState {
  status: 'idle' | 'streaming' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  /** The founder text being answered (kept so the UI can show it optimistically). */
  pendingText: string | null;
  turnId: string | null;
  ordinal: number | null;
  phase: TurnPhase | null;
  steps: TurnProgressStep[];
  turn: TurnView | null;
  blocked: TurnBlocked | null;
  error: TurnStreamError | null;
  /**
   * When the hook will replay a message whose turn the server is still answering (epoch ms), else null.
   * Set after a `turn.error` `conflict` with `retryAfterSeconds`; the replay reuses the Idempotency-Key.
   */
  autoRetryAt: number | null;
}

const INITIAL: TurnStreamState = {
  status: 'idle',
  pendingText: null,
  turnId: null,
  ordinal: null,
  phase: null,
  steps: [],
  turn: null,
  blocked: null,
  error: null,
  autoRetryAt: null,
};

type Action =
  | { type: 'start'; text: string }
  | { type: 'event'; event: TurnStreamEventT }
  | { type: 'failed'; error: TurnStreamError }
  | { type: 'cancelled' }
  | { type: 'autoRetry'; at: number | null }
  | { type: 'reset' };

/** Converts a server wait hint (seconds) into an absolute time, or undefined without one. */
export function retryAtFrom(retryAfterSeconds: number | undefined, now = Date.now()): number | undefined {
  return retryAfterSeconds === undefined || retryAfterSeconds <= 0
    ? undefined
    : now + retryAfterSeconds * 1000;
}

export function turnStreamReducer(state: TurnStreamState, action: Action): TurnStreamState {
  switch (action.type) {
    case 'start':
      return { ...INITIAL, status: 'streaming', pendingText: action.text };
    case 'reset':
      return INITIAL;
    case 'cancelled':
      if (state.status === 'streaming') return { ...state, status: 'cancelled', phase: null };
      return state.autoRetryAt === null ? state : { ...state, autoRetryAt: null };
    case 'autoRetry':
      return { ...state, autoRetryAt: action.at };
    case 'failed':
      return { ...state, status: 'failed', phase: null, error: action.error };
    case 'event': {
      const event = action.event;
      switch (event.event) {
        case 'turn.accepted':
          return { ...state, turnId: event.turnId, ordinal: event.ordinal };
        case 'turn.status':
          return {
            ...state,
            phase: event.phase,
            steps: [
              ...state.steps,
              {
                phase: event.phase,
                detail: event.detail,
                evidenceCount: event.evidenceCount,
                at: Date.now(),
              },
            ],
          };
        case 'turn.completed':
          return {
            ...state,
            status: 'completed',
            phase: null,
            turn: event.turn,
            turnId: event.turn.id,
            ordinal: event.turn.ordinal,
          };
        case 'turn.blocked':
          return { ...state, status: 'blocked', phase: null, blocked: event, turnId: event.turnId };
        case 'turn.error':
          return {
            ...state,
            status: 'failed',
            phase: null,
            turnId: event.turnId ?? state.turnId,
            error: {
              code: event.code,
              message: event.message,
              retryable: event.retryable,
              requestId: event.requestId,
              retryAt: retryAtFrom(event.retryAfterSeconds),
            },
          };
      }
    }
  }
}

/** Human labels for progress steps (use with an aria-live="polite" region). */
export function turnPhaseLabel(step: Pick<TurnProgressStep, 'phase' | 'evidenceCount'>): string {
  switch (step.phase) {
    case 'classifying':
      return 'Checking your question';
    case 'retrieving':
      return step.evidenceCount === null
        ? 'Gathering evidence'
        : `Gathering evidence · ${step.evidenceCount} source${step.evidenceCount === 1 ? '' : 's'}`;
    case 'reasoning':
      return 'Thinking it through';
    case 'validating':
      return 'Checking claims against evidence';
  }
}

interface UseTurnStreamOptions {
  /** Used to refresh venture-level data (memory candidates, escalations) when a turn finishes. */
  ventureId: string;
  /** Observe every validated event (e.g. for analytics-free UI effects). */
  onEvent?: (event: TurnStreamEventT) => void;
}

/**
 * An attempt whose server-side outcome is unknown (network drop, interrupted stream, waking database,
 * "still answering" conflict). Sending the same body again must reuse its Idempotency-Key so the API
 * replays the accepted turn instead of running (and charging for) it twice. The API hashes the exact
 * body bytes with the key, so the signature is the exact JSON that is sent.
 */
interface UnsettledAttempt {
  key: string;
  signature: string;
}

/**
 * How often a message whose turn the server is still answering is replayed automatically (each after the
 * server's `retryAfterSeconds`, capped at {@link MAX_PENDING_REPLAY_DELAY_S}); about half a minute in
 * total with the API's 5 s hint. After that the founder decides with "Try again".
 */
export const MAX_PENDING_REPLAYS = 6;
const MAX_PENDING_REPLAY_DELAY_S = 30;

/**
 * Whether a failed attempt may still have produced (or be producing) a turn on the server, so a retry
 * with the same body has to reuse the key. A `turn.error` event, a cancel, or a refusal (4xx/5xx
 * problem) means the outcome is recorded or nothing was accepted: the next send starts a new turn.
 */
function outcomeUnknown(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return (
    error.code === 'network_error' ||
    error.code === 'stream_interrupted' ||
    error.code === 'invalid_response' ||
    error.code === 'database_resuming' ||
    // 409 with Retry-After: the same key is still in flight on the server.
    (error.code === 'conflict' && error.retryAfter !== undefined) ||
    error.status === 502 ||
    error.status === 504
  );
}

/**
 * Send a founder message and follow the SSE turn stream:
 *   const { state, send, retry, cancel, reset } = useTurnStream(sessionId, { ventureId });
 *   await send({ text, mode });
 * Only one turn streams at a time; `send` cancels a previous in-flight turn. The stream is aborted on
 * unmount. On completion the session cache gets the new turn and venture data is invalidated.
 *
 * Idempotency: each new message gets a fresh Idempotency-Key. When an attempt fails with an unknown
 * outcome (see `outcomeUnknown`), sending the identical body again — `retry()` or `send()` with the same
 * text, mode and counterpart — reuses that key, so a turn the server already accepted is replayed from
 * storage (no second model call) rather than duplicated.
 */
export function useTurnStream(sessionId: string, { ventureId, onEvent }: UseTurnStreamOptions) {
  const client = useQueryClient();
  const [state, dispatch] = useReducer(turnStreamReducer, INITIAL);
  const controllerRef = useRef<AbortController | null>(null);
  const attemptRef = useRef<UnsettledAttempt | null>(null);
  const lastBodyRef = useRef<CreateTurnBody | null>(null);
  /** Scheduled automatic replay of a still-pending turn, and how many replays its key has had. */
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replaysRef = useRef<{ key: string; count: number } | null>(null);
  const sendRef = useRef<((body: CreateTurnBody) => Promise<TurnStreamState['status']>) | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const clearReplayTimer = useCallback(() => {
    if (replayTimerRef.current !== null) clearTimeout(replayTimerRef.current);
    replayTimerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      clearReplayTimer();
    },
    [clearReplayTimer],
  );

  /** Forget an attempt's key once its outcome is known (unless a newer send already replaced it). */
  const settleAttempt = useCallback((key: string) => {
    if (attemptRef.current?.key === key) attemptRef.current = null;
  }, []);

  const applyCompletedTurn = useCallback(
    (turn: TurnView) => {
      client.setQueryData<SessionDetail>(queryKeys.session.detail(sessionId), (previous) => {
        if (!previous) return previous;
        const turns = previous.turns.filter((t) => t.id !== turn.id);
        return {
          session: { ...previous.session, turnCount: Math.max(previous.session.turnCount, turn.ordinal) },
          turns: [...turns, turn].sort((a, b) => a.ordinal - b.ordinal),
        };
      });
    },
    [client, sessionId],
  );

  const send = useCallback(
    async (body: CreateTurnBody): Promise<TurnStreamState['status']> => {
      controllerRef.current?.abort();
      clearReplayTimer();
      const controller = new AbortController();
      controllerRef.current = controller;
      lastBodyRef.current = body;
      const signature = JSON.stringify(body);
      const previous = attemptRef.current;
      const idempotencyKey = previous?.signature === signature ? previous.key : createIdempotencyKey();
      attemptRef.current = { key: idempotencyKey, signature };
      dispatch({ type: 'start', text: body.text });
      let final: TurnStreamState['status'] = 'failed';
      // Cleared once the server has a definite record (or definitely accepted nothing).
      let keepKey = false;
      // Seconds the server asked us to wait before replaying a turn it is still answering.
      let pendingRetryAfter: number | null = null;
      try {
        for await (const event of streamTurn(sessionId, body, {
          signal: controller.signal,
          idempotencyKey,
        })) {
          if (controller.signal.aborted) break;
          dispatch({ type: 'event', event });
          onEventRef.current?.(event);
          if (event.event === 'turn.completed') {
            applyCompletedTurn(event.turn);
            final = 'completed';
          } else if (event.event === 'turn.blocked') {
            final = 'blocked';
          } else if (event.event === 'turn.error' && event.code === 'conflict') {
            // A replay found the original turn still being answered: keep the key so the next try
            // replays it once it finishes instead of starting (and paying for) a second turn.
            keepKey = true;
            pendingRetryAfter = event.retryAfterSeconds ?? null;
          }
        }
        if (controller.signal.aborted) {
          dispatch({ type: 'cancelled' });
          final = 'cancelled';
        }
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          dispatch({ type: 'cancelled' });
          final = 'cancelled';
        } else {
          keepKey = outcomeUnknown(error);
          dispatch({
            type: 'failed',
            error: {
              code: isApiError(error) ? error.code : 'internal',
              message: errorMessage(error),
              retryable: isApiError(error) ? keepKey || error.isTransient : true,
              requestId: isApiError(error) ? error.requestId : undefined,
              retryAt: isApiError(error) ? retryAtFrom(error.retryAfter) : undefined,
            },
          });
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (!keepKey) settleAttempt(idempotencyKey);
        const replays = replaysRef.current?.key === idempotencyKey ? replaysRef.current.count : 0;
        if (pendingRetryAfter !== null && !controller.signal.aborted && replays < MAX_PENDING_REPLAYS) {
          // Honour the server's wait, then replay with the same key (no second model call).
          replaysRef.current = { key: idempotencyKey, count: replays + 1 };
          const delayMs = Math.min(pendingRetryAfter, MAX_PENDING_REPLAY_DELAY_S) * 1000;
          dispatch({ type: 'autoRetry', at: Date.now() + delayMs });
          replayTimerRef.current = setTimeout(() => {
            replayTimerRef.current = null;
            void sendRef.current?.(body);
          }, delayMs);
        }
        void client.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) });
        if (final === 'completed' || final === 'blocked') {
          void client.invalidateQueries({ queryKey: queryKeys.venture.scope(ventureId) });
          void client.invalidateQueries({ queryKey: queryKeys.ventures.list() });
        }
      }
      return final;
    },
    [applyCompletedTurn, clearReplayTimer, client, sessionId, settleAttempt, ventureId],
  );
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  /** Send the last message again with the same mode and counterpart (and key, when its outcome is unknown). */
  const retry = useCallback(async (): Promise<TurnStreamState['status'] | null> => {
    const body = lastBodyRef.current;
    return body ? send(body) : null;
  }, [send]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    clearReplayTimer();
    dispatch({ type: 'cancelled' });
  }, [clearReplayTimer]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    clearReplayTimer();
    attemptRef.current = null;
    lastBodyRef.current = null;
    replaysRef.current = null;
    dispatch({ type: 'reset' });
  }, [clearReplayTimer]);

  return { state, send, retry, cancel, reset, isStreaming: state.status === 'streaming' };
}
