import { useCallback, useId } from 'react';

/*
 * Escape over stacked layers. Radix hands Escape to the layer it last rendered as the highest, and a layer opened
 * over another (About over the context sheet on a phone, Rename over the navigation sheet) becomes the highest one
 * render after it mounts: that render is scheduled from a DOM event, outside React's discrete updates, so for a
 * moment (about 50 ms on a busy phone) the layer beneath still listens for Escape and the newer layer does not yet.
 * An Escape in that moment closed the layer beneath and left the newer one open over the page.
 *
 * The root cause is that ordering, so the layer beneath asks the DOM, which is already right: dialogs portal to the
 * end of <body> in the order they open, so an open dialog after this one's content is above it. While one is, the
 * Escape belongs to it: this layer keeps still and hands the key on, a frame later, to whichever layer Radix ranks on
 * top by then (the newer one), so the person's Escape closes what they see on top, never the layer beneath, and is
 * never lost. A few frames at most: after that the key is dropped rather than passed around for ever.
 */

/** How many frames an Escape is handed on while the layer above is still being ranked. */
const MAX_FORWARDS = 8;

/** Escapes handed on from a layer beneath, with how many times each has been. */
const forwarded = new WeakMap<Event, number>();

function forwardEscape(event: KeyboardEvent): void {
  const count = (forwarded.get(event) ?? 0) + 1;
  if (count > MAX_FORWARDS) return;
  requestAnimationFrame(() => {
    // Sent from where focus is now (inside the layer above, once it has taken focus), as the person's key would be.
    const target = document.activeElement ?? document.body;
    const next = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    forwarded.set(next, count);
    target.dispatchEvent(next);
  });
}

/** Radix layers that take Escape when on top: dialogs (popovers are dialogs too), menus and listboxes. */
const OPEN_LAYERS = ['dialog', 'alertdialog', 'menu', 'listbox']
  .map((role) => `[role="${role}"][data-state="open"]`)
  .join(', ');

/** Whether an open layer sits above `own` (portalled after it, and not inside it). */
export function hasLayerAbove(own: Element | null): boolean {
  if (!own?.isConnected) return false;
  for (const layer of own.ownerDocument.querySelectorAll(OPEN_LAYERS)) {
    if (layer === own || own.contains(layer)) continue;
    if (own.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
  }
  return false;
}

/**
 * For a Radix dialog's content: a `data-layer` attribute to spread on it and an `onEscapeKeyDown` that hands an Escape
 * meant for a layer above on to it instead of closing this one (composed with the caller's own handler).
 */
export function useLayerEscape(onEscapeKeyDown?: (event: KeyboardEvent) => void): {
  layerProps: { 'data-layer': string };
  onEscapeKeyDown: (event: KeyboardEvent) => void;
} {
  const id = useId();
  const handle = useCallback(
    (event: KeyboardEvent) => {
      onEscapeKeyDown?.(event);
      if (event.defaultPrevented) return;
      // React's ids hold no quote or backslash, so the id is safe inside a quoted attribute selector.
      const own = document.querySelector(`[data-layer="${id}"]`);
      if (!hasLayerAbove(own)) return;
      event.preventDefault();
      forwardEscape(event);
    },
    [id, onEscapeKeyDown],
  );
  return { layerProps: { 'data-layer': id }, onEscapeKeyDown: handle };
}
