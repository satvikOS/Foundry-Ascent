import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hasLayerAbove, useLayerEscape } from './layers';

function layer(state: 'open' | 'closed' = 'open', role = 'dialog'): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('role', role);
  element.dataset.state = state;
  document.body.append(element);
  return element;
}

describe('stacked layers', () => {
  it('sees an open dialog portalled after this one as above it', () => {
    const sheet = layer();
    expect(hasLayerAbove(sheet)).toBe(false);
    const about = layer();
    expect(hasLayerAbove(sheet)).toBe(true);
    expect(hasLayerAbove(about)).toBe(false);
    // Closing (its exit animation still on screen) or nested inside: not above.
    about.dataset.state = 'closed';
    expect(hasLayerAbove(sheet)).toBe(false);
    sheet.append(layer('open', 'alertdialog'));
    expect(hasLayerAbove(sheet)).toBe(false);
    document.body.replaceChildren();
  });

  it('hands an Escape meant for the dialog above on to it, before Radix has ranked it on top', async () => {
    const onEscape = vi.fn();
    let handle: ((event: KeyboardEvent) => void) | null = null;
    function Sheet() {
      const escape = useLayerEscape(onEscape);
      handle = escape.onEscapeKeyDown;
      return <div role="dialog" data-state="open" {...escape.layerProps} />;
    }
    render(<Sheet />);
    const press = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      handle?.(event);
      return event.defaultPrevented;
    };
    // Nothing above: the sheet closes as usual (the caller's own handler runs too).
    expect(press()).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // About opened over it (portalled after it): the sheet keeps still and hands the Escape on, a frame later, to
    // whichever layer is on top by then.
    const about = layer();
    const seen: KeyboardEvent[] = [];
    const listen = (event: KeyboardEvent) => {
      seen.push(event);
    };
    document.addEventListener('keydown', listen, { capture: true });
    expect(press()).toBe(true);
    expect(seen).toHaveLength(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(seen.map((event) => event.key)).toEqual(['Escape']);
    document.removeEventListener('keydown', listen, { capture: true });
    about.remove();
    expect(press()).toBe(false);
  });
});
