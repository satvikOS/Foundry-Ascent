/**
 * Operator insights Lambda (FoundryAscent-Insights): invoked directly (never from the web) by the
 * ops-insights GitHub workflow through the FoundryAscent-OpsInsights role, the only principal allowed to.
 * Read-only: metadata as numbers and codes, or the content sealed to the operator's public key
 * (jobs/insights.ts). The event is never logged.
 */
import { type InsightsResponse, runInsights } from '../jobs/insights.js';
import { createInsightsRuntime } from '../runtime/insights.js';

const deps = createInsightsRuntime(process.env);

export const handler = (event: unknown): Promise<InsightsResponse> => runInsights(deps, event);
