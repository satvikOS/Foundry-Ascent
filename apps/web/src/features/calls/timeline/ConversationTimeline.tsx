import './timeline.css';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';

import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { drawTimeline, layoutTimeline, TIMELINE_PALETTES, type TimelineLayout } from './timeline-canvas';
import { turnEnd, type Speaker, type TimelineSource, type TimelineTurn } from './timeline-model';

const MAX_DPR = 2;

/** "1:05" */
export function clockLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function durationLabel(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const head = `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return rest === 0 ? head : `${head} ${String(rest)} ${rest === 1 ? 'second' : 'seconds'}`;
}

/** "Corin · vEIR, 0:42 to 0:54, 12 seconds"; a turn still going: "You, from 0:54, speaking now". */
export function turnLabel(turn: TimelineTurn, names: Record<Speaker, string>): string {
  const who = names[turn.speaker];
  if (turn.endMs === null) return `${who}, from ${clockLabel(turn.startMs)}, speaking now`;
  const end = turnEnd(turn);
  return `${who}, ${clockLabel(turn.startMs)} to ${clockLabel(end)}, ${durationLabel(end - turn.startMs)}`;
}

function excerpt(text: string): string {
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

/** Which palette the page is using: the canvas's own `color` resolves `light-dark()` (see timeline.css). */
function activePalette(canvas: HTMLCanvasElement) {
  const color = getComputedStyle(canvas).color;
  return color.startsWith('rgb(255') ? TIMELINE_PALETTES.dark : TIMELINE_PALETTES.light;
}

export interface ConversationTimelineProps {
  source: TimelineSource;
  /** How each speaker is named in labels and the legend ("You", "Corin · vEIR"). */
  names: Record<Speaker, string>;
  /** Activating a segment (Enter or click): e.g. show that turn's words. */
  onSelectTurn?: (turn: TimelineTurn) => void;
  /** Show the two-item legend under the bar. */
  legend?: boolean;
  className?: string;
}

/**
 * The waveform conversation timeline: a dark bar of speaker turns as rounded blocks (green for the student, blue
 * for the vEIR) with vertical bars from the real measured amplitude, and a dotted line between turns. One canvas,
 * redrawn only when a bin lands (10 Hz) or the size or theme changes; React renders only when turns open or close.
 * Each turn is a keyboard-reachable button over the canvas (roving tabindex, arrows, Home and End) named by
 * speaker and time, so colour is never the only cue.
 */
export function ConversationTimeline({
  source,
  names,
  onSelectTurn,
  legend = false,
  className,
}: ConversationTimelineProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [whole, setWhole] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const structure = useSyncExternalStore(source.subscribe, source.structure, source.structure);
  // A fresh list whenever the structure changes (turns opened, closed, annotated).
  const turns = useMemo(() => [...source.turns()], [source, structure]);
  const wholeRef = useRef(whole);
  wholeRef.current = whole;

  const draw = useCallback(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layout: TimelineLayout = layoutTimeline(source.turns(), source.elapsedMs(), width, {
      whole: wholeRef.current,
    });
    drawTimeline(ctx, layout, { width, height }, activePalette(canvas), source.measured);
    // The overlay buttons follow the segments without a React render.
    const overlay = overlayRef.current;
    if (overlay) {
      for (const { turn, x, width: w } of layout.segments) {
        const button = overlay.querySelector<HTMLElement>(`[data-turn="${turn.id}"]`);
        if (!button) continue;
        button.style.left = `${String(Math.max(0, x))}px`;
        button.style.width = `${String(Math.max(0, Math.min(w, width - x)))}px`;
        button.hidden = false;
      }
      const shown = new Set(layout.segments.map((segment) => segment.turn.id));
      for (const button of overlay.querySelectorAll<HTMLElement>('[data-turn]')) {
        if (!shown.has(button.dataset.turn ?? '')) button.hidden = true;
      }
    }
    frame.dataset.scrolling = String(layout.scrolling);
    setScrolling((current) => (current === layout.scrolling ? current : layout.scrolling));
  }, [source]);

  // Redraw when a bin lands (the source notifies at 10 Hz at most) and whenever the turns re-render.
  useEffect(() => source.subscribe(draw), [source, draw]);
  useEffect(() => {
    draw();
  }, [draw, turns, whole]);

  // Size and theme changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const redraw = () => {
      draw();
    };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(redraw) : null;
    resize?.observe(canvas);
    const themes = new MutationObserver(redraw);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    // jsdom and old engines may lack matchMedia (same guard as useMediaQuery).
    const scheme =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    scheme?.addEventListener('change', redraw);
    return () => {
      resize?.disconnect();
      themes.disconnect();
      scheme?.removeEventListener('change', redraw);
    };
  }, [draw]);

  const active = turns.some((turn) => turn.id === focused) ? focused : (turns.at(-1)?.id ?? null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = turns.findIndex((turn) => turn.id === active);
    const targets: Record<string, number> = {
      ArrowRight: Math.min(turns.length - 1, index + 1),
      ArrowDown: Math.min(turns.length - 1, index + 1),
      ArrowLeft: Math.max(0, index - 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: turns.length - 1,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const id = turns[next]?.id;
    if (!id) return;
    setFocused(id);
    overlayRef.current?.querySelector<HTMLElement>(`[data-turn="${id}"]`)?.focus();
  };

  return (
    <div className={cn('fa-timeline', className)}>
      <div ref={frameRef} className="fa-timeline__frame" role="group" aria-label="Conversation timeline">
        <canvas ref={canvasRef} className="fa-timeline__canvas" aria-hidden="true" />
        {/* The overlay holds one button per turn, positioned by the draw pass. */}
        <div ref={overlayRef} className="fa-timeline__overlay" onKeyDown={onKeyDown}>
          {turns.map((turn) => {
            const label = turnLabel(turn, names);
            const words = excerpt(turn.text);
            return (
              <SimpleTooltip
                key={turn.id}
                side="top"
                content={
                  <span className="grid gap-0.5">
                    <span>{label}</span>
                    {words ? <span className="text-muted-foreground">{words}</span> : null}
                  </span>
                }
              >
                <button
                  type="button"
                  data-turn={turn.id}
                  data-speaker={turn.speaker}
                  aria-label={label}
                  tabIndex={turn.id === active ? 0 : -1}
                  className="fa-timeline__turn"
                  onFocus={() => {
                    setFocused(turn.id);
                  }}
                  onClick={() => {
                    onSelectTurn?.(turn);
                  }}
                />
              </SimpleTooltip>
            );
          })}
        </div>
      </div>
      {legend || scrolling || whole ? (
        <div className="fa-timeline__foot">
          {legend ? (
            <ul aria-label="Timeline legend" className="fa-timeline__legend">
              <li>
                <span aria-hidden data-speaker="student" />
                {names.student}
              </li>
              <li>
                <span aria-hidden data-speaker="veir" />
                {names.veir}
              </li>
            </ul>
          ) : (
            <span />
          )}
          {scrolling || whole ? (
            <button
              type="button"
              aria-pressed={whole}
              className="fa-timeline__whole"
              onClick={() => {
                setWhole((value) => !value);
              }}
            >
              Whole call
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
