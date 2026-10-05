/**
 * Synthetic program resources for route mode. Names are generic descriptions, not real offices; URLs are
 * omitted on purpose (program staff add real links in the program console).
 */
import { type ResourceKind, type VentureStage } from '@foundry/contracts';
import { type z } from 'zod';

export interface SeedResource {
  readonly key: string;
  readonly name: string;
  readonly kind: z.infer<typeof ResourceKind>;
  readonly description: string;
  readonly tags: readonly string[];
  readonly stages: readonly VentureStage[];
  readonly eligibility: string | null;
  readonly owner: string;
}

export const SEED_RESOURCES: readonly SeedResource[] = [
  {
    key: 'tto',
    name: 'University technology transfer office',
    kind: 'commercialization',
    description:
      'Reviews invention disclosures, determines IP ownership for university-funded research and negotiates licences or options for startups built on university technology.',
    tags: ['ip', 'licensing', 'patents', 'invention-disclosure'],
    stages: ['discovery', 'validation', 'business_model', 'commercialization'],
    eligibility: 'Students, staff and faculty whose venture uses university-developed technology.',
    owner: 'Technology transfer (synthetic)',
  },
  {
    key: 'legal-clinic',
    name: 'Campus venture legal clinic',
    kind: 'legal_clinic',
    description:
      'Supervised law students help with entity formation, founder agreements, pilot and customer contract templates and terms of service. Not a substitute for retained counsel.',
    tags: ['legal', 'contracts', 'incorporation', 'founder-agreements'],
    stages: ['validation', 'business_model', 'commercialization'],
    eligibility: 'Enrolled student founders; appointment required.',
    owner: 'Law school clinic (synthetic)',
  },
  {
    key: 'clinical-pathway',
    name: 'Clinical innovation pathway advisor',
    kind: 'regulatory',
    description:
      'Advises health and medical-device ventures on regulatory pathway questions, clinical evidence planning, human-subjects review and reimbursement considerations.',
    tags: ['medical-device', 'regulatory', 'clinical', 'reimbursement', 'fda'],
    stages: ['discovery', 'validation', 'business_model', 'commercialization'],
    eligibility: 'Ventures with a health, clinical or medical-device component.',
    owner: 'Health innovation office (synthetic)',
  },
  {
    key: 'prototype-lab',
    name: 'Prototype lab access',
    kind: 'lab',
    description:
      'Makerspace with 3D printers, laser cutters, electronics benches and machinists for early hardware prototypes; safety training required before use.',
    tags: ['hardware', 'prototyping', 'electronics', 'fabrication'],
    stages: ['idea', 'discovery', 'validation'],
    eligibility: 'Program ventures after completing the lab safety course.',
    owner: 'Engineering makerspace (synthetic)',
  },
  {
    key: 'pre-seed-grant',
    name: 'Pre-seed grant program',
    kind: 'funding',
    description:
      'Non-dilutive grants of up to $5,000 for a defined validation experiment with a written plan, budget and success criteria.',
    tags: ['funding', 'grant', 'non-dilutive', 'experiments'],
    stages: ['discovery', 'validation'],
    eligibility: 'Program ventures with an experiment card reviewed by their EIR.',
    owner: 'Program office (synthetic)',
  },
  {
    key: 'regional-pitch',
    name: 'Regional pitch competition',
    kind: 'competition',
    description:
      'Annual student pitch competition with cash prizes and judge feedback; requires a short deck and evidence of customer discovery.',
    tags: ['pitch', 'competition', 'prize', 'investors'],
    stages: ['validation', 'business_model', 'commercialization'],
    eligibility: 'Student-led ventures in the region; application window in spring.',
    owner: 'Regional entrepreneurship network (synthetic)',
  },
  {
    key: 'discovery-workshop',
    name: 'Customer discovery workshop series',
    kind: 'workshop',
    description:
      'Four-session workshop on problem interviews, recruiting interviewees, synthesising notes and designing falsifiable experiments.',
    tags: ['customer-discovery', 'interviews', 'experiments'],
    stages: ['idea', 'discovery'],
    eligibility: 'All program ventures.',
    owner: 'Program office (synthetic)',
  },
  {
    key: 'mentor-network',
    name: 'Alumni mentor network',
    kind: 'mentor_network',
    description:
      'Volunteer alumni mentors matched by industry for monthly calls on go-to-market, hiring and operations questions.',
    tags: ['mentors', 'go-to-market', 'network', 'operations'],
    stages: ['validation', 'business_model', 'commercialization', 'growth'],
    eligibility: 'Ventures with an active founder enrolled in the program.',
    owner: 'Alumni relations (synthetic)',
  },
  {
    key: 'incubator',
    name: 'Community startup incubator',
    kind: 'incubator',
    description:
      'Off-campus incubator offering desk space, investor office hours and a cohort program for ventures preparing to raise or graduate.',
    tags: ['incubator', 'workspace', 'fundraising', 'transition'],
    stages: ['commercialization', 'growth', 'transition'],
    eligibility: 'Ventures with a working product and early revenue or pilots.',
    owner: 'Community incubator (synthetic)',
  },
  {
    key: 'experiment-template',
    name: 'Experiment card template',
    kind: 'template',
    description:
      'Template for an assumption test: assumption, prediction, method, sample, threshold, time box, cost and decision rule for each outcome.',
    tags: ['experiments', 'template', 'hypothesis'],
    stages: ['idea', 'discovery', 'validation', 'business_model'],
    eligibility: null,
    owner: 'Program office (synthetic)',
  },
  {
    key: 'unit-economics-template',
    name: 'Unit economics worksheet',
    kind: 'template',
    description:
      'Spreadsheet template for price, cost to serve, acquisition cost, payback period and contribution margin with pilot data.',
    tags: ['unit-economics', 'pricing', 'business-model', 'template'],
    stages: ['validation', 'business_model'],
    eligibility: null,
    owner: 'Program office (synthetic)',
  },
  {
    key: 'sbir-office-hours',
    name: 'Federal research grant office hours',
    kind: 'funding',
    description:
      'Office hours on non-dilutive federal research and innovation grants for deep-tech and health ventures, including eligibility and proposal planning.',
    tags: ['grants', 'non-dilutive', 'deep-tech', 'health'],
    stages: ['validation', 'business_model', 'commercialization'],
    eligibility: 'Ventures with a research-derived technology.',
    owner: 'Research development office (synthetic)',
  },
  {
    key: 'climate-accelerator',
    name: 'Climate hardware accelerator',
    kind: 'program',
    description:
      'Six-month accelerator for energy and climate hardware ventures with pilot-site introductions, certification guidance and manufacturing partners.',
    tags: ['climate', 'energy', 'hardware', 'pilots', 'manufacturing', 'certification'],
    stages: ['validation', 'commercialization', 'growth'],
    eligibility: 'Hardware ventures with a working prototype.',
    owner: 'Regional climate program (synthetic)',
  },
  {
    key: 'manufacturing-advisor',
    name: 'Manufacturing readiness advisor',
    kind: 'commercialization',
    description:
      'Reviews designs for manufacturability, supplier selection, small-batch production quotes and quality plans.',
    tags: ['manufacturing', 'hardware', 'suppliers', 'quality'],
    stages: ['validation', 'commercialization'],
    eligibility: 'Hardware ventures planning a run of 20 or more units.',
    owner: 'Engineering partnerships (synthetic)',
  },
  {
    key: 'sales-bootcamp',
    name: 'B2B sales bootcamp',
    kind: 'workshop',
    description:
      'Two-day bootcamp on discovery calls, pilot proposals, procurement and security questionnaires for selling to institutions.',
    tags: ['sales', 'b2b', 'procurement', 'pilots'],
    stages: ['validation', 'business_model', 'commercialization'],
    eligibility: 'Ventures selling to businesses or institutions.',
    owner: 'Program office (synthetic)',
  },
  {
    key: 'wellbeing',
    name: 'Student wellbeing and support services',
    kind: 'other',
    description:
      'Confidential counselling, crisis support and wellbeing resources for students, including founders under stress.',
    tags: ['wellbeing', 'support', 'crisis', 'counselling'],
    stages: [],
    eligibility: 'All enrolled students; urgent support available at any time.',
    owner: 'Student services (synthetic)',
  },
];

