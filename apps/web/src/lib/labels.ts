import type { CoachMode, EscalationCategory, MemoryType, VentureStage, Visibility } from '@foundry/contracts';
import {
  BookOpen,
  Compass,
  Flag,
  FlaskConical,
  Gavel,
  Lightbulb,
  ListChecks,
  MessagesSquare,
  Milestone,
  Quote,
  Route,
  Scale,
  ShieldAlert,
  Sparkles,
  Swords,
  Target,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';

/** Display labels for contract enums, kept in one place so every screen uses the same words. */

export const STAGE_LABELS: Record<VentureStage, string> = {
  idea: 'Idea',
  discovery: 'Discovery',
  validation: 'Validation',
  business_model: 'Business model',
  commercialization: 'Commercialization',
  growth: 'Growth',
  transition: 'Transition',
};

/** Ordered stages for progress indicators. */
export const STAGE_ORDER: VentureStage[] = [
  'idea',
  'discovery',
  'validation',
  'business_model',
  'commercialization',
  'growth',
  'transition',
];

export const DOMAIN_LABELS: Record<string, string> = {
  consumer: 'Consumer',
  software: 'Software',
  hardware: 'Hardware',
  biomedical: 'Biomedical',
  clinical: 'Clinical',
  energy: 'Energy',
  social: 'Social impact',
  general: 'General',
};

export const MODE_LABELS: Record<CoachMode, { label: string; description: string; icon: LucideIcon }> = {
  diagnose: {
    label: 'Diagnose',
    description: 'Find the real constraint and riskiest assumption.',
    icon: Compass,
  },
  challenge: { label: 'Challenge', description: 'Stress-test a plan, claim or decision.', icon: Swords },
  coach: { label: 'Coach', description: 'Work through a decision step by step.', icon: MessagesSquare },
  teach: {
    label: 'Teach',
    description: 'Learn a framework with your venture as the example.',
    icon: BookOpen,
  },
  rehearse: {
    label: 'Rehearse',
    description: 'Practise a pitch or hard conversation and get scored.',
    icon: Target,
  },
  route: { label: 'Route', description: 'Find the right program resource or human expert.', icon: Route },
};

export const MEMORY_TYPE_LABELS: Record<MemoryType, { label: string; icon: LucideIcon }> = {
  fact: { label: 'Fact', icon: Quote },
  hypothesis: { label: 'Hypothesis', icon: Lightbulb },
  decision: { label: 'Decision', icon: Gavel },
  experiment: { label: 'Experiment', icon: FlaskConical },
  evidence: { label: 'Evidence', icon: Scale },
  action: { label: 'Action', icon: ListChecks },
  milestone: { label: 'Milestone', icon: Milestone },
  risk: { label: 'Risk', icon: TriangleAlert },
  preference: { label: 'Preference', icon: Sparkles },
  relationship: { label: 'Relationship', icon: Users },
  insight: { label: 'Insight', icon: Flag },
};

export const VISIBILITY_LABELS: Record<Visibility, { label: string; description: string }> = {
  founder_private: { label: 'Founder only', description: 'Visible to founders who authored it.' },
  team: { label: 'Team', description: 'Founders and team members.' },
  venture: { label: 'Venture', description: 'Everyone on the venture, including advisors.' },
  advisors: { label: 'Advisors', description: 'Shared with advisors.' },
};

export const ESCALATION_CATEGORY_LABELS: Record<EscalationCategory, string> = {
  security_identity: 'Security & identity',
  ip_licensing: 'IP & licensing',
  legal: 'Legal',
  securities_investment: 'Securities & investment',
  medical_regulatory: 'Medical & regulatory',
  safety_wellbeing: 'Safety & wellbeing',
  conflict_harassment: 'Conflict & harassment',
  expert_judgment: 'Expert judgment',
  low_grounding: 'Low grounding',
  other: 'Other',
};

export const REQUESTED_ROLE_LABELS: Record<string, string> = {
  eir: 'EIR',
  program_lead: 'Program lead',
  specialist: 'Specialist',
  university_support: 'University support',
};

export const SAFETY_ICON = ShieldAlert;

/**
 * What a failed document's `failureReason` code means for the person who uploaded it (codes from
 * `DOCUMENT_FAILURE_REASONS`; anything else gets a generic line).
 */
const DOCUMENT_FAILURE_MESSAGES: Record<string, string> = {
  spend_cap_reached:
    'Not indexed: today’s AI budget (the platform’s or yours) was used up. Retry after midnight UTC.',
  extract_failed: 'Text couldn’t be extracted from this file.',
  empty_text: 'This file contains no readable text.',
  too_large: 'This file is larger than the 10 MB limit.',
  object_missing: 'The upload didn’t finish. Upload the file again.',
  retries_exhausted: 'Processing kept failing. Retry, or upload the file again.',
  enqueue_failed: 'Processing couldn’t start. Retry in a moment.',
};

export function documentFailureMessage(reason: string | null): string {
  return (
    (reason === null ? undefined : DOCUMENT_FAILURE_MESSAGES[reason]) ?? 'Processing failed — not searchable.'
  );
}
