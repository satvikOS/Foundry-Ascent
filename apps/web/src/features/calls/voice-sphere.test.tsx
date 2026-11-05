import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LIVE } from './testing';
import { envelopeLevel, recordedLevels, sphereState, VoiceSphere } from './voice-sphere';

describe('sphereState', () => {
  it('shows what the call is really doing', () => {
    expect(sphereState(LIVE, 'listening')).toBe('listening');
    expect(sphereState({ ...LIVE, held: true }, 'muted')).toBe('paused');
    expect(sphereState({ ...LIVE, audioBlocked: true }, 'speaking')).toBe('paused');
    expect(sphereState({ ...LIVE, reconnecting: true }, 'connecting')).toBe('disconnected');
    expect(sphereState({ ...LIVE, phase: 'failed' }, 'idle')).toBe('disconnected');
    expect(sphereState({ ...LIVE, phase: 'ended' }, 'idle')).toBe('ended');
  });
});

describe('recorded envelopes', () => {
  it('plays a measured 10 Hz envelope by time, silent outside it', () => {
    const envelope = { samples: [0, 0.2, 0.4], startedAt: 1_000 };
    expect(envelopeLevel(envelope, 900)).toBe(0);
    expect(envelopeLevel(envelope, 1_050)).toBeCloseTo(0.1, 5);
    expect(envelopeLevel(envelope, 1_200)).toBeCloseTo(0.4, 5);
    expect(envelopeLevel(envelope, 1_300)).toBe(0);
    expect(envelopeLevel(null, 1_000)).toBe(0);
    let now = 1_100;
    const levels = recordedLevels({ veir: envelope }, () => now);
    expect(levels()).toEqual({ veir: 0.2, founder: 0 });
    now = 5_000;
    expect(levels()).toEqual({ veir: 0, founder: 0 });
  });
});

describe('VoiceSphere', () => {
  it('renders a decorative sphere at the requested size, in its state', () => {
    const { container, rerender } = render(<VoiceSphere state="idle" size="2rem" />);
    const host = container.querySelector<HTMLElement>('[data-slot="voice-sphere"]');
    expect(host?.style.getPropertyValue('--fa-sphere-size')).toBe('2rem');
    const sphere = container.querySelector<HTMLElement>('.fa-sphere');
    expect(sphere?.getAttribute('aria-hidden')).toBe('true');
    rerender(<VoiceSphere state="muted" size="2rem" />);
    expect(container.querySelector<HTMLElement>('.fa-sphere')?.dataset.state).toBe('muted');
  });
});
