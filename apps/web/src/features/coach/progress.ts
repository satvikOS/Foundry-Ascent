import type { TurnPhase, TurnStreamState } from '@/lib/api/hooks/turn-stream';
import type { TurnStreamEventT } from '@/lib/api/sse';

/*
 * Founder-facing progress model for a streaming turn. The API emits `turn.status` phases
 * (classifying → retrieving → reasoning → validating); the UI always shows the same four steps so
 * people (and screen readers) can follow along:
 *
 *   Understanding → Retrieving evidence (n) → Reasoning → Checking grounding & policy
 *
 * The reducer is pure and tolerant: phases may be skipped (the crisis path stops after classifying),
 * repeated (retrieving updates its count) or arrive out of order (a late, earlier phase never moves
 * progress backwards).
 */

export type ProgressStepId = 'understanding' | 'retrieving' | 'reasoning' | 'checking';
export type ProgressStepStatus = 'pending' | 'active' | 'done' | 'stopped' | 'skipped';
export type TurnOutcome = 'idle' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';

export interface ProgressStep {
  id: ProgressStepId;
  status: ProgressStepStatus;
  /** Evidence items found (retrieving step only). */
  evidenceCount: number | null;
}

export interface TurnProgress {
  steps: ProgressStep[];
  outcome: TurnOutcome;
}

export const PROGRESS_STEP_ORDER: readonly ProgressStepId[] = [
  'understanding',
  'retrieving',
  'reasoning',
  'checking',
];

const PHASE_TO_STEP: Record<TurnPhase, ProgressStepId> = {
  classifying: 'understanding',
  retrieving: 'retrieving',
  reasoning: 'reasoning',
  validating: 'checking',
};

/** Local actions alongside the server events. */
export type ProgressAction =
  TurnStreamEventT | { event: 'local.start' } | { event: 'local.cancelled' } | { event: 'local.failed' };

export function initialTurnProgress(): TurnProgress {
  return {
    outcome: 'idle',
    steps: PROGRESS_STEP_ORDER.map((id) => ({ id, status: 'pending', evidenceCount: null })),
  };
}

function activeIndex(steps: readonly ProgressStep[]): number {
  return steps.findIndex((step) => step.status === 'active');
}

/** Furthest step that has started (active or done); -1 when nothing has started. */
function furthestStarted(steps: readonly ProgressStep[]): number {
  let index = -1;
  steps.forEach((step, i) => {
    if (step.status === 'active' || step.status === 'done') index = i;
  });
  return index;
}

function stopAt(state: TurnProgress, outcome: TurnOutcome): TurnProgress {
  const active = activeIndex(state.steps);
  return {
    outcome,
    steps: state.steps.map((step, i) => {
      if (i === active) return { ...step, status: 'stopped' };
      if (step.status === 'pending') return { ...step, status: 'skipped' };
      return step;
    }),
  };
}

