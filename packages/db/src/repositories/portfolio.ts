import { type PortfolioSummary } from '@foundry/contracts';
import { z } from 'zod';

import { col } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { queryOne } from './common.js';

const CountMap = z.record(z.string(), z.number().int().nullable());

const Raw = z.object({
  min_group_size: z.number().int(),
  ventures_by_stage: CountMap,
  escalations_by_category: CountMap,
  open_escalations_by_priority: z.record(z.string(), z.number().int()),
  active_ventures_30d: z.number().int(),
  sessions_30d: z.number().int(),
  confirmed_decisions_30d: z.number().int(),
  experiments_completed_30d: z.number().int(),
  median_feedback_rating_30d: z.number().nullable(),
});

/**
 * k-anonymous program aggregates via `app.portfolio_summary()` (SECURITY DEFINER; requires
 * program_lead or platform_admin in the request context, otherwise DbError 42501). Groups smaller than
 * `portfolio_min_group_size` are reported as null; no raw text is ever returned.
 */
export async function getPortfolioSummary(ex: SqlExecutor): Promise<PortfolioSummary> {
  const raw = await queryOne(
    ex,
    'SELECT app.portfolio_summary() AS summary',
    {},
    (r) => Raw.parse(col.json().decode(r.summary, 'summary')),
    'getPortfolioSummary',
  );
  return {
    minGroupSize: raw.min_group_size,
    venturesByStage: raw.ventures_by_stage,
    escalationsByCategory: raw.escalations_by_category,
    openEscalationsByPriority: raw.open_escalations_by_priority,
    activeVentures30d: raw.active_ventures_30d,
    sessions30d: raw.sessions_30d,
    confirmedDecisions30d: raw.confirmed_decisions_30d,
    experimentsCompleted30d: raw.experiments_completed_30d,
    medianFeedbackRating30d: raw.median_feedback_rating_30d,
  };
}
