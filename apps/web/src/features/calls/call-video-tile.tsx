import { useEffect, useLayoutEffect, useRef } from 'react';

import { adoptFaceMedia } from '@/lib/realtime/embodiment/face-media';
import { monogram } from '@/lib/veir';
import { cn } from '@/lib/utils';

interface CallFaceVideoProps {
  /** The face's live video (a vendor's WebRTC stream, the stand-in's canvas), shown muted when there is no `media`. */
  stream: MediaStream | null;
  /**
   * A vendor face's own element, playing its video and audio together: shown as it is (never copied), so the voice
   * stays in step with the lips and is heard once.
   */
  media?: HTMLVideoElement | null;
  /** The founder, shown as their initials in the corner tile (the camera stays off). */
  you: string;
  /** Both voices' loudness (0–1); the corner tile follows the founder's microphone. */
  levels: () => { veir: number; founder: number };
  reducedMotion: boolean;
  /** A vendor's stock avatar (no one's likeness): labelled "AI avatar" on the tile, so it is never taken for the EIR. */
  stock?: boolean;
  className?: string;
}

const VIDEO_CLASSES = 'absolute inset-0 size-full object-cover';

/**
 * The call tile as a video call: the vEIR's face fills the tile, and the founder sits in a small corner tile
 * (initials, never a camera). A vendor face brings its own element (`media`), which plays its video and its voice
 * together, unmuted, so the browser keeps them in step; the tile only shows it, and while the tile is closed (the
 * call minimized) the element plays on in a hidden spot of the page, so the voice is never cut and never doubled.
 * Otherwise (the canvas stand-in, whose sound the call plays itself) the tile shows `stream` muted. A stock avatar
 * carries a visible "AI avatar" label in the corner.
 */
export function CallFaceVideo({
  stream,
  media = null,
  you,
  levels,
  reducedMotion,
  stock = false,
  className,
}: CallFaceVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // A layout effect: the element moves back to its hidden spot in the same task as the tile goes, so the browser
  // never pauses it (an element left off the page is paused).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || media === null) return undefined;
    media.className = VIDEO_CLASSES;
    return adoptFaceMedia(media, host);
  }, [media]);

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
      {media === null ? (
        <video
          ref={videoRef}
          data-slot="call-video"
          autoPlay
          playsInline
          muted
          aria-hidden
          className={VIDEO_CLASSES}
        />
      ) : (
        <div ref={hostRef} data-slot="call-video-host" aria-hidden className="absolute inset-0" />
      )}
      {stock ? (
        <span
          data-slot="call-ai-avatar-label"
          className="absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-[0.6875rem] leading-none font-medium text-white ring-1 ring-white/20"
        >
          AI avatar
        </span>
      ) : null}
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

/**
 * The face as a thumbnail (the mini call bar): the same live video, muted, in the place of the vEIR's monogram.
 * The bar shows the monogram instead when motion is reduced (it is decoration there; the call screen shows the
 * face itself).
 */
export function CallFaceThumbnail({
  stream,
  speaking,
  stock = false,
  className,
}: {
  stream: MediaStream | null;
  speaking: boolean;
  /** A vendor's stock avatar: the thumbnail says "AI avatar" (on hover and to assistive technology). */
  stock?: boolean;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <span
      data-slot="call-face-thumbnail"
      data-speaking={speaking || undefined}
      {...(stock ? { role: 'img', 'aria-label': 'AI avatar', title: 'AI avatar' } : {})}
      className={cn(
        'relative inline-flex size-6 shrink-0 overflow-hidden rounded-full bg-black ring-1 ring-border',
        speaking && 'ring-2 ring-foreground/40',
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-hidden
        className="size-full scale-125 object-cover"
      />
    </span>
  );
}
