import type { RecordingView } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { AudioLines, Captions, CaptionsOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Kbd } from '@/components/ui/kbd';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useOptionalCall } from '@/features/calls/call-context';
import { formatClock } from '@/features/calls/use-call-clock';
import { fetchPlayback } from '@/lib/api/hooks/recordings';
import { queryKeys } from '@/lib/api/query-keys';
import { formatDateTime } from '@/lib/format';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { cn } from '@/lib/utils';

import { cuesAt, parseWebVtt, type ShownCue } from './captions';

/*
 * Replays a recording with its captions in step (ADR-0023). The files come straight from the recordings store through
 * presigned GETs issued for this replay; nothing here calls the vEIR or any model. The captions show over the picture
 * and as a transcript beside it that follows the replay (the line being heard is marked and kept in view), where a
 * line jumps the recording to it. K plays or pauses it, J and L go back or forward ten seconds.
 *
 * A replay never plays over a live call: while one goes on, a replay does not start by itself (the founder would hear
 * two of the vEIR). On a voice call, playing it also puts the call on hold (the call's own hold: microphone off, resumed
 * from the call), so the replay is never heard as the founder speaking, and the microphone opening again pauses it.
 */

/**
 * One replay's queries (its presigned GETs, its captions). Outside `queryKeys.recordings` on purpose: a list refreshed
 * after a save or a delete must never fetch new URLs for a recording that is playing (it would restart it).
 */
function replayKey(recordingId: string, part: 'playback' | 'captions') {
  return [...queryKeys.all, 'recording-replay', recordingId, part] as const;
}

/**
 * A recording's presigned GETs for one replay, shared by everything that shows it (one request; never kept after it
 * closes: they are credentials that expire, and each replay is audited).
 */
export function useRecordingReplay(recordingId: string) {
  return useQuery({
    queryKey: replayKey(recordingId, 'playback'),
    queryFn: ({ signal }) => fetchPlayback(recordingId, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/** How far J and L move the replay. */
const SKIP_SECONDS = 10;
/** After the person scrolls the transcript themselves, it stops following the replay for this long. */
const OWN_SCROLL_MS = 4_000;

/** Smooth, unless the person asked for less motion. */
function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'auto';
  }
}

/** A WebM from MediaRecorder carries no duration: seeking to the end once makes the browser measure it. */
function measureDuration(video: HTMLVideoElement): void {
  if (Number.isFinite(video.duration)) return;
  const restore = () => {
    if (!Number.isFinite(video.duration)) return;
    video.removeEventListener('durationchange', restore);
    video.currentTime = 0;
  };
  video.addEventListener('durationchange', restore);
  video.currentTime = Number.MAX_SAFE_INTEGER;
}

/** The time (ms) of a playing media element, read every frame while it plays and on every seek. */
function usePlayhead(video: HTMLVideoElement | null): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (video === null) return undefined;
    let frame = 0;
    const read = () => {
      setMs(Math.round(video.currentTime * 1000));
    };
    const loop = () => {
      read();
      frame = requestAnimationFrame(loop);
    };
    const play = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const pause = () => {
      cancelAnimationFrame(frame);
      read();
    };
    video.addEventListener('play', play);
    video.addEventListener('pause', pause);
    video.addEventListener('ended', pause);
    video.addEventListener('seeked', read);
    video.addEventListener('timeupdate', read);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', play);
      video.removeEventListener('pause', pause);
      video.removeEventListener('ended', pause);
      video.removeEventListener('seeked', read);
      video.removeEventListener('timeupdate', read);
    };
  }, [video]);
  return ms;
}

/**
 * Keeps a replay and a live call apart: on a voice call, playing the replay holds the call, and the call's microphone
 * opening again (resumed, unmuted) pauses the replay. Says whether a call is live, and whether it is a voice call.
 */
