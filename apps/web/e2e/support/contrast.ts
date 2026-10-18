import type { Locator } from '@playwright/test';

export interface TextContrast {
  /** The text, cut short (for the failure message). */
  text: string;
  /** The lowest WCAG contrast of the text over any of the backdrops. */
  ratio: number;
}

/**
 * The WCAG contrast of every visible text inside `bar` (a translucent glass bar), each over what is behind it at
 * its worst: the text's own background and its ancestors' up to and including the bar, laid over each colour in
 * `under` (what can scroll beneath the bar: the page, a prose line, a filled control). No credit is given for the
 * blur: a solid block of the content's colour (a filled button, a heading) passes under the bar unblurred at its
 * centre. Colours are composited by the browser itself on a canvas. Decorative text (`aria-hidden`) is skipped.
 */
export async function barTextContrast(bar: Locator, under: readonly string[]): Promise<TextContrast[]> {
  return bar.evaluate((root, unders) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no canvas');
    const paint = (colours: readonly string[]): number[] => {
      context.clearRect(0, 0, 1, 1);
      for (const colour of colours) {
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (rgb: number[]): number => {
      const [r = 0, g = 0, b = 0] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const texts: Element[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || texts.includes(parent)) continue;
      if (parent.closest('[aria-hidden="true"], .sr-only')) continue;
      const box = parent.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || getComputedStyle(parent).visibility === 'hidden') continue;
      texts.push(parent);
    }
    return texts.map((element) => {
      const layers: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        layers.unshift(getComputedStyle(node).backgroundColor);
        if (node === root) break;
      }
      const colour = getComputedStyle(element).color;
      const ratio = Math.min(
        ...unders.map((base) => {
          const back = luminance(paint([base, ...layers]));
          const fore = luminance(paint([base, ...layers, colour]));
          const [hi, lo] = back > fore ? [back, fore] : [fore, back];
          return (hi + 0.05) / (lo + 0.05);
        }),
      );
      return { text: element.textContent.trim().slice(0, 40), ratio };
    });
  }, under);
}
