import { useEffect, useRef } from 'react';

import { monogram } from '@/lib/veir';
import { cn } from '@/lib/utils';

interface CallFaceVideoProps {
  /** The face's live video (a vendor's WebRTC stream, the stand-in's canvas). */
  stream: MediaStream | null;
  /** The founder, shown as their initials in the corner tile (the camera stays off). */
  you: string;
  /** Both voices' loudness (0–1); the corner tile follows the founder's microphone. */
  levels: () => { veir: number; founder: number };
  reducedMotion: boolean;
  className?: string;
}

/**
 * The call tile as a video call: the vEIR's face fills the tile, and the founder sits in a small corner tile
 * (initials, never a camera). The video element is always muted: the call's own audio path plays the vEIR's
 * voice (with ducking for barge-in and the captions' timing), so the tile can never double the audio or play
 * anything the call did not.
 */
export function CallFaceVideo({ stream, you, levels, reducedMotion, className }: CallFaceVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // The founder's microphone moves the ring around their initials (still with reduced motion).
  useEffect(() => {
    if (reducedMotion) return undefined;
    let frame = 0;
    let shown = -1;
    const loop = () => {
      const level = Math.min(1, Math.sqrt(Math.max(0, levels().founder) * 6));
      if (Math.abs(level - shown) > 0.02) {
        ringRef.current?.style.setProperty('--fa-you', level.toFixed(2));
        shown = level;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [levels, reducedMotion]);

  return (
    <figure data-slot="call-face" className={cn('absolute inset-0 m-0', className)}>
      <video
        ref={videoRef}
        data-slot="call-video"
        autoPlay
        playsInline
        muted
        aria-hidden
        className="absolute inset-0 size-full object-cover"
      />
      <div
        aria-hidden
        data-slot="call-you-tile"
        className="absolute right-3 bottom-3 grid aspect-video w-[22%] min-w-20 place-items-center rounded-xl bg-neutral-900 ring-1 ring-white/10"
      >
        <span
          ref={ringRef}
          className={cn(
            'grid size-8 place-items-center rounded-full bg-neutral-700 font-sans text-[0.6875rem] font-medium text-white shadow-[0_0_0_calc(var(--fa-you,0)*6px)_rgb(255_255_255/0.25)] sm:size-10 sm:text-[0.8125rem]',
            reducedMotion ? '' : 'transition-shadow duration-100',
          )}
        >
          {monogram(you)}
        </span>
        <span className="absolute bottom-1 left-1.5 text-[0.625rem] leading-none text-white/70">You</span>
      </div>
    </figure>
  );
}
