import { useEffect, useRef, useState } from 'react';

import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { isLowPerf } from '@/lib/perf';
import type { AvatarState } from '@/lib/realtime/avatar';
import { SphereAvatar } from '@/lib/realtime/sphere';

import envelopes from './envelopes.json';

const BIN_MS = 1000 / envelopes.hz;
const GAP_MS = 900;
const VEIR_MS = envelopes.veir.length * BIN_MS;
const STUDENT_MS = envelopes.student.length * BIN_MS;
const LOOP_MS = VEIR_MS + GAP_MS + STUDENT_MS + GAP_MS;
const PLAYS = 3;

function level(bins: readonly number[], offset: number): number {
  if (offset < 0) return 0;
  return bins[Math.floor(offset / BIN_MS)] ?? 0;
}

/** The voice demo's state and both voices' levels `t` ms into its loop (the recorded lines, then a pause). */
export function voiceAt(t: number): { state: AvatarState; veir: number; founder: number } {
  if (t < VEIR_MS) return { state: 'speaking', veir: level(envelopes.veir, t), founder: 0 };
  const student = t - VEIR_MS - GAP_MS;
  if (student < 0) return { state: 'listening', veir: 0, founder: 0 };
  if (student < STUDENT_MS)
    return { state: 'listening', veir: 0, founder: level(envelopes.student, student) };
  return { state: 'thinking', veir: 0, founder: 0 };
}

/**
 * The call's voice sphere on its own, voiced by the two recorded lines: speaking with the vEIR's audio, listening
 * to the student's, then thinking. It plays three times while on screen in a visible tab and then rests; under
 * reduced motion or on a slow device it is still. Decorative (the band's heading says what it is).
 */
export function VoiceDemo() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const still = reducedMotion || isLowPerf();
  const [presence] = useState(() => new SphereAvatar());

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    presence.mount(stage, { reducedMotion: still });
    presence.setState(still ? 'listening' : 'idle');
    if (still)
      return () => {
        presence.unmount();
      };
    let frame = 0;
    let elapsed = 0;
    let last: number | null = null;
    let onScreen = false;
    let state: AvatarState | null = null;
    const tick = (now: number) => {
      elapsed += last === null ? 0 : Math.min(100, now - last);
      last = now;
      const done = elapsed >= LOOP_MS * PLAYS;
      const voice = done ? voiceAt(LOOP_MS - 1) : voiceAt(elapsed % LOOP_MS);
      if (voice.state !== state) {
        state = voice.state;
        presence.setState(voice.state);
      }
      presence.setLevels(voice);
      frame = done ? 0 : requestAnimationFrame(tick);
    };
    const update = () => {
      const playing = onScreen && document.visibilityState === 'visible' && elapsed < LOOP_MS * PLAYS;
      if (playing && frame === 0) {
        last = null;
        frame = requestAnimationFrame(tick);
      } else if (!playing && frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
        presence.setLevels({ veir: 0, founder: 0 });
      }
    };
    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      update();
    });
    observer.observe(stage);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      cancelAnimationFrame(frame);
      presence.unmount();
    };
  }, [presence, still]);

  return (
    <div
      ref={stageRef}
      aria-hidden
      data-slot="voice-demo"
      className="relative grid aspect-square w-[min(72%,20rem)] place-items-center [--fa-sphere-size:100%]"
    />
  );
}
