import type { MemoryObjectView } from '@foundry/contracts';
import { z } from 'zod';

/*
 * Typed views over memory `attributes` (a free-form JSON object in the contract). Parsing is tolerant:
 * a malformed field becomes undefined instead of failing the whole object, because memory can be
 * written by people, imports and the coach.
 */

const text = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1))
  .optional()
  .catch(undefined);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .transform((s) => s.slice(0, 10))
  .optional()
  .catch(undefined);
const textList = z
  .array(z.string())
  .transform((items) => items.map((s) => s.trim()).filter(Boolean))
  .optional()
  .catch(undefined);
const count = z.number().int().nonnegative().optional().catch(undefined);

export const EXPERIMENT_STATUSES = ['planned', 'running', 'completed', 'abandoned'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const MILESTONE_STATUSES = ['planned', 'in_progress', 'at_risk', 'done', 'missed'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export const ACTION_STATUSES = ['open', 'in_progress', 'done', 'dropped'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const DecisionAttributes = z.object({
  owner: text,
  rationale: text,
  reversal_condition: text,
  decided_on: isoDate,
  alternatives: textList,
});
export type DecisionAttributes = z.infer<typeof DecisionAttributes>;

export const ExperimentAttributes = z.object({
  prediction: text,
  method: text,
  success_criteria: text,
  sample_size: count,
  result: text,
  interpretation: text,
  decision: text,
  status: z.enum(EXPERIMENT_STATUSES).optional().catch(undefined),
});
export type ExperimentAttributes = z.infer<typeof ExperimentAttributes>;

export const MilestoneAttributes = z.object({
  owner: text,
  target_date: isoDate,
  status: z.enum(MILESTONE_STATUSES).optional().catch(undefined),
  dependency: text,
});
export type MilestoneAttributes = z.infer<typeof MilestoneAttributes>;

export const ActionAttributes = z.object({
  owner: text,
  due: isoDate,
  status: z.enum(ACTION_STATUSES).optional().catch(undefined),
});
export type ActionAttributes = z.infer<typeof ActionAttributes>;

function parse<T>(schema: z.ZodType<T>, attributes: Record<string, unknown>): T {
  const parsed = schema.safeParse(attributes);
  // Every field has a .catch, so parsing an object never fails; keep a typed fallback anyway.
  return parsed.success ? parsed.data : schema.parse({});
}

export const decisionAttributes = (m: Pick<MemoryObjectView, 'attributes'>) =>
  parse(DecisionAttributes, m.attributes);
export const experimentAttributes = (m: Pick<MemoryObjectView, 'attributes'>) =>
  parse(ExperimentAttributes, m.attributes);
export const milestoneAttributes = (m: Pick<MemoryObjectView, 'attributes'>) =>
  parse(MilestoneAttributes, m.attributes);
export const actionAttributes = (m: Pick<MemoryObjectView, 'attributes'>) =>
  parse(ActionAttributes, m.attributes);

/** Today as YYYY-MM-DD in the viewer's time zone. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Format a YYYY-MM-DD date without shifting it across time zones. */
export function formatIsoDate(
  value: string | undefined | null,
  style: 'medium' | 'short' = 'medium',
): string {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: style === 'medium' ? 'medium' : undefined,
    ...(style === 'short' ? { month: 'short', day: 'numeric' } : {}),
  }).format(new Date(y, m - 1, d));
}

/** Whole days from today to `date` (negative = in the past). */
export function daysUntil(date: string, now: Date = new Date()): number {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10));
  const target = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export const ATTRIBUTE_LABELS: Record<string, string> = {
  owner: 'Owner',
  rationale: 'Rationale',
  reversal_condition: 'Reversal condition',
  decided_on: 'Decided on',
  alternatives: 'Alternatives considered',
  prediction: 'Prediction',
  method: 'Method',
  success_criteria: 'Success criteria',
  sample_size: 'Sample size',
  result: 'Result',
  interpretation: 'Interpretation',
  decision: 'Resulting decision',
  status: 'Status',
  target_date: 'Target date',
  dependency: 'Depends on',
  due: 'Due',
  assumption_type: 'Assumption type',
  riskiness: 'Riskiness',
  source: 'Source',
  collected_on: 'Collected on',
  n: 'Sample (n)',
  strength: 'Strength',
  likelihood: 'Likelihood',
  impact: 'Impact',
  mitigation: 'Mitigation',
  counterpart_role: 'Counterpart',
  next_contact: 'Next contact',
};

export function humaniseKey(key: string): string {
  const label = ATTRIBUTE_LABELS[key];
  if (label) return label;
  const text = key.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function humaniseValue(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Render-ready attribute rows: dates formatted, enums humanised, lists joined, empties dropped. */
export function attributeRows(
  attributes: Record<string, unknown>,
): { key: string; label: string; value: string }[] {
  const rows: { key: string; label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(attributes)) {
    let value: string | null = null;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) value = formatIsoDate(trimmed);
      else if (/^[a-z]+(_[a-z]+)*$/.test(trimmed) && trimmed.length <= 24) value = humaniseValue(trimmed);
      else value = trimmed;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      value = String(raw);
    } else if (Array.isArray(raw)) {
      const items = raw.filter(
        (item): item is string | number => typeof item === 'string' || typeof item === 'number',
      );
      if (items.length === 0) continue;
      value = items.join('; ');
    }
    if (value !== null) rows.push({ key, label: humaniseKey(key), value });
  }
  return rows;
}
