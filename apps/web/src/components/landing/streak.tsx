/**
 * A soft band of colour across the page's ground (landing.css `.l-streak`), so the canvas is never a flat black or a
 * flat off-white: static layered gradients in the voice palette with the grain tile, faded in and out so it never
 * meets the bar or a band's edge. Decorative only, never animated; hidden in forced colours and in print.
 *
 * "hero" falls from the left behind the heading and the device ad; "mid" crosses the other way behind the ventures.
 */
export function Streak({ variant }: { variant: 'hero' | 'mid' }) {
  return (
    <span aria-hidden data-slot="streak" className={`l-streak-field l-streak-field--${variant}`}>
      <span className="l-streak grain" />
    </span>
  );
}
