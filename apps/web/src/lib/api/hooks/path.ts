import {
  PathStepView,
  SavePathIntake,
  UpdatePathStep,
  VenturePath,
  type PathIntake,
  type PathStepAction,
  type TurnGuidance,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { isApiError } from '../errors';
import { queryKeys } from '../query-keys';
import { VENTURE_DATA_STALE_MS } from '../venture-refresh';

/**
 * GET /ventures/:id/path: the founder path (stages and their evidence, the steps, the story, the intake). `null` while
 * the venture has none (404), so every screen treats it as optional: the conversation works without it.
 */
export const pathQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.path(ventureId),
    staleTime: VENTURE_DATA_STALE_MS,
    retry: false,
    queryFn: async ({ signal }): Promise<VenturePath | null> => {
      try {
        return await api.get(path`/ventures/${ventureId}/path`, VenturePath, { signal });
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
  });

export function useVenturePath(ventureId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...pathQueryOptions(ventureId), enabled });
}

/** A write answers with the whole path, or with the one step it changed: both are read. */
const PathWriteResponse = z.union([VenturePath, PathStepView]);
type PathWriteResponse = z.infer<typeof PathWriteResponse>;

function isWholePath(value: PathWriteResponse): value is VenturePath {
  return 'stages' in value;
}

/** Every step the path shows: now, next, then done. */
export function pathSteps(venturePath: VenturePath): PathStepView[] {
  return [...(venturePath.now ? [venturePath.now] : []), ...venturePath.next, ...venturePath.done];
}

/** `venturePath` with `step` in the place of its older self (in the list it is in; its lists are the server's to move). */
export function withStep(venturePath: VenturePath, step: PathStepView): VenturePath {
  const swap = (candidate: PathStepView) => (candidate.id === step.id ? step : candidate);
  return {
    ...venturePath,
    now: venturePath.now ? swap(venturePath.now) : null,
    next: venturePath.next.map(swap),
    done: venturePath.done.map(swap),
  };
}

/** The step with one sub-step ticked or unticked: shown at once, before the server's answer replaces it. */
export function withTick(step: PathStepView, item: number, done: boolean): PathStepView {
  return { ...step, items: step.items.map((each, index) => (index === item ? { ...each, done } : each)) };
}

/**
 * The step as it stands now: the path's own copy when it has one at least as new as the card's (the founder may have
 * ticked it elsewhere since the reply), else the reply's.
 */
export function currentStep(step: PathStepView, venturePath: VenturePath | null | undefined): PathStepView {
  const known = venturePath
    ? pathSteps(venturePath).find((candidate) => candidate.id === step.id)
    : undefined;
  return known && known.version >= step.version ? known : step;
}

function settlePath(client: QueryClient, ventureId: string, result: PathWriteResponse): void {
  const key = queryKeys.venture.path(ventureId);
  if (isWholePath(result)) {
    client.setQueryData<VenturePath | null>(key, result);
  } else {
    client.setQueryData<VenturePath | null>(key, (previous) =>
      previous ? withStep(previous, result) : previous,
    );
    // The other lists (what comes next, the criteria, the story) are the server's: read them again.
    void client.invalidateQueries({ queryKey: key });
  }
}

export interface StepChange {
  step: PathStepView;
  update: PathStepAction;
}

/**
 * PATCH /ventures/:id/path/steps/:stepId. A tick shows at once and is put back if the server refuses; a 409 (the step changed
 * meanwhile, in another tab or by the mentor) reads the path again, so the next try is made against what is there.
 */
export function useUpdatePathStep(ventureId: string) {
  const client = useQueryClient();
  const key = queryKeys.venture.path(ventureId);
  return useMutation({
    mutationFn: ({ step, update }: StepChange): Promise<PathWriteResponse> =>
      api.patch(
        path`/ventures/${ventureId}/path/steps/${step.id}`,
        PathWriteResponse,
        // Against the version now: a change made just before this one (a second tick) has moved it on.
        encodeBody(UpdatePathStep, {
          expectedVersion: currentStep(step, client.getQueryData<VenturePath | null>(key)).version,
          update,
        }),
        { idempotencyKey: createIdempotencyKey() },
      ),
    // One change at a time, in the order they were made.
    scope: { id: `path:${ventureId}` },
    onMutate: async ({ step, update }) => {
      // Ticks show at once. What moves a step (done, a new date, a change of plan) waits for the server, which moves
      // the others with it; the form stays until then.
      if (update.action !== 'tick') return { previous: undefined };
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<VenturePath | null>(key);
      if (previous) {
        const latest = currentStep(step, previous);
        client.setQueryData(key, withStep(previous, withTick(latest, update.item, update.done)));
      }
      return { previous };
    },
    onSuccess: (result) => {
      settlePath(client, ventureId, result);
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
    },
    onError: (_error, _change, context) => {
      if (context?.previous !== undefined) client.setQueryData(key, context.previous);
      void client.invalidateQueries({ queryKey: key });
    },
  });
}

/** PUT /ventures/:id/path/intake: what the founder says about themselves and the idea. */
export function useSavePathIntake(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (intake: PathIntake): Promise<VenturePath> => {
      const current = client.getQueryData<VenturePath | null>(queryKeys.venture.path(ventureId));
      return api.put(
        path`/ventures/${ventureId}/path/intake`,
        VenturePath,
        encodeBody(SavePathIntake, { expectedVersion: current?.version ?? 0, intake }),
        { idempotencyKey: createIdempotencyKey() },
      );
    },
    onSuccess: (saved) => {
      client.setQueryData<VenturePath | null>(queryKeys.venture.path(ventureId), saved);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: queryKeys.venture.path(ventureId) });
    },
  });
}

/** The guidance of a turn as it shows on screen: with its step as it stands now. */
export function currentGuidance(
  guidance: TurnGuidance,
  venturePath: VenturePath | null | undefined,
): TurnGuidance {
  if (!guidance.step) return guidance;
  return {
    ...guidance,
    step: currentStep(guidance.step, venturePath),
    ...(guidance.pathStep ? { pathStep: currentStep(guidance.pathStep, venturePath) } : {}),
  };
}
