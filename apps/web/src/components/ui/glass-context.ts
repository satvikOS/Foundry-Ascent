import { createContext, useContext } from 'react';

/*
 * Glass never stacks on glass (globals.css, `--glass-*`). A floating layer (a menu, popover, select or tooltip) is
 * frosted glass, but one opened from inside the floating side panel may lie over the panel's own glass: there it
 * is solid. The panel provides `true`; React context crosses the overlays' portals, so the layer knows where it was
 * opened from even though it renders in <body>.
 */
export const OverGlassContext = createContext(false);

/** The class a floating layer adds when it was opened from a glass surface: solid there (`.over-glass`). */
export function useOverGlassClass(): string | undefined {
  return useContext(OverGlassContext) ? 'over-glass' : undefined;
}
