import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BreathingGround } from './breathing-ground';
import { coverGround, groundCovered } from './ground-cover';

/*
 * The breathing ground's draw loop: it runs while the ground can be seen and stops while a full-screen layer (the
 * call screen) covers it, so nothing redraws behind a call and the glass above never recomputes its blur for it.
 */

function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;
}

describe('BreathingGround', () => {
  let pending: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    pending = new Map();
    nextId = 1;
    // No reduced motion, dark scheme or not: the loop runs.
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      pending.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.perf;
  });

  /** Runs the frames waiting now (each asks for the next). */
  function runFrames(time: number) {
    const now = [...pending.entries()];
    pending.clear();
    for (const [, callback] of now) callback(time);
  }

  it('draws while the ground is in view and stops while a full-screen layer covers it', () => {
    const { container, unmount } = render(<BreathingGround />);
    expect(container.querySelector('[data-slot="breathing-ground"]')).not.toBeNull();
    expect(pending.size).toBe(1);
    runFrames(1000);
    expect(pending.size, 'the loop goes on').toBe(1);

    const release = coverGround();
    expect(groundCovered()).toBe(true);
    expect(pending.size, 'covered: no frame is waiting').toBe(0);
    runFrames(2000);
    expect(pending.size).toBe(0);

    release();
    expect(groundCovered()).toBe(false);
    expect(pending.size, 'uncovered: it breathes again').toBe(1);
    unmount();
    expect(pending.size).toBe(0);
  });

  it('never starts under a cover that was already up', () => {
    const release = coverGround();
    try {
      render(<BreathingGround />);
      expect(pending.size).toBe(0);
    } finally {
      release();
    }
    expect(pending.size).toBe(1);
  });

  it('a release counts once, and the ground stays covered while another layer still covers it', () => {
    const first = coverGround();
    const second = coverGround();
    first();
    first();
    expect(groundCovered()).toBe(true);
    second();
    expect(groundCovered()).toBe(false);
  });

  it('draws nothing at all on a slow device', () => {
    document.documentElement.dataset.perf = 'low';
    const { container } = render(<BreathingGround />);
    expect(container.querySelector('canvas')).toBeNull();
    expect(pending.size).toBe(0);
  });
});
