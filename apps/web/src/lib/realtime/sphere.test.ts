import { describe, expect, it } from 'vitest';

import { createAvatarProvider } from './avatar';
import { follow, perceived, SphereAvatar } from './sphere';

/** A sphere on a stage with a clock the test advances by one 60 Hz frame per `frame()`. */
function mounted(reducedMotion = false) {
  let now = 0;
  const stage = document.createElement('div');
  const sphere = new SphereAvatar(() => now);
  sphere.mount(stage, { reducedMotion });
  const root = stage.querySelector<HTMLElement>('.fa-sphere');
  const body = stage.querySelector<HTMLElement>('.fa-sphere__body');
  // The white clouds first, then their tinted undersides.
  const clouds = [
    stage.querySelector<HTMLElement>('.fa-sphere__cloud:not(.fa-sphere__cloud--b)'),
    stage.querySelector<HTMLElement>('.fa-sphere__cloud--b'),
  ];
  const light = stage.querySelector<HTMLElement>('.fa-sphere__light');
  const frame = (levels: { veir: number; founder: number }, frames = 1) => {
    for (let i = 0; i < frames; i++) {
      now += 1000 / 60;
      sphere.setLevels(levels);
    }
  };
  return { stage, sphere, root, body, clouds, light, frame };
}

describe('SphereAvatar (the voice sphere)', () => {
  it('mounts a decorative orb of a body, two cloud layers and a highlight, and unmounts cleanly', () => {
    const { stage, sphere, root, body, clouds, light } = mounted();
    expect(stage.firstElementChild).toBe(root);
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.dataset.state).toBe('idle');
    expect(body).not.toBeNull();
    expect(clouds.every(Boolean)).toBe(true);
    expect(light).not.toBeNull();
    sphere.unmount();
    expect(stage.querySelector('.fa-sphere')).toBeNull();
  });

  it('never moves as speaking without audible output', () => {
    const { sphere, body, clouds, frame } = mounted();
    sphere.setState('speaking');
    frame({ veir: 0, founder: 0 }, 30);
    // Silent "speaking" looks like listening: no level scale, the slow drift only.
    expect(body?.style.transform).toBe('scale(1.0000)');
    expect(sphere.audible()).toBe(false);
    const drift = clouds[0]?.style.transform;
    frame({ veir: 0.1, founder: 0 }, 30);
    expect(sphere.audible()).toBe(true);
    expect(Number(/scale\(([\d.]+)\)/.exec(body?.style.transform ?? '')?.[1])).toBeGreaterThan(1.02);
    expect(clouds[0]?.style.transform).not.toBe(drift);
    // The audio stops: within the release (~300 ms) it settles back to the listening look.
    frame({ veir: 0, founder: 0 }, 40);
    expect(sphere.audible()).toBe(false);
    expect(body?.style.transform).toBe('scale(1.0000)');
  });

  it('follows the microphone while listening, and lights the highlight with it', () => {
    const { sphere, body, light, frame } = mounted();
    sphere.setState('listening');
    frame({ veir: 0, founder: 0 }, 5);
    expect(Number(light?.style.opacity)).toBeCloseTo(0.35, 2);
    frame({ veir: 0, founder: 0.15 }, 20);
    expect(Number(/scale\(([\d.]+)\)/.exec(body?.style.transform ?? '')?.[1])).toBeGreaterThan(1.02);
    expect(Number(light?.style.opacity)).toBeGreaterThan(0.6);
  });

  it('turns calmly while thinking, at an even rate that ignores the levels', () => {
    const { sphere, clouds, frame } = mounted();
    sphere.setState('thinking');
    const angle = () => Number(/rotate\((-?[\d.]+)deg\)/.exec(clouds[0]?.style.transform ?? '')?.[1]);
    frame({ veir: 0, founder: 0 }, 60);
    const quiet = angle();
    const other = mounted();
    other.sphere.setState('thinking');
    other.frame({ veir: 0.3, founder: 0.3 }, 60);
    const loud = Number(/rotate\((-?[\d.]+)deg\)/.exec(other.clouds[0]?.style.transform ?? '')?.[1]);
    // One turn per 24 s: about 15 degrees per second, whatever is heard.
    expect(quiet).toBeCloseTo(15, 0);
    expect(loud).toBeCloseTo(quiet, 3);
  });

  it('holds still while muted, paused, disconnected or ended', () => {
    for (const state of ['muted', 'paused', 'disconnected', 'ended', 'idle', 'connecting'] as const) {
      const { sphere, root, clouds, frame } = mounted();
      sphere.setState('listening');
      frame({ veir: 0, founder: 0.2 }, 10);
      const before = clouds[0]?.style.transform;
      sphere.setState(state);
      expect(root?.dataset.state).toBe(state);
      frame({ veir: 0.3, founder: 0.3 }, 30);
      expect(clouds[0]?.style.transform).toBe(before);
    }
  });

  it('stays still with reduced motion: the state shows only as data for the static treatments', () => {
    const { sphere, root, body, frame } = mounted(true);
    expect(root?.dataset.motion).toBe('reduced');
    sphere.setState('speaking');
    frame({ veir: 0.3, founder: 0 }, 10);
    expect(root?.dataset.state).toBe('speaking');
    expect(body?.style.transform).toBe('scale(1.0000)');
  });

  it('is the built-in provider for every persona', () => {
    expect(createAvatarProvider('builtin')).toBeInstanceOf(SphereAvatar);
    expect(createAvatarProvider('heygen').id).toBe('builtin');
    expect(createAvatarProvider('builtin').drawsFace).toBe(false);
  });

  it('keeps the perceptual curve and the attack/release smoothing', () => {
    expect(perceived(0)).toBe(0);
    expect(perceived(Number.NaN)).toBe(0);
    expect(perceived(1)).toBe(1);
    expect(perceived(0.06)).toBeCloseTo(0.6, 5);
    expect(follow(0, 1)).toBeCloseTo(0.45, 5);
    expect(follow(1, 0)).toBeCloseTo(0.88, 5);
  });
});