export function turnProgressReducer(state: TurnProgress, action: ProgressAction): TurnProgress {
  switch (action.event) {
    case 'local.start': {
      const fresh = initialTurnProgress();
      return {
        outcome: 'running',
        steps: fresh.steps.map((step, i) => (i === 0 ? { ...step, status: 'active' } : step)),
      };
    }
    case 'turn.accepted':
      if (state.outcome !== 'idle') return state;
      return turnProgressReducer(state, { event: 'local.start' });
    case 'turn.status': {
      if (state.outcome !== 'running' && state.outcome !== 'idle') return state;
      const base = state.outcome === 'idle' ? turnProgressReducer(state, { event: 'local.start' }) : state;
      const target = PROGRESS_STEP_ORDER.indexOf(PHASE_TO_STEP[action.phase]);
      const furthest = furthestStarted(base.steps);
      if (target < furthest) {
        // Late event for an earlier phase: keep progress, but still record a retrieval count.
        if (action.phase !== 'retrieving' || action.evidenceCount === null) return base;
        return {
          ...base,
          steps: base.steps.map((step, i) =>
            i === target ? { ...step, evidenceCount: action.evidenceCount } : step,
          ),
        };
      }
      return {
        outcome: 'running',
        steps: base.steps.map((step, i) => {
          if (i < target) return { ...step, status: 'done' };
          if (i === target) {
            return {
              ...step,
              status: 'active',
              evidenceCount:
                action.phase === 'retrieving' && action.evidenceCount !== null
                  ? action.evidenceCount
                  : step.evidenceCount,
            };
          }
          return { ...step, status: 'pending' };
        }),
      };
    }
    case 'turn.completed':
      return {
        outcome: 'completed',
        steps: state.steps.map((step) => ({
          ...step,
          status: 'done',
          evidenceCount:
            step.id === 'retrieving' && step.evidenceCount === null
              ? action.turn.evidence.length
              : step.evidenceCount,
        })),
      };
    case 'turn.blocked':
      return stopAt(
        state.outcome === 'idle' ? turnProgressReducer(state, { event: 'local.start' }) : state,
        'blocked',
      );
    case 'turn.error':
    case 'local.failed':
      if (state.outcome === 'completed' || state.outcome === 'blocked') return state;
      return stopAt(state, 'failed');
    case 'local.cancelled':
      if (state.outcome !== 'running') return state;
      return stopAt(state, 'cancelled');
  }
}

/**
 * Progress for the current `useTurnStream` state: replays the recorded phases through the reducer
 * and applies the terminal outcome. Pure, so it is safe to call on every render.
 */
export function deriveTurnProgress(stream: Pick<TurnStreamState, 'status' | 'steps' | 'turn'>): TurnProgress {
  if (stream.status === 'idle') return initialTurnProgress();
  let progress = turnProgressReducer(initialTurnProgress(), { event: 'local.start' });
  for (const step of stream.steps) {
    progress = turnProgressReducer(progress, {
      event: 'turn.status',
      phase: step.phase,
      detail: step.detail,
      evidenceCount: step.evidenceCount,
    });
  }
  switch (stream.status) {
    case 'streaming':
      return progress;
    case 'completed':
      return stream.turn
        ? turnProgressReducer(progress, { event: 'turn.completed', turn: stream.turn })
        : { outcome: 'completed', steps: progress.steps.map((s) => ({ ...s, status: 'done' })) };
    case 'blocked':
      return stopAt(progress, 'blocked');
    case 'failed':
      return turnProgressReducer(progress, { event: 'local.failed' });
    case 'cancelled':
      return turnProgressReducer(progress, { event: 'local.cancelled' });
  }
}

/** Visible label for a step. */
export function progressStepLabel(step: Pick<ProgressStep, 'id' | 'evidenceCount'>): string {
  switch (step.id) {
    case 'understanding':
      return 'Understanding';
    case 'retrieving':
      return step.evidenceCount === null
        ? 'Retrieving evidence'
        : `Retrieving evidence (${step.evidenceCount})`;
    case 'reasoning':
      return 'Reasoning';
    case 'checking':
      return 'Checking grounding & policy';
  }
}

export const PROGRESS_STATUS_TEXT: Record<ProgressStepStatus, string> = {
  pending: 'not started',
  active: 'in progress',
  done: 'done',
  stopped: 'stopped',
  skipped: 'skipped',
};

/**
 * Short screen-reader announcement for the step that just became active (never includes content).
 * Returns null when nothing new should be announced.
 */
export function progressAnnouncement(progress: TurnProgress): string | null {
  switch (progress.outcome) {
    case 'completed':
      return 'Response ready.';
    case 'blocked':
      return 'This needs a person. Support options are shown.';
    case 'failed':
      return 'The response could not be completed.';
    case 'cancelled':
      return 'Stopped.';
    case 'idle':
      return null;
    case 'running': {
      const active = progress.steps.find((step) => step.status === 'active');
      if (!active) return null;
      if (active.id === 'retrieving' && active.evidenceCount !== null) {
        return `Retrieving evidence: ${active.evidenceCount} source${active.evidenceCount === 1 ? '' : 's'} found.`;
      }
      return `${progressStepLabel(active)}…`;
    }
  }
}