export interface SeedPattern {
  readonly key: string;
  readonly title: string;
  readonly context: string;
  readonly signal: string;
  readonly intervention: string;
  readonly outcome: string;
  readonly limits: string;
}

/** De-identified, synthetic lessons (published read path only in V1). */
export const SEED_PATTERNS: readonly SeedPattern[] = [
  {
    key: 'interviews-without-segment',
    title: 'Many interviews, no segment',
    context: 'Discovery-stage ventures that interview anyone willing to talk.',
    signal: 'Thirty or more interviews but no consistent description of who has the problem most acutely.',
    intervention:
      'Re-cut the notes by role and situation; pick the segment with the most recent, costly workaround and interview ten more of them.',
    outcome: 'Teams usually find one segment with markedly stronger pain within two weeks.',
    limits: 'Synthetic illustration; does not apply when the buyer is fixed by regulation or contract.',
  },
  {
    key: 'pilot-without-threshold',
    title: 'Pilot without a success threshold',
    context: 'Validation-stage ventures running free pilots with friendly customers.',
    signal: 'A pilot is "going well" but nobody wrote down what result would lead to a paid contract.',
    intervention:
      'Agree on a measurable success threshold and a paid next step with the pilot customer before the pilot starts.',
    outcome: 'Clear thresholds convert pilots or end them quickly, both of which save time.',
    limits: 'Synthetic illustration; some institutional buyers cannot commit in advance.',
  },
  {
    key: 'late-regulatory-check',
    title: 'Regulatory pathway checked too late',
    context: 'Health and safety-critical hardware ventures.',
    signal: 'Prototype design is nearly frozen but nobody has asked whether the product is regulated.',
    intervention:
      'Book a pathway review with a qualified advisor before the next design freeze; note open questions instead of guessing.',
    outcome: 'Teams avoid rebuilding prototypes for evidence they did not plan to collect.',
    limits: 'Synthetic illustration; the coach never determines the pathway itself.',
  },
];
