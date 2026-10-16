import { describe, expect, it } from 'vitest';

import { createAvatarProvider } from './avatar';
import { PresenceAvatar } from './presence';

describe('PresenceAvatar (built-in avatar)', () => {
  it('mounts a decorative form behind the face and follows the call state and voices', () => {
    const stage = document.createElement('div');
    stage.append(document.createElement('span'));
    const presence = new PresenceAvatar();
    presence.mount(stage, { reducedMotion: false });

    const root = stage.querySelector<HTMLElement>('.fa-presence');
    expect(root).not.toBeNull();
    expect(stage.firstElementChild).toBe(root);
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.children).toHaveLength(4);

    presence.setState('speaking');
    expect(root?.dataset.state).toBe('speaking');
    presence.setLevels({ veir: 0.1, founder: 0 });
    expect(Number(root?.style.getPropertyValue('--fa-veir'))).toBeGreaterThan(0);
    presence.speak({ text: 'Hello.' });
    expect(root?.classList.contains('is-blooming')).toBe(true);

    presence.unmount();
    expect(stage.querySelector('.fa-presence')).toBeNull();
    expect(stage.children).toHaveLength(1);
  });

  it('stays still with reduced motion', () => {
    const stage = document.createElement('div');
    const presence = new PresenceAvatar();
    presence.mount(stage, { reducedMotion: true });
    presence.setLevels({ veir: 0.2, founder: 0.2 });
    presence.speak({ text: 'Hello.' });
    const root = stage.querySelector<HTMLElement>('.fa-presence');
    expect(root?.dataset.motion).toBe('reduced');
    expect(root?.style.getPropertyValue('--fa-veir')).toBe('');
    expect(root?.classList.contains('is-blooming')).toBe(false);
  });

  it('is the provider for every persona until a vendor adapter is registered', () => {
    expect(createAvatarProvider('builtin')).toBeInstanceOf(PresenceAvatar);
    expect(createAvatarProvider('heygen').id).toBe('builtin');
    expect(createAvatarProvider('builtin').drawsFace).toBe(false);
  });
});
