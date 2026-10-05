import type { ResourceKind } from '@foundry/contracts';
import type { z } from 'zod';

/**
 * Resource freshness. Route mode recommends program resources to founders, so stale entries (wrong
 * deadline, retired program) directly hurt advice quality. A resource is due for review after
 * REVIEW_SOON_DAYS and overdue after REVIEW_OVERDUE_DAYS since its last review (`freshnessAt`).
 */
export const REVIEW_SOON_DAYS = 90;
export const REVIEW_OVERDUE_DAYS = 180;

export type FreshnessLevel = 'fresh' | 'review_soon' | 'overdue';

const DAY_MS = 24 * 60 * 60 * 1000;

export function resourceFreshness(
  freshnessAt: string,
  now = Date.now(),
): { level: FreshnessLevel; ageDays: number } {
  const reviewed = Date.parse(freshnessAt);
  const ageDays = Number.isNaN(reviewed)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor((now - reviewed) / DAY_MS));
  const level: FreshnessLevel =
    ageDays > REVIEW_OVERDUE_DAYS ? 'overdue' : ageDays > REVIEW_SOON_DAYS ? 'review_soon' : 'fresh';
  return { level, ageDays };
}

export const RESOURCE_KIND_LABELS: Record<z.infer<typeof ResourceKind>, string> = {
  program: 'Program',
  mentor_network: 'Mentor network',
  competition: 'Competition',
  funding: 'Funding',
  lab: 'Lab',
  commercialization: 'Commercialization',
  regulatory: 'Regulatory',
  legal_clinic: 'Legal clinic',
  workshop: 'Workshop',
  incubator: 'Incubator',
  template: 'Template',
  other: 'Other',
};

/** Only http(s) links are ever rendered as anchors (resource URLs are program-entered data). */
export function safeExternalUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
