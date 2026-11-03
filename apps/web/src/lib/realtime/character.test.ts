import { describe, expect, it } from 'vitest';

import { LocalCharacter } from './character';
import { presentationCapabilities } from './presentation';

function mounted(reducedMotion = false) {
  const character = new LocalCharacter();
  const stage = document.createElement('div');
  character.mount(stage, { reducedMotion });
  const root = stage.querySelector<HTMLElement>('.fa-character');
  if (!root) throw new Error('character did not mount');
  return { character, stage, root };
}

describe('live local character', () => {
  it('moves its mouth only with actual outgoing audio, never speech text or microphone input', () => {
    const { character, root } = mounted();
    character.setState('speaking');
    character.speak({ text: 'A caption alone is not speech.' });
    character.setLevels({ veir: 0, founder: 1 });
    expect(root.dataset.audible).toBe('false');
    character.setLevels({ veir: 0.1, founder: 0 });
    expect(Number(root.style.getPropertyValue('--mouth'))).toBeGreaterThan(0);
    character.setLevels({ veir: 0, founder: 1 });
    expect(Number(root.style.getPropertyValue('--mouth'))).toBe(0);
  });

  it.each(['idle', 'thinking', 'listening', 'connecting', 'muted'] as const)(
    'closes at once in %s, even with stale levels',
    (state) => {
      const { character, root } = mounted();
      character.setState('speaking');
      character.setLevels({ veir: 0.2, founder: 0 });
      character.setState(state);
      character.setLevels({ veir: 0.2, founder: 0 });
      expect(root.dataset.audible).toBe('false');
      expect(root.style.getPropertyValue('--mouth')).toBe('0.000');
    },
  );

  it.each([NaN, Infinity, -1, 0, 0.001])('treats invalid or inaudible RMS %s as silence', (veir) => {
    const { character, root } = mounted();
    character.setState('speaking');
    character.setLevels({ veir, founder: 1 });
    expect(root.dataset.audible).toBe('false');
  });

  it('remains still under reduced motion and releases all DOM on repeated mounts', () => {
    const { character, root, stage } = mounted(true);
    character.setState('speaking');
    character.setLevels({ veir: 1, founder: 1 });
    expect(root.dataset.motion).toBe('reduced');
    expect(root.dataset.audible).not.toBe('true');
    character.mount(stage, { reducedMotion: true });
    expect(stage.querySelectorAll('svg')).toHaveLength(1);
    character.unmount();
    character.unmount();
    expect(stage.children).toHaveLength(0);
  });

  it('negotiates engine-owned amplitude sync accurately', () => {
    expect(presentationCapabilities(new LocalCharacter())).toEqual({
      audioOwner: 'engine',
      synchronization: 'amplitude',
      remote: false,
      visemes: false,
      interruption: 'local',
    });
  });
});
