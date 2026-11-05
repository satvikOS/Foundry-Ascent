import { useEffect, useState } from 'react';

import { ConversationTimeline } from '@/features/calls/timeline/ConversationTimeline';
import type { TimelineSource, TimelineTurn } from '@/features/calls/timeline/timeline-model';

/**
 * The ad's turns as a timeline source: the call's own timeline reads it exactly as it reads a live call. The
 * structure version bumps only when a turn opens, closes or the loop restarts; every other update is a new bin.
 */
export class FrameTimeline implements TimelineSource {
  readonly measured = true;
  private list: readonly TimelineTurn[] = [];
  private elapsed = 0;
  private shape = '';
  private version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  structure = (): number => this.version;

  turns = (): readonly TimelineTurn[] => this.list;

  elapsedMs = (): number => this.elapsed;

  /** The turns heard so far and the time since the call started (ms). */
  set(turns: readonly TimelineTurn[], elapsedMs: number): void {
    const shape = turns.map((turn) => `${turn.id}:${String(turn.endMs)}`).join('|');
    if (shape !== this.shape) {
      this.shape = shape;
      this.version += 1;
    }
    this.list = turns;
    this.elapsed = Math.max(0, elapsedMs);
    for (const listener of this.listeners) listener();
  }
}

export interface AdTimelineProps {
  turns: readonly TimelineTurn[];
  /** Time since the call started (ms). */
  elapsedMs: number;
  /** The span the bar's width stands for (ms): the ad's whole call. */
  spanMs: number;
  /** The vEIR's name as the call's timeline labels it ("Corin · vEIR"). */
  veirName: string;
  className?: string;
}

/** The call's conversation timeline, playing the ad's recorded turns (redrawn as the ad's frames land, 10 Hz). */
export function AdTimeline({ turns, elapsedMs, spanMs, veirName, className }: AdTimelineProps) {
  const [source] = useState(() => new FrameTimeline());
  useEffect(() => {
    source.set(turns, elapsedMs);
  }, [source, turns, elapsedMs]);
  return (
    <ConversationTimeline
      source={source}
      names={{ veir: veirName, student: 'You' }}
      minSpanMs={spanMs}
      {...(className === undefined ? {} : { className })}
    />
  );
}
