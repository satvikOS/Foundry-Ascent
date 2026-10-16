import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import { callErrorMessage } from '@/lib/realtime/call-api';

import { callRouteFrom } from './call-context';
import { callBlocker } from './call-lobby';
import { callClock, formatClock, spokenDuration } from './use-call-clock';

const VENTURE = '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01';
const SESSION = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02';

describe('callRouteFrom', () => {
  it('reads New chat and conversation URLs with and without ?call=1', () => {
    expect(callRouteFrom(`/ain/app/v/${VENTURE}`, { call: 1 }, 'ain')).toEqual({
      ventureId: VENTURE,
      sessionId: null,
      open: true,
    });
    expect(callRouteFrom(`/ain/app/v/${VENTURE}/c/${SESSION}`, { call: '1' }, 'ain')).toEqual({
      ventureId: VENTURE,
      sessionId: SESSION,
      open: true,
    });
    expect(callRouteFrom(`/ain/app/v/${VENTURE}/c/${SESSION}`, {}, 'ain')?.open).toBe(false);
  });

  it('never opens the call screen on other pages or another tenant', () => {
    expect(callRouteFrom(`/ain/app/v/${VENTURE}/knowledge`, { call: 1 }, 'ain')).toEqual({
      ventureId: VENTURE,
      sessionId: null,
      open: false,
    });
    expect(callRouteFrom('/ain/app/admin/settings', { call: 1 }, 'ain')).toBeNull();
    expect(callRouteFrom(`/other/app/v/${VENTURE}`, { call: 1 }, 'ain')).toBeNull();
  });
});

describe('call clock', () => {
  it('formats elapsed time and its spoken form', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(252.7)).toBe('4:12');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(spokenDuration(252)).toBe('4 minutes 12 seconds');
    expect(spokenDuration(60)).toBe('1 minute');
    expect(spokenDuration(0)).toBe('0 seconds');
  });

  it('counts down from the server’s remaining seconds and warns in the last two minutes', () => {
    const at = 1_000_000;
    expect(callClock({ liveAt: at, remaining: { seconds: 1200, at } }, at + 61_000)).toMatchObject({
      elapsed: 61,
      leftLabel: '19 min left',
      warning: false,
    });
    expect(callClock({ liveAt: at, remaining: { seconds: 150, at } }, at + 45_000)).toMatchObject({
      leftLabel: '1:45 left',
      warning: true,
    });
    expect(callClock({ liveAt: null, remaining: null }, at)).toMatchObject({ elapsed: 0, leftLabel: null });
  });
});

describe('callBlocker', () => {
  const config = {
    veir: {} as never,
    provider: 'builtin' as const,
    maxMinutes: 20,
    remainingMinutesToday: 40,
    aiEnabled: true,
    callNoticeAcknowledgedAt: null,
  };

  it('lets the team call when AI is on and minutes are left', () => {
    expect(callBlocker({ writable: true, name: 'Corin', config, configError: null })).toBeNull();
    expect(callBlocker({ writable: true, name: 'Corin', config: undefined, configError: null })).toBeNull();
  });

  it('explains every reason a call cannot start', () => {
    expect(callBlocker({ writable: false, name: 'Corin', config, configError: null })?.message).toMatch(
      /only its founders and team can call Corin/,
    );
    expect(
      callBlocker({
        writable: true,
        name: 'Corin',
        config: { ...config, aiEnabled: false },
        configError: null,
      })?.title,
    ).toBe('Calls are paused');
    expect(
      callBlocker({
        writable: true,
        name: 'Corin',
        config: { ...config, remainingMinutesToday: 0.5 },
        configError: null,
      })?.title,
    ).toBe('No call minutes left today');
    // The calls switch, sent by servers whose call settings carry it.
    const callsOff = { ...config, callsEnabled: false };
    expect(callBlocker({ writable: true, name: 'Corin', config: callsOff, configError: null })).toMatchObject(
      { title: 'Calls are paused', retry: false },
    );
    expect(callBlocker({ writable: true, name: 'Corin', config, configError: 'Offline' })).toMatchObject({
      message: 'Offline',
      retry: true,
    });
  });
});

describe('callErrorMessage', () => {
  it('says a turn hit the day’s AI allowance calmly: typed chat pauses too, and nothing was lost', () => {
    const error = new ApiError({
      status: 429,
      code: 'spend_cap_reached',
      title: 'Daily AI budget reached',
      detail: 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
    });
    expect(callErrorMessage(error)).toBe(
      'You have reached your daily AI coaching budget. It resets at midnight UTC. Typed chat pauses too until then. Your conversation is saved.',
    );
  });
});
