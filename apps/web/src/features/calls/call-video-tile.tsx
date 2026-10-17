import { useEffect, useRef } from 'react';

import { monogram } from '@/lib/veir';
import { cn } from '@/lib/utils';

import type { CallVeir } from './use-call-veir';

interface CallVideoTileProps {
  veir: CallVeir;
  /** The face's live video (a vendor's WebRTC stream, the stand-in's canvas). */
  stream: MediaStream | null;
  /** The vEIR is being heard: the tile's edge lights up, like the active speaker in a video call. */
  speaking: boolean;
  /** The founder, shown as their initials in the corner tile (the camera stays off). */
  you: string;
  /** Both voices' loudness (0–1); the corner tile follows the founder's microphone. */
  levels: () => { veir: number; founder: number };
  reducedMotion: boolean;
  className?: string;
}

/**
 * The call as a video call: the vEIR's face fills a 16:9 tile with its name in the corner, and the founder
 * sits in a small corner tile (initials, never a camera). The video element is always muted: the call's own
 * audio path plays the vEIR's voice (with ducking for barge-in and the captions' timing), so the tile can never
 * double the audio or play anything the call did not.
 */
export function CallVideoTile({
  veir,
  stream,
  speaking,
  you,
  levels,
  reducedMotion,
  className,
}: CallVideoTileProps) {
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
    <figure
      data-slot="call-video-tile"
      data-speaking={speaking || undefined}
      className={cn(
        'relative aspect-video w-[min(44rem,92vw,calc((100dvh-22rem)*16/9))] overflow-hidden rounded-2xl bg-black shadow-lg ring-1 ring-white/10',
        className,
      )}
    >
      <video
        ref={videoRef}
        data-slot="call-video"
        autoPlay
        playsInline
        muted
        aria-hidden
        className="absolute inset-0 size-full object-cover"
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-success/80 ring-inset',
          reducedMotion ? '' : 'transition-opacity duration-300',
          speaking ? 'opacity-100' : 'opacity-0',
        )}
      />
      <figcaption className="absolute bottom-2.5 left-2.5 rounded-md bg-black/55 px-2 py-1 text-[0.8125rem] leading-none text-white backdrop-blur-sm">
        {veir.name}
      </figcaption>
      <div
        aria-hidden
        data-slot="call-you-tile"
        className="absolute right-2.5 bottom-2.5 grid aspect-video w-[24%] min-w-24 place-items-center rounded-lg bg-neutral-900 ring-1 ring-white/10"
      >
        <span
          ref={ringRef}
          className="grid size-9 place-items-center rounded-full bg-neutral-700 font-sans text-[0.75rem] font-medium text-white shadow-[0_0_0_calc(var(--fa-you,0)*6px)_rgb(255_255_255/0.25)] sm:size-11 sm:text-[0.875rem]"
        >
          {monogram(you)}
        </span>
        <span className="absolute bottom-1 left-1.5 text-[0.625rem] leading-none text-white/70">You</span>
      </div>
    </figure>
  );
}
