import { describe, expect, it } from 'vitest';

import {
  WAKE_INSTANCE_INTERVAL_MS,
  WAKE_MAX_TRACKED_IPS,
  WAKE_PER_IP_INTERVAL_MS,
  WakeGate,
} from './wake.js';

describe('WakeGate', () => {
  it('sends only when nothing recent proves the cluster awake or resuming', () => {
    let t = 0;
    const gate = new WakeGate(() => t);
    expect(gate.decide('a', 'awake')).toBe('recently_seen');
    expect(gate.decide('a', 'resuming')).toBe('recently_seen');
    expect(gate.decide('a', null)).toBe('sent');
    expect(gate.decide('b', null)).toBe('in_flight');
    gate.settled();
    expect(gate.decide('a', null)).toBe('ip_limit');
    expect(gate.decide('b', null)).toBe('instance_limit');
    t += WAKE_INSTANCE_INTERVAL_MS;
    expect(gate.decide('b', null)).toBe('sent');
    gate.settled();
    t += WAKE_PER_IP_INTERVAL_MS;
    expect(gate.decide('a', null)).toBe('sent');
  });

  it('stays within a database call per window, however many IPs call', () => {
    let t = 0;
    const gate = new WakeGate(() => t);
    let sent = 0;
    // One call from a new IP every second for ten minutes.
    for (let i = 0; i < 600; i += 1) {
      if (gate.decide(`198.51.100.${String(i)}`, null) === 'sent') {
        sent += 1;
        gate.settled();
      }
      t += 1_000;
    }
    expect(sent).toBe(Math.ceil((600 * 1_000) / WAKE_INSTANCE_INTERVAL_MS));
  });

  it('remembers a bounded number of IPs, forgetting the oldest', () => {
    let t = 0;
    const gate = new WakeGate(() => t);
    for (let i = 0; i <= WAKE_MAX_TRACKED_IPS; i += 1) {
      expect(gate.decide(`ip-${String(i)}`, null)).toBe('sent');
      gate.settled();
      t += WAKE_INSTANCE_INTERVAL_MS;
    }
    expect(gate.trackedIps).toBe(WAKE_MAX_TRACKED_IPS);
    // ip-0 was forgotten; the most recent one is still limited.
    t = (WAKE_MAX_TRACKED_IPS + 1) * WAKE_INSTANCE_INTERVAL_MS + 1;
    expect(gate.decide(`ip-${String(WAKE_MAX_TRACKED_IPS)}`, null)).toBe('ip_limit');
    expect(gate.decide('ip-0', null)).toBe('sent');
  });
});
