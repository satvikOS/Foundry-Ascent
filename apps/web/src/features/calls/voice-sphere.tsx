import { useEffect, useRef, type CSSProperties } from 'react';

import { useMediaQuery } from '@/lib/hooks/use-media-query';
import type { AudioLevels } from '@/lib/realtime/avatar';
import type { CallSnapshot } from '@/lib/realtime/call-state';
import { SphereAvatar, type SphereState } from '@/lib/realtime/sphere';
import { cn } from '@/lib/utils';

export type { SphereState } from '@/lib/realtime/sphere';

/** The states in which the sphere moves (and so wants animation frames). */
const MOVING: ReadonlySet<SphereState> = new Set(['listening', 'speaking', 'thinking']);

/**
 * What the sphere shows for a call. Speaking is only ever shown while the vEIR's audio plays (the sphere itself
 * also holds still when the measured level is silent); muted, on hold or with its sound off it is inactive, and a
 * dropped connection is grey and still.
 */
export function sphereState(snapshot: CallSnapshot, avatarState: SphereState): SphereState {
  if (snapshot.phase === 'failed') return 'disconnected';
  if (snapshot.phase === 'ended' || snapshot.phase === 'ending') return 'ended';
  if (snapshot.reconnecting) return 'disconnected';
  if (snapshot.phase === 'live' && (snapshot.held || snapshot.audioBlocked)) return 'paused';
  return avatarState;
}

/** A recorded loudness envelope (10 Hz RMS, measured offline from real audio) and when it started playing. */
export interface RecordedEnvelope {
  readonly samples: readonly number[];
  /** `now()` when the first sample plays. */
  readonly startedAt: number;
  readonly hz?: number;
}

/** The envelope's level at `at` (linear between samples; silent before it starts and after it ends). */
export function envelopeLevel(envelope: RecordedEnvelope | null | undefined, at: number): number {
  if (!envelope || envelope.samples.length === 0) return 0;
  const position = ((at - envelope.startedAt) / 1000) * (envelope.hz ?? 10);
  if (position < 0 || position > envelope.samples.length - 1) return 0;
  const index = Math.floor(position);
  const a = envelope.samples[index] ?? 0;
  const b = envelope.samples[index + 1] ?? a;
  return a + (b - a) * (position - index);
}

/** A level source that plays recorded envelopes (the landing page's device ad: real measured audio, no sound). */
export function recordedLevels(
  envelopes: { readonly veir?: RecordedEnvelope | null; readonly founder?: RecordedEnvelope | null },
  now: () => number = () => performance.now(),
): () => AudioLevels {
  return () => {
    const at = now();
    return { veir: envelopeLevel(envelopes.veir, at), founder: envelopeLevel(envelopes.founder, at) };
  };
}

export interface VoiceSphereProps {
  state: SphereState;
  /**
   * The measured levels, read once per animation frame while the sphere moves (a recorded envelope through
   * {@link recordedLevels}, or a live source). Omit for a still sphere.
   */
  levels?: () => AudioLevels;
  /** CSS size (default: the call's `clamp(168px, 30vmin, 384px)`). */
  size?: string;
  /** Force the still variant (the media query is always honoured). */
  reducedMotion?: boolean;
  className?: string;
}

/**
 * The voice sphere as a standalone component (the landing page's device ad, the mini call bar). Its frames run
 * outside React: only while it moves, is on screen and the page is visible.
 */
export function VoiceSphere({ state, levels, size, reducedMotion = false, className }: VoiceSphereProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sphereRef = useRef<SphereAvatar | null>(null);
  const levelsRef = useRef(levels);
  const prefersReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const still = reducedMotion || prefersReduced;
  const animated = !still && levels !== undefined && MOVING.has(state);

  useEffect(() => {
    levelsRef.current = levels;
  }, [levels]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const sphere = new SphereAvatar();
    sphere.mount(host, { reducedMotion: still });
    sphereRef.current = sphere;
    return () => {
      sphere.unmount();
      sphereRef.current = null;
    };
  }, [still]);

  useEffect(() => {
    sphereRef.current?.setState(state);
  }, [state, still]);

  useEffect(() => {
    const host = hostRef.current;
    if (!animated || !host) return undefined;
    let frame = 0;
    let onScreen = true;
    const loop = () => {
      const source = levelsRef.current;
      if (source) sphereRef.current?.setLevels(source());
      frame = requestAnimationFrame(loop);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      const hidden = document.visibilityState === 'hidden' || !onScreen;
      host.dataset.hidden = String(hidden);
      if (!hidden) frame = requestAnimationFrame(loop);
    };
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            update();
          })
        : null;
    observer?.observe(host);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [animated]);

  return (
    <div
      ref={hostRef}
      data-slot="voice-sphere"
      className={cn('grid place-items-center', className)}
      style={size ? ({ '--fa-sphere-size': size } as CSSProperties) : undefined}
    />
  );
}
