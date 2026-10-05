/**
 * Synthetic demo data (ADR-006: synthetic only). Every person and venture here is invented; names are
 * deliberately not those of real EIRs, staff or companies. Dates are relative to the first seed run.
 */
import { type EscalationPacket, type MembershipRole, type VentureStage } from '@foundry/contracts';
import { type z } from 'zod';

import {
  type MemoryOriginValue,
  type MemoryStatusValue,
  type MemoryTypeValue,
  type VisibilityValue,
} from '../repositories/memory.js';

export interface SeedPerson {
  readonly key: string;
  readonly displayName: string;
  readonly title: string;
}

export interface SeedEir extends SeedPerson {
  readonly expertiseTags: readonly string[];
  readonly routingIntents: readonly string[];
}

export interface SeedMemory {
  readonly key: string;
  readonly type: MemoryTypeValue;
  readonly title: string;
  readonly content: string;
  readonly status: MemoryStatusValue;
  readonly visibility: VisibilityValue;
  readonly confidence: number;
  readonly origin: MemoryOriginValue;
  /** Person key of the author (a founder/team member, or an EIR for `eir` origin). */
  readonly author: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly pinned?: boolean;
  /** Embed the venture canary in the content. */
  readonly canary?: boolean;
}

export interface SeedDocument {
  readonly key: string;
  readonly filename: string;
  readonly title: string;
  readonly uploadedBy: string;
  readonly sections: readonly { readonly heading: string; readonly content: string }[];
  /** Append a section carrying the venture canary. */
  readonly canary?: boolean;
}

export interface SeedVenture {
  /** Slug (also the canary key). */
  readonly key: string;
  readonly name: string;
  readonly oneLiner: string;
  readonly stage: VentureStage;
  readonly domain:
    'consumer' | 'software' | 'hardware' | 'biomedical' | 'clinical' | 'energy' | 'social' | 'general';
  readonly cohort: string;
  readonly currentGoal: string;
  /** EIR key for the active assignment. */
  readonly eir: string;
  readonly members: readonly { readonly person: string; readonly role: MembershipRole }[];
  readonly memory: readonly SeedMemory[];
  readonly documents: readonly SeedDocument[];
  readonly escalation?: {
    readonly key: string;
    readonly category: 'medical_regulatory' | 'ip_licensing' | 'legal' | 'securities_investment';
    readonly priority: 'P1' | 'P2' | 'P3';
    readonly createdBy: string;
    readonly consented: boolean;
    readonly packet: z.infer<typeof EscalationPacket>;
  };
}

export const SEED_PROGRAM_LEAD: SeedPerson = {
  key: 'lead-elise',
  displayName: 'Elise Brannigan',
  title: 'Program lead (synthetic)',
};

export const SEED_EIRS: readonly SeedEir[] = [
  {
    key: 'eir-corin',
    displayName: 'Corin Halvorsen',
    title: 'Synthetic EIR — go-to-market and B2B software',
    expertiseTags: ['go-to-market', 'b2b-sales', 'pricing', 'saas', 'consumer-apps'],
    routingIntents: ['pricing', 'sales_process', 'channel_strategy', 'customer_discovery'],
  },
  {
    key: 'eir-ruth',
    displayName: 'Ruth Abernathy-Song',
    title: 'Synthetic EIR — hardware, medtech and commercialization',
    expertiseTags: ['hardware', 'medtech', 'regulatory-pathway', 'manufacturing', 'climate-tech'],
    routingIntents: ['commercialization', 'regulatory_pathway', 'manufacturing', 'pilots'],
  },
];