function useReplayHoldsCall(video: HTMLVideoElement | null): { onCall: boolean; onVoiceCall: boolean } {
  const call = useOptionalCall();
  const engine = call?.engine ?? null;
  const snapshot = call?.snapshot ?? null;
  const onCall = snapshot !== null && snapshot.phase === 'live';
  const onVoiceCall = onCall && snapshot.input === 'voice';
  const microphoneOpen = onVoiceCall && !snapshot.muted && !snapshot.held;

  useEffect(() => {
    if (video === null || engine === null || !onVoiceCall) return undefined;
    const hold = () => {
      engine.hold();
    };
    video.addEventListener('play', hold);
    return () => {
      video.removeEventListener('play', hold);
    };
  }, [engine, onVoiceCall, video]);

  useEffect(() => {
    if (video !== null && microphoneOpen && !video.paused) video.pause();
  }, [microphoneOpen, video]);

  return { onCall, onVoiceCall };
}

interface RecordingPlayerProps {
  recording: RecordingView;
  /** Start playing as soon as it can (it was chosen with a click). */
  autoPlay?: boolean;
  className?: string;
}

export function RecordingPlayer({ recording, autoPlay = false, className }: RecordingPlayerProps) {
  const playback = useRecordingReplay(recording.id);
  const captionsUrl = playback.data?.captions?.url ?? null;
  const captions = useQuery({
    queryKey: replayKey(recording.id, 'captions'),
    queryFn: async ({ signal }) => {
      const response = await fetch(captionsUrl ?? '', { signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('The captions couldn’t be loaded.');
      return parseWebVtt(await response.text());
    },
    enabled: captionsUrl !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: 1,
  });
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [showCaptions, setShowCaptions] = useState(true);
  const resumeAt = useRef<number | null>(null);
  const playhead = usePlayhead(video);
  const { onCall, onVoiceCall } = useReplayHoldsCall(video);
  const cues = useMemo(() => captions.data ?? [], [captions.data]);
  const showing = cuesAt(cues, playhead);
  const label = `Recording of the call on ${formatDateTime(recording.createdAt)}`;
  const transcriptRef = useRef<HTMLOListElement | null>(null);
  const ownScrollAt = useRef(0);
  const current = showing.at(-1) ?? null;
  const currentKey = current === null ? null : `${String(current.startMs)}-${current.speaker}`;

  // The transcript keeps the line being heard in view, unless the person is reading elsewhere in it.
  useEffect(() => {
    const list = transcriptRef.current;
    if (list === null || currentKey === null || Date.now() - ownScrollAt.current < OWN_SCROLL_MS) return;
    const line = list.querySelector<HTMLElement>(`[data-cue="${currentKey}"]`);
    if (line === null) return;
    const top = line.offsetTop - list.offsetTop - list.clientHeight / 3;
    if (Math.abs(list.scrollTop - top) < line.offsetHeight) return;
    list.scrollTo({ top, behavior: scrollBehavior() });
  }, [currentKey]);

  useHotkeys(
    {
      k: () => {
        if (video === null) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
      },
      j: () => {
        if (video !== null) video.currentTime = Math.max(0, video.currentTime - SKIP_SECONDS);
      },
      l: () => {
        if (video !== null)
          video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SKIP_SECONDS);
      },
    },
    video !== null,
  );

  const onError = useCallback(() => {
    // A replay watched past its presigned GET's life: fresh ones, from where it stopped.
    const expiresAt = playback.data ? Date.parse(playback.data.media.expiresAt) : 0;
    if (video !== null && Date.now() > expiresAt - 60_000) {
      resumeAt.current = video.currentTime;
      void playback.refetch();
    }
  }, [playback, video]);

  useEffect(() => {
    if (video === null || resumeAt.current === null) return;
    const at = resumeAt.current;
    const resume = () => {
      video.currentTime = at;
      resumeAt.current = null;
      void video.play().catch(() => undefined);
    };
    video.addEventListener('loadedmetadata', resume, { once: true });
    return () => {
      video.removeEventListener('loadedmetadata', resume);
    };
  }, [playback.data, video]);

  const seek = (cue: ShownCue) => {
    if (video === null) return;
    video.currentTime = cue.startMs / 1000;
    void video.play().catch(() => undefined);
  };

  return (
    <section
      aria-label={label}
      data-slot="recording-player"
      className={cn('grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start', className)}
    >
      <div className="grid min-w-0 gap-2">
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-black ring-1 ring-border">
          {playback.isPending ? (
            <Skeleton className="absolute inset-0 rounded-none" />
          ) : playback.isError ? (
            <div className="absolute inset-0 grid place-items-center bg-background p-4">
              <ErrorState
                error={playback.error}
                title="This recording couldn’t be loaded"
                size="sm"
                onRetry={() => void playback.refetch()}
              />
            </div>
          ) : (
            <>
              <video
                key={playback.data.media.url}
                ref={setVideo}
                src={playback.data.media.url}
                controls
                playsInline
                preload="metadata"
                crossOrigin="anonymous"
                autoPlay={autoPlay && !onCall}
                aria-label={label}
                aria-keyshortcuts="K J L"
                data-slot="recording-video"
                onLoadedMetadata={(event) => {
                  measureDuration(event.currentTarget);
                }}
                onError={onError}
                className="absolute inset-0 size-full object-contain"
              />
              {recording.kind === 'audio' ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 grid place-items-center text-white/70"
                >
                  <AudioLines className="size-10" />
                </div>
              ) : null}
              {showCaptions && showing.length > 0 ? (
                <div
                  data-slot="recording-captions"
                  aria-hidden
                  className="pointer-events-none absolute inset-x-3 bottom-14 grid justify-items-center gap-1 text-center"
                >
                  {showing.map((cue) => (
                    <p
                      key={`${String(cue.startMs)}-${cue.speaker}`}
                      className="max-w-[46rem] rounded-md bg-black/75 px-2.5 py-1 text-sm leading-snug text-pretty text-white sm:text-base"
                    >
                      {cue.name ? <span className="font-semibold">{cue.name}: </span> : null}
                      {cue.text}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-small text-muted-foreground">
          <span className="hidden items-center gap-1.5 sm:flex">
            <Kbd>K</Kbd> play or pause · <Kbd>J</Kbd> <Kbd>L</Kbd> 10 seconds
          </span>
          {onVoiceCall ? (
            <span data-slot="recording-on-call">Playing this puts your call on hold.</span>
          ) : null}
          {recording.hasCaptions ? (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showCaptions}
              onClick={() => {
                setShowCaptions((on) => !on);
              }}
            >
              {showCaptions ? <Captions aria-hidden /> : <CaptionsOff aria-hidden />}
              Captions
            </Button>
          ) : null}
        </div>
      </div>
      {recording.hasCaptions ? (
        <div className="grid content-start gap-1 rounded-2xl border border-border p-2 lg:sticky lg:top-4">
          <h2 className="px-2 pt-1 text-small font-medium text-muted-foreground">Transcript</h2>
          {captions.isError ? (
            <p role="status" className="px-2 text-small text-muted-foreground">
              The captions couldn’t be loaded.
            </p>
          ) : (
            <ol
              ref={transcriptRef}
              aria-label="Transcript"
              onWheel={() => {
                ownScrollAt.current = Date.now();
              }}
              onTouchMove={() => {
                ownScrollAt.current = Date.now();
              }}
              className="grid max-h-[22rem] gap-0.5 overflow-y-auto overscroll-contain lg:max-h-[calc(100dvh-14rem)]"
            >
              {cues.map((cue) => {
                const key = `${String(cue.startMs)}-${cue.speaker}`;
                const active = showing.includes(cue);
                return (
                  <li key={key} data-cue={key}>
                    <button
                      type="button"
                      onClick={() => {
                        seek(cue);
                      }}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'grid w-full grid-cols-[3rem_minmax(0,1fr)] gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
                        active && 'bg-accent text-foreground',
                      )}
                    >
                      <span className="tabular text-muted-foreground">{formatClock(cue.startMs / 1000)}</span>
                      <span className="min-w-0">
                        {cue.name ? <span className="font-medium">{cue.name}: </span> : null}
                        <span className={active ? '' : 'text-muted-foreground'}>{cue.text}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
