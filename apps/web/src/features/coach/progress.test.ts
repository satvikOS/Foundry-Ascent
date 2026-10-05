import { describe, expect, it } from 'vitest';

import type { TurnStreamState } from '@/lib/api/hooks/turn-stream';

import {
  deriveTurnProgress,
  initialTurnProgress,
  progressAnnouncement,
  progressStepLabel,
  turnProgressReducer,
  type ProgressAction,
  type TurnProgress,
} from './progress';
import { IDS, makeTurn } from './testing';

function statuses(progress: TurnProgress) {
  return progress.steps.map((step) => step.status);
}

function run(actions: ProgressAction[]): TurnProgress {
  return actions.reduce(turnProgressReducer, initialTurnProgress());
}

const status = (
  phase: 'classifying' | 'retrieving' | 'reasoning' | 'validating',
  evidenceCount: number | null = null,
): ProgressAction => ({ event: 'turn.status', phase, detail: null, evidenceCount });

describe('turnProgressReducer', () => {
  it('starts with every step pending and idle', () => {
    const progress = initialTurnProgress();
    expect(progress.outcome).toBe('idle');
    expect(statuses(progress)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('marks Understanding active as soon as the founder sends', () => {
    const progress = run([{ event: 'local.start' }]);
    expect(progress.outcome).toBe('running');
    expect(statuses(progress)).toEqual(['active', 'pending', 'pending', 'pending']);
  });

  it('advances through the phases and records the evidence count', () => {
    const progress = run([
      { event: 'local.start' },
      { event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 },
      status('classifying'),
      status('retrieving', 5),
    ]);
    expect(statuses(progress)).toEqual(['done', 'active', 'pending', 'pending']);
    expect(progressStepLabel(progress.steps[1] ?? { id: 'retrieving', evidenceCount: null })).toBe(
      'Retrieving evidence (5)',
    );
    expect(progressAnnouncement(progress)).toBe('Retrieving evidence: 5 sources found.');
  });

  it('treats skipped phases as passed when a later phase arrives', () => {
    const progress = run([{ event: 'local.start' }, status('validating')]);
    expect(statuses(progress)).toEqual(['done', 'done', 'done', 'active']);
    expect(progressAnnouncement(progress)).toBe('Checking grounding & policy…');
  });

  it('never moves backwards on a late, earlier phase but keeps a late retrieval count', () => {
    const progress = run([
      { event: 'local.start' },
      status('reasoning'),
      status('classifying'),
      status('retrieving', 3),
    ]);
    expect(statuses(progress)).toEqual(['done', 'done', 'active', 'pending']);
    expect(progress.steps[1]?.evidenceCount).toBe(3);
  });

  it('completes every step and falls back to the evidence returned with the turn', () => {
    const progress = run([
      { event: 'local.start' },
      status('reasoning'),
      { event: 'turn.completed', turn: makeTurn() },
    ]);
    expect(progress.outcome).toBe('completed');
    expect(statuses(progress)).toEqual(['done', 'done', 'done', 'done']);
    expect(progress.steps[1]?.evidenceCount).toBe(2);
    expect(progressAnnouncement(progress)).toBe('Response ready.');
  });

  it('stops at the active step when a turn is blocked (crisis path stops after Understanding)', () => {
    const progress = run([
      { event: 'local.start' },
      status('classifying'),
      { event: 'turn.blocked', turnId: IDS.turn, reason: 'safety', escalationId: null, supportMessage: null },
    ]);
    expect(progress.outcome).toBe('blocked');
    expect(statuses(progress)).toEqual(['stopped', 'skipped', 'skipped', 'skipped']);
  });

  it('marks a failure and ignores events after a terminal outcome', () => {
    const failed = run([
      { event: 'local.start' },
      status('retrieving', 2),
      { event: 'turn.error', turnId: null, code: 'model_unavailable', message: 'x', retryable: true },
    ]);
    expect(failed.outcome).toBe('failed');
    expect(statuses(failed)).toEqual(['done', 'stopped', 'skipped', 'skipped']);
    expect(turnProgressReducer(failed, status('reasoning'))).toBe(failed);

    const done = run([{ event: 'local.start' }, { event: 'turn.completed', turn: makeTurn() }]);
    expect(turnProgressReducer(done, { event: 'local.failed' })).toBe(done);
  });

  it('cancels only a running turn', () => {
    expect(run([{ event: 'local.cancelled' }]).outcome).toBe('idle');
    const cancelled = run([{ event: 'local.start' }, status('reasoning'), { event: 'local.cancelled' }]);
    expect(cancelled.outcome).toBe('cancelled');
    expect(statuses(cancelled)).toEqual(['done', 'done', 'stopped', 'skipped']);
    expect(progressAnnouncement(cancelled)).toBe('Stopped.');
  });

  it('starts implicitly if a status event arrives before local.start', () => {
    const progress = run([status('retrieving', 1)]);
    expect(progress.outcome).toBe('running');
    expect(statuses(progress)).toEqual(['done', 'active', 'pending', 'pending']);
    expect(progressAnnouncement(progress)).toBe('Retrieving evidence: 1 source found.');
  });
});

describe('deriveTurnProgress', () => {
  const base: Pick<TurnStreamState, 'status' | 'steps' | 'turn'> = { status: 'idle', steps: [], turn: null };

  it('is idle before anything is sent', () => {
    expect(deriveTurnProgress(base).outcome).toBe('idle');
  });

  it('replays recorded phases from the stream state', () => {
    const progress = deriveTurnProgress({
      ...base,
      status: 'streaming',
      steps: [
        { phase: 'classifying', detail: null, evidenceCount: null, at: 1 },
        { phase: 'retrieving', detail: null, evidenceCount: 4, at: 2 },
        { phase: 'reasoning', detail: null, evidenceCount: null, at: 3 },
      ],
    });
    expect(statuses(progress)).toEqual(['done', 'done', 'active', 'pending']);
    expect(progress.steps[1]?.evidenceCount).toBe(4);
  });

  it('maps terminal stream statuses', () => {
    expect(deriveTurnProgress({ ...base, status: 'completed', turn: makeTurn() }).outcome).toBe('completed');
    expect(deriveTurnProgress({ ...base, status: 'completed' }).steps.every((s) => s.status === 'done')).toBe(
      true,
    );
    expect(deriveTurnProgress({ ...base, status: 'blocked' }).outcome).toBe('blocked');
    expect(deriveTurnProgress({ ...base, status: 'failed' }).outcome).toBe('failed');
    expect(deriveTurnProgress({ ...base, status: 'cancelled' }).outcome).toBe('cancelled');
  });
});