export const SEED_FOUNDERS: readonly SeedPerson[] = [
  { key: 'maya', displayName: 'Maya Okafor-Lindqvist', title: 'Founder, QuietQuad (synthetic)' },
  { key: 'devin', displayName: 'Devin Ashcombe', title: 'Team, QuietQuad (synthetic)' },
  { key: 'priya', displayName: 'Priya Ramaswamy-Holt', title: 'Co-founder, BenchTally (synthetic)' },
  { key: 'tomasz', displayName: 'Tomasz Wrenfield', title: 'Co-founder, BenchTally (synthetic)' },
  { key: 'amara', displayName: 'Amara Nwosu-Belling', title: 'Founder, SoleSignal (synthetic)' },
  { key: 'graham', displayName: 'Graham Fenwick-Tate', title: 'Advisor, SoleSignal (synthetic)' },
  { key: 'jonah', displayName: 'Jonah Castellane', title: 'Founder, EmberLoop (synthetic)' },
  { key: 'ines', displayName: 'Ines Varga-Molloy', title: 'Team, EmberLoop (synthetic)' },
];

/** Builds the ventures; `day(n)` renders today + n days as YYYY-MM-DD. */
export function buildSeedVentures(day: (offsetDays: number) => string): SeedVenture[] {
  return [
    {
      key: 'quietquad',
      name: 'QuietQuad',
      oneLiner: 'A campus app that shows students where quiet study seats are open during exam weeks.',
      stage: 'discovery',
      domain: 'consumer',
      cohort: 'Fall cohort (synthetic)',
      currentGoal: 'Decide whether exam-week demand is strong enough to justify a two-library pilot.',
      eir: 'eir-corin',
      members: [
        { person: 'maya', role: 'founder' },
        { person: 'devin', role: 'team' },
      ],
      memory: [
        {
          key: 'h-seat-search',
          type: 'hypothesis',
          title: 'Students lose 20+ minutes finding a quiet seat in exam weeks',
          content:
            'During midterms and finals, undergraduates spend more than twenty minutes walking between buildings to find a quiet seat, and would check a live map if it saved that time.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.6,
          origin: 'founder',
          author: 'maya',
          attributes: { assumption_type: 'desirability', riskiness: 'high' },
          pinned: true,
        },
        {
          key: 'e-interviews',
          type: 'evidence',
          title: '14 problem interviews with undergraduates',
          content:
            'Nine of fourteen students described walking between two or more buildings to find a seat during midterms; three said they rely on friends posting open spots in group chats; two never study on campus.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.75,
          origin: 'founder',
          author: 'devin',
          attributes: { source: 'interview notes', collected_on: day(-21), n: 14, strength: 'behaviour' },
        },
        {
          key: 'x-seat-map',
          type: 'experiment',
          title: 'Hand-counted seat map posted hourly for one week',
          content:
            'A manual seat count for two libraries was posted hourly to a 200-student mailing list during one regular week to measure repeat use.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'maya',
          attributes: {
            prediction: 'At least 25% of the 200 recipients open the map on two or more days',
            method: 'Manual hourly seat counts posted to a static page; unique visits tracked by link',
            sample_size: 200,
            success_criteria: '50 or more repeat visitors in seven days',
            result:
              '38 repeat visitors (19%) — below threshold; usage spiked on the two days before a midterm',
            status: 'completed',
            decision: 'Narrow the test to exam weeks and rerun with notifications',
          },
        },
        {
          key: 'd-exam-focus',
          type: 'decision',
          title: 'Focus the first version on exam-week peaks',
          content:
            'Build for the two weeks before exams, when seat scarcity is acute, instead of everyday studying.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.65,
          origin: 'founder',
          author: 'maya',
          attributes: {
            rationale: 'Repeat use clustered before the midterm; everyday demand looked weak',
            alternatives: ['Everyday seat finder', 'Study-group matching'],
            reversal_condition: 'If the exam-week rerun shows under 15% repeat use',
            decided_on: day(-10),
          },
        },
        {
          key: 'a-staff-interviews',
          type: 'action',
          title: 'Interview five library staff about occupancy data',
          content: 'Learn how staff measure occupancy today and whether any counts can be shared.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'devin',
          attributes: { owner: 'Devin Ashcombe', due: day(5), status: 'open' },
        },
        {
          key: 'a-door-counters',
          type: 'action',
          title: 'Ask facilities whether door-counter data can be shared',
          content:
            'Email the facilities office to ask whether anonymised door-counter totals could feed the map.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'maya',
          attributes: { owner: 'Maya Okafor-Lindqvist', due: day(-3), status: 'open' },
        },
        {
          key: 'm-pilot',
          type: 'milestone',
          title: 'Exam-week pilot in two libraries',
          content:
            'Run the live map in two libraries for the two weeks before finals with at least 300 students invited.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.8,
          origin: 'founder',
          author: 'maya',
          attributes: { owner: 'Maya Okafor-Lindqvist', target_date: day(24), status: 'planned' },
        },
        {
          key: 'r-data-access',
          type: 'risk',
          title: 'Occupancy data may need facilities approval',
          content:
            'Sensor or door-counter data may require approval that takes longer than the pilot window.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.6,
          origin: 'founder',
          author: 'devin',
          attributes: {
            likelihood: 'medium',
            impact: 'high',
            mitigation: 'Start with crowd-sourced check-ins',
          },
        },
        {
          key: 'i-group-chats',
          type: 'insight',
          title: 'Group chats are the current workaround',
          content:
            'Students already share open seats in group chats; the product competes with that habit and should make sharing faster than a chat message.',
          status: 'proposed',
          visibility: 'venture',
          confidence: 0.55,
          origin: 'ai',
          author: 'maya',
          attributes: {},
        },
        {
          key: 'p-free',
          type: 'preference',
          title: 'Keep the student app free',
          content:
            'Maya prefers to keep the student-facing app free and explore library or campus licensing instead.',
          status: 'confirmed',
          visibility: 'founder_private',
          confidence: 0.8,
          origin: 'founder',
          author: 'maya',
          attributes: {},
        },
        {
          key: 'rel-library-ops',
          type: 'relationship',
          title: 'Library operations manager open to a pilot conversation',
          content:
            'A library operations manager agreed to a 30-minute call about a pilot after finals scheduling.',
          status: 'confirmed',
          visibility: 'team',
          confidence: 0.7,
          origin: 'founder',
          author: 'devin',
          attributes: { counterpart_role: 'library operations manager', next_contact: day(9) },
        },
        {
          key: 'f-reference',
          type: 'fact',
          title: 'Workspace reference code',
          content: 'Internal reference for this workspace (do not share outside the venture):',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 1,
          origin: 'founder',
          author: 'maya',
          attributes: {},
          canary: true,
        },
      ],
      documents: [
        {
          key: 'doc-interview-synthesis',
          filename: 'exam-week-interview-synthesis.md',
          title: 'Exam-week interview synthesis',
          uploadedBy: 'maya',
          canary: true,
          sections: [
            {
              heading: 'Who we talked to',
              content:
                'Fourteen undergraduates across four majors, recruited from two residence halls. Ten study on campus most days; four mostly at home. Interviews lasted 20 to 30 minutes and followed the program problem-interview guide.',
            },
            {
              heading: 'What they do today',
              content:
                'Students walk a loop of two or three libraries, ask friends in group chats, or give up and study in noisy common rooms. Several described arriving early on exam days to hold seats for friends.',
            },
            {
              heading: 'Open questions',
              content:
                'We do not yet know whether students would open an app rather than a group chat, whether libraries can share counts, or whether demand outside exam weeks is meaningful.',
            },
          ],
        },
      ],
    },
    {
      key: 'benchtally',
      name: 'BenchTally',
      oneLiner: 'Barcode-based reagent and consumables tracking for university research labs.',
      stage: 'validation',
      domain: 'software',
      cohort: 'Fall cohort (synthetic)',
      currentGoal: 'Convert two of six labs to paid pilots and confirm who signs the purchase.',
      eir: 'eir-corin',
      members: [
        { person: 'priya', role: 'founder' },
        { person: 'tomasz', role: 'founder' },
      ],
      memory: [
        {
          key: 'f-pilot-lab-items',
          type: 'fact',
          title: 'Pilot lab tracks about 1,400 items in spreadsheets',
          content:
            'The pilot lab keeps roughly 1,400 reagent and consumable line items in three shared spreadsheets.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.85,
          origin: 'founder',
          author: 'priya',
          attributes: { source: 'pilot lab spreadsheet export' },
        },
        {
          key: 'h-wtp',
          type: 'hypothesis',
          title: 'Lab managers will pay $40 per lab per month',
          content:
            'Lab managers will pay about $40 per lab per month to avoid expired-reagent waste and duplicate orders, from a discretionary budget line that does not need procurement.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.5,
          origin: 'founder',
          author: 'tomasz',
          attributes: { assumption_type: 'viability', riskiness: 'high' },
          pinned: true,
        },
        {
          key: 'e-waste-audit',
          type: 'evidence',
          title: 'Pilot lab discarded about $2,300 of expired reagents last semester',
          content:
            'A waste audit with the pilot lab manager found roughly $2,300 of expired reagents discarded in one semester, mostly duplicates ordered by different students.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'priya',
          attributes: { source: 'lab manager audit', collected_on: day(-30), n: 1, strength: 'behaviour' },
        },
        {
          key: 'x-priced-pilot',
          type: 'experiment',
          title: 'Priced pilot offer to six labs',
          content:
            'Six lab managers receive a demo and a written offer for a paid three-month pilot at $40 per month.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'tomasz',
          attributes: {
            prediction: 'At least two of six labs accept the paid pilot within three weeks',
            method: 'Demo plus priced offer email; follow-up call after one week',
            sample_size: 6,
            success_criteria: 'Two signed pilot agreements',
            result: null,
            status: 'running',
          },
        },
        {
          key: 'x-scan-speed',
          type: 'experiment',
          title: 'Shelf scan speed test',
          content:
            'Three graduate students scanned a shelf of 50 items with the prototype to time a weekly audit.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.8,
          origin: 'founder',
          author: 'priya',
          attributes: {
            prediction: 'A 50-item shelf takes under four minutes to scan',
            method: 'Timed scans by three students on the same shelf',
            sample_size: 3,
            success_criteria: 'Median under four minutes',
            result: 'Median 3 minutes 10 seconds',
            status: 'completed',
          },
        },
        {
          key: 'd-buyer',
          type: 'decision',
          title: 'Sell to lab managers, not principal investigators',
          content:
            'Target lab managers as the buyer because they own ordering and a small discretionary budget.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.6,
          origin: 'founder',
          author: 'tomasz',
          attributes: {
            rationale: 'Managers run the ordering workflow and can approve purchases under $500',
            alternatives: ['Principal investigators', 'Department administrators'],
            reversal_condition: 'If two of three pilots require PI or procurement sign-off',
            decided_on: day(-14),
          },
        },
        {
          key: 'a-legal-review',
          type: 'action',
          title: 'Send the pilot agreement draft for clinic review',
          content:
            'Ask the campus venture legal clinic to review the pilot agreement template before it goes to labs.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'tomasz',
          attributes: { owner: 'Tomasz Wrenfield', due: day(4), status: 'in_progress' },
        },
        {
          key: 'a-export',
          type: 'action',
          title: 'Import the pilot lab spreadsheet into the prototype',
          content: 'Load the three pilot spreadsheets so the lab can see its inventory in the prototype.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'priya',
          attributes: { owner: 'Priya Ramaswamy-Holt', due: day(-6), status: 'done' },
        },
        {
          key: 'm-two-pilots',
          type: 'milestone',
          title: 'Two paid pilots signed',
          content: 'Two labs sign paid three-month pilots.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.8,
          origin: 'founder',
          author: 'priya',
          attributes: { owner: 'Priya Ramaswamy-Holt', target_date: day(30), status: 'in_progress' },
        },
        {
          key: 'r-procurement',
          type: 'risk',
          title: 'Procurement may require a vendor security review',
          content:
            'University procurement may require a vendor security questionnaire for any software that stores lab data.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.55,
          origin: 'founder',
          author: 'tomasz',
          attributes: {
            likelihood: 'medium',
            impact: 'medium',
            mitigation: 'Prepare a one-page data-handling summary',
          },
        },
        {
          key: 'i-department-purchasing',
          type: 'insight',
          title: 'Department-level purchasing could shorten sales cycles',
          content:
            'Selling one department-wide subscription may avoid repeating the approval path lab by lab.',
          status: 'proposed',
          visibility: 'venture',
          confidence: 0.45,
          origin: 'eir',
          author: 'eir-corin',
          attributes: {},
        },
        {
          key: 'p-no-funding',
          type: 'preference',
          title: 'Avoid outside funding until pilots convert',
          content:
            'Priya wants to avoid raising outside money until at least two pilots convert to paid annual plans.',
          status: 'confirmed',
          visibility: 'founder_private',
          confidence: 0.8,
          origin: 'founder',
          author: 'priya',
          attributes: {},
        },
        {
          key: 'f-reference',
          type: 'fact',
          title: 'Workspace reference code',
          content: 'Internal reference for this workspace (do not share outside the venture):',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 1,
          origin: 'founder',
          author: 'priya',
          attributes: {},
          canary: true,
        },
      ],
      documents: [
        {
          key: 'doc-waste-audit',
          filename: 'pilot-lab-waste-audit.md',
          title: 'Pilot lab waste audit',
          uploadedBy: 'priya',
          canary: true,
          sections: [
            {
              heading: 'Method',
              content:
                'We reviewed one semester of disposal logs and order history with the lab manager and matched discarded items to purchase records.',
            },
            {
              heading: 'Findings',
              content:
                'About $2,300 of reagents expired before use. Most were duplicates ordered by different students who could not see existing stock. Ordering happens through a shared inbox the manager triages twice a week.',
            },
          ],
        },
        {
          key: 'doc-pricing-notes',
          filename: 'pricing-notes.md',
          title: 'Pricing notes',
          uploadedBy: 'tomasz',
          sections: [
            {
              heading: 'Price points under test',
              content:
                'We are testing $40 per lab per month for a three-month pilot. A department plan at $300 per month is a later option if three or more labs in one department adopt.',
            },
            {
              heading: 'Who signs',
              content:
                'Lab managers can approve purchases under $500 from discretionary funds. Anything larger, or any recurring contract, may need department or procurement approval — we still need to confirm this in each pilot.',
            },
          ],
        },
      ],
    },
    {
      key: 'solesignal',
      name: 'SoleSignal',
      oneLiner:
        'A pressure-sensing insole concept that flags foot-pressure hotspots between podiatry visits.',
      stage: 'business_model',
      domain: 'biomedical',
      cohort: 'Spring cohort (synthetic)',
      currentGoal: 'Clarify the regulatory and reimbursement pathway before building the next prototype.',
      eir: 'eir-ruth',
      members: [
        { person: 'amara', role: 'founder' },
        { person: 'graham', role: 'advisor' },
      ],
      memory: [
        {
          key: 'h-clinic-adoption',
          type: 'hypothesis',
          title: 'Podiatry clinics will prescribe a monitoring insole',
          content:
            'Podiatry clinics will prescribe an insole that flags pressure hotspots between visits if it fits their existing follow-up workflow.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.45,
          origin: 'founder',
          author: 'amara',
          attributes: { assumption_type: 'desirability', riskiness: 'high' },
          pinned: true,
        },
        {
          key: 'e-clinic-interviews',
          type: 'evidence',
          title: 'Eight interviews with podiatry clinic staff',
          content:
            'Six of eight described missing early warning signs between quarterly visits; two raised concerns about integrating another data feed into their records system.',
          status: 'confirmed',
          visibility: 'advisors',
          confidence: 0.7,
          origin: 'founder',
          author: 'amara',
          attributes: { source: 'interview notes', collected_on: day(-18), n: 8, strength: 'statement' },
        },
        {
          key: 'x-sensor-drift',
          type: 'experiment',
          title: 'Bench test of pressure-sensor drift over 30 days',
          content:
            'Measure drift of three sensor samples under a fixed load on the bench (non-clinical, no human subjects).',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'amara',
          attributes: {
            prediction: 'Drift stays under 5% over 30 days',
            method: 'Fixed-load bench rig, daily readings',
            sample_size: 3,
            success_criteria: 'All three samples under 5% drift',
            result: null,
            status: 'planned',
          },
        },
        {
          key: 'd-clinic-model',
          type: 'decision',
          title: 'Pursue a clinic-prescribed model, not direct-to-consumer',
          content:
            'Go to market through clinics that prescribe and monitor, rather than selling directly to patients.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.55,
          origin: 'founder',
          author: 'amara',
          attributes: {
            rationale:
              'Clinics hold the relationship and the follow-up workflow; consumer adherence is a known risk',
            alternatives: ['Direct to consumer', 'Insurer partnership'],
            reversal_condition: 'If clinics will not take on monitoring without reimbursement',
            decided_on: day(-12),
          },
        },
        {
          key: 'r-regulatory',
          type: 'risk',
          title: 'Regulatory pathway not yet determined',
          content:
            'Whether the product is a regulated medical device, and in which class, has not been determined by a qualified advisor.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.8,
          origin: 'founder',
          author: 'amara',
          attributes: {
            likelihood: 'high',
            impact: 'high',
            mitigation:
              'Meet the clinical innovation pathway advisor; make no classification claims meanwhile',
          },
        },
        {
          key: 'a-pathway-advisor',
          type: 'action',
          title: 'Book the clinical innovation pathway advisor',
          content:
            'Schedule a pathway review covering device classification questions and clinical evidence needs.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'amara',
          attributes: { owner: 'Amara Nwosu-Belling', due: day(7), status: 'open' },
        },
        {
          key: 'a-tto',
          type: 'action',
          title: 'Ask the technology transfer office about sensor IP',
          content:
            'Confirm whether the sensor design from the lab project is university-owned before any public demo.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'amara',
          attributes: { owner: 'Amara Nwosu-Belling', due: day(-2), status: 'open' },
        },
        {
          key: 'm-prototype',
          type: 'milestone',
          title: 'Prototype worn for seven days by three volunteers',
          content: 'Non-clinical wear test of comfort and battery life only, after the pathway review.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'amara',
          attributes: { owner: 'Amara Nwosu-Belling', target_date: day(45), status: 'planned' },
        },
        {
          key: 'f-bom',
          type: 'fact',
          title: 'Prototype bill of materials about $38 per pair at 100 units',
          content: 'The current prototype bill of materials is estimated at $38 per pair at a 100-unit run.',
          status: 'confirmed',
          visibility: 'team',
          confidence: 0.6,
          origin: 'founder',
          author: 'amara',
          attributes: { source: 'supplier quotes' },
        },
        {
          key: 'p-masters',
          type: 'preference',
          title: 'Considering a clinical master’s program in parallel',
          content:
            'Amara is weighing a part-time clinical master’s program and wants to keep the venture time-boxed.',
          status: 'confirmed',
          visibility: 'founder_private',
          confidence: 0.8,
          origin: 'founder',
          author: 'amara',
          attributes: {},
        },
        {
          key: 'i-reimbursement',
          type: 'insight',
          title: 'Reimbursement may matter more than device price',
          content:
            'Clinics may care more about whether monitoring time is reimbursable than about the insole’s price.',
          status: 'proposed',
          visibility: 'venture',
          confidence: 0.5,
          origin: 'ai',
          author: 'amara',
          attributes: {},
        },
        {
          key: 'rel-advisor-review',
          type: 'relationship',
          title: 'Advisor reviewed the clinic interview guide',
          content:
            'Graham reviewed the interview guide and suggested asking clinics about current follow-up intervals.',
          status: 'confirmed',
          visibility: 'advisors',
          confidence: 0.8,
          origin: 'founder',
          author: 'amara',
          attributes: { counterpart_role: 'advisor' },
        },
        {
          key: 'f-reference',
          type: 'fact',
          title: 'Workspace reference code',
          content: 'Internal reference for this workspace (do not share outside the venture):',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 1,
          origin: 'founder',
          author: 'amara',
          attributes: {},
          canary: true,
        },
      ],
      documents: [
        {
          key: 'doc-clinic-notes',
          filename: 'clinic-interview-summary.md',
          title: 'Clinic interview summary',
          uploadedBy: 'amara',
          canary: true,
          sections: [
            {
              heading: 'Participants',
              content:
                'Eight staff from four podiatry clinics: three podiatrists, three nurses and two practice managers. All interviews were about workflow; no patient information was collected.',
            },
            {
              heading: 'Workflow today',
              content:
                'Follow-ups for at-risk patients are typically quarterly. Staff rely on patients to report problems between visits, which often happens late.',
            },
            {
              heading: 'Concerns raised',
              content:
                'Two practice managers worried about another data feed and about who reviews alerts. Several asked whether monitoring time would be reimbursable.',
            },
          ],
        },
      ],
      escalation: {
        key: 'esc-pathway',
        category: 'medical_regulatory',
        priority: 'P2',
        createdBy: 'amara',
        consented: true,
        packet: {
          founderQuestion:
            'Does a pressure-sensing insole that alerts clinics count as a regulated medical device, and what evidence would we need?',
          desiredDecision: 'Whether to design the next prototype for a regulated pathway now',
          sharedFacts: [
            {
              memoryId: null,
              text: 'Concept: insole flags pressure hotspots between podiatry visits (synthetic venture).',
            },
          ],
          evidenceConsidered: [{ key: 'E1', title: 'Regulatory pathway not yet determined' }],
          conflictingSignals: [],
          unknowns: ['Device classification', 'Clinical evidence requirements', 'Reimbursement codes'],
          reason: 'Medical and regulatory determinations require a qualified human.',
          urgency: 'Before the next prototype design freeze',
          proposedNextStep: 'Pathway review with the clinical innovation pathway advisor',
          sessionSummary: null,
          aiGenerated: true,
        },
      },
    },
    {
      key: 'emberloop',
      name: 'EmberLoop',
      oneLiner: 'A retrofit heat-recovery module that cuts fuel use in small ceramic and glass studio kilns.',
      stage: 'commercialization',
      domain: 'energy',
      cohort: 'Spring cohort (synthetic)',
      currentGoal: 'Prove that studios will lease the module under a shared-savings model.',
      eir: 'eir-ruth',
      members: [
        { person: 'jonah', role: 'founder' },
        { person: 'ines', role: 'team' },
      ],
      memory: [
        {
          key: 'f-pilot-kiln',
          type: 'fact',
          title: 'Pilot studio fires about three times a week',
          content: 'The pilot studio’s gas kiln runs about three firings per week at roughly 1,200 °C.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.85,
          origin: 'founder',
          author: 'jonah',
          attributes: { source: 'studio firing log' },
        },
        {
          key: 'e-gas-reduction',
          type: 'evidence',
          title: '18% gas reduction over six pilot firings',
          content:
            'The studio gas meter showed an 18% reduction across six firings with the module installed, versus the prior month.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.65,
          origin: 'founder',
          author: 'ines',
          attributes: { source: 'studio gas meter', collected_on: day(-9), n: 6, strength: 'behaviour' },
          pinned: true,
        },
        {
          key: 'x-retrofit-pilot',
          type: 'experiment',
          title: 'Retrofit pilot in one studio',
          content:
            'Install the prototype module on one studio kiln and compare gas use against the previous month.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'jonah',
          attributes: {
            prediction: 'At least 15% fuel reduction per firing',
            method: 'Meter readings for six firings with the module versus the prior month',
            sample_size: 6,
            success_criteria: '15% or greater reduction',
            result: '18% reduction; one firing excluded for a door-seal fault',
            status: 'completed',
          },
        },
        {
          key: 'x-priced-quotes',
          type: 'experiment',
          title: 'Priced lease quotes to ten studios',
          content: 'Send shared-savings lease quotes to ten studios and track signed letters of intent.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'jonah',
          attributes: {
            prediction: 'Three of ten studios sign a letter of intent',
            method: 'Quote plus site visit offer',
            sample_size: 10,
            success_criteria: 'Three signed letters of intent in four weeks',
            result: null,
            status: 'running',
          },
        },
        {
          key: 'd-lease',
          type: 'decision',
          title: 'Lease the module under a shared-savings model',
          content:
            'Offer the module as a lease paid from a share of measured fuel savings rather than an upfront sale.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.6,
          origin: 'founder',
          author: 'jonah',
          attributes: {
            rationale: 'Studios cited upfront cost as the main barrier in site visits',
            alternatives: ['Upfront sale', 'Equipment financing partner'],
            reversal_condition: 'If fewer than two of ten studios accept a lease quote',
            decided_on: day(-7),
          },
        },
        {
          key: 'r-certification',
          type: 'risk',
          title: 'Retrofits may need safety certification',
          content:
            'Modifying a gas kiln may require safety certification or inspection before commercial installs.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.7,
          origin: 'founder',
          author: 'ines',
          attributes: {
            likelihood: 'medium',
            impact: 'high',
            mitigation: 'Ask a certification specialist before the next install',
          },
        },
        {
          key: 'a-fab-quotes',
          type: 'action',
          title: 'Get fabrication quotes for 20 units',
          content: 'Request quotes from two sheet-metal fabricators for a 20-unit run.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.9,
          origin: 'founder',
          author: 'ines',
          attributes: { owner: 'Ines Varga-Molloy', due: day(10), status: 'open' },
        },
        {
          key: 'm-ten-installs',
          type: 'milestone',
          title: 'Ten paid installs',
          content: 'Ten studios running the module under paid leases.',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 0.8,
          origin: 'founder',
          author: 'jonah',
          attributes: { owner: 'Jonah Castellane', target_date: day(90), status: 'planned' },
        },
        {
          key: 'h-self-finance',
          type: 'hypothesis',
          title: 'Studios will finance the module themselves',
          content: 'Small studios will pay for the module upfront from savings once they see pilot data.',
          status: 'disputed',
          visibility: 'venture',
          confidence: 0.3,
          origin: 'founder',
          author: 'jonah',
          attributes: {
            assumption_type: 'viability',
            riskiness: 'high',
            disputed_reason: 'Site visits cited upfront cost as the barrier',
          },
        },
        {
          key: 'i-service-radius',
          type: 'insight',
          title: 'Service radius limits early growth',
          content:
            'Installs and maintenance favour studios within a short drive until a partner installer network exists.',
          status: 'proposed',
          visibility: 'venture',
          confidence: 0.5,
          origin: 'ai',
          author: 'jonah',
          attributes: {},
        },
        {
          key: 'p-service-radius',
          type: 'preference',
          title: 'Prefer studios within a two-hour drive',
          content:
            'Ines prefers early partners within a two-hour drive so the team can service installs in person.',
          status: 'confirmed',
          visibility: 'team',
          confidence: 0.8,
          origin: 'founder',
          author: 'ines',
          attributes: {},
        },
        {
          key: 'f-reference',
          type: 'fact',
          title: 'Workspace reference code',
          content: 'Internal reference for this workspace (do not share outside the venture):',
          status: 'confirmed',
          visibility: 'venture',
          confidence: 1,
          origin: 'founder',
          author: 'jonah',
          attributes: {},
          canary: true,
        },
      ],
      documents: [
        {
          key: 'doc-pilot-report',
          filename: 'retrofit-pilot-report.md',
          title: 'Retrofit pilot report',
          uploadedBy: 'jonah',
          canary: true,
          sections: [
            {
              heading: 'Setup',
              content:
                'The prototype heat-recovery module was installed on one studio gas kiln. We compared six firings against the previous month using the studio gas meter.',
            },
            {
              heading: 'Results',
              content:
                'Gas use fell 18% per firing on average. One firing was excluded because a door-seal fault affected temperature. The studio reported no change to glaze results.',
            },
          ],
        },
        {
          key: 'doc-quote-pipeline',
          filename: 'studio-quote-pipeline.md',
          title: 'Studio quote pipeline',
          uploadedBy: 'ines',
          sections: [
            {
              heading: 'Pipeline',
              content:
                'Ten studios received shared-savings lease quotes. Four asked for site visits; two asked about safety inspection requirements; none have signed yet.',
            },
          ],
        },
      ],
    },
  ];
}
