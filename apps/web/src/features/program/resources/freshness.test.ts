import type { ResourceView } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { isOverdue } from '../escalations/status';
import { resourceFreshness, safeExternalUrl } from './freshness';
import { resourcePatch } from './resource-form-sheet';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe('resource freshness', () => {
  it('grades reviews as fresh, review soon, or overdue', () => {
    expect(resourceFreshness(daysAgo(10), NOW)).toEqual({ level: 'fresh', ageDays: 10 });
    expect(resourceFreshness(daysAgo(90), NOW).level).toBe('fresh');
    expect(resourceFreshness(daysAgo(91), NOW).level).toBe('review_soon');
    expect(resourceFreshness(daysAgo(181), NOW).level).toBe('overdue');
    expect(resourceFreshness('not a date', NOW).level).toBe('overdue');
  });

  it('only renders http(s) links', () => {
    expect(safeExternalUrl('https://example.edu/fund')).toBe('https://example.edu/fund');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });

  it('patches only the fields that changed', () => {
    const resource: ResourceView = {
      id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      name: 'Proof of concept fund',
      kind: 'funding',
      description: 'Small grants.',
      url: null,
      tags: ['grants'],
      stages: ['validation'],
      eligibility: null,
      owner: null,
      freshnessAt: daysAgo(5),
      status: 'active',
    };
    expect(
      resourcePatch(resource, {
        name: 'Proof of concept fund',
        kind: 'funding',
        description: 'Small grants up to $25k.',
        url: null,
        tags: ['grants', 'seed'],
        stages: ['validation'],
        eligibility: null,
        owner: null,
      }),
    ).toEqual({ description: 'Small grants up to $25k.', tags: ['grants', 'seed'] });
  });
});

describe('escalation status helpers', () => {
  it('treats only open escalations past their due date as overdue', () => {
    expect(isOverdue({ status: 'routed', dueAt: daysAgo(1) }, NOW)).toBe(true);
    expect(isOverdue({ status: 'resolved', dueAt: daysAgo(1) }, NOW)).toBe(false);
    expect(isOverdue({ status: 'acknowledged', dueAt: null }, NOW)).toBe(false);
  });
});
