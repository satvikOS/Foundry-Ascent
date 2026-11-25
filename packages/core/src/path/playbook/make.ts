import type { Play, PlayCitation, PlayStep } from '@foundry/contracts';

/** A citation of a source of the reading list (`sources.ts`). */
export const cite = (sourceId: string, locator: string | null = null): PlayCitation => ({
  sourceId,
  locator,
});

/** A citation of the programme's own videos, by module and unit. */
export const ain = (unit: string): PlayCitation => cite('ain-foundry', unit);

/** The programme's units, as a citation names them. */
export const AIN = {
  mindset1: 'Module 1, Unit 1: Entrepreneurial Mindset, Part I',
  mindset2: 'Module 1, Unit 1: Entrepreneurial Mindset, Part II',
  customerUser: 'Module 1, Unit 2: Customer vs. User',
  businessModel: 'Module 1, Unit 2: Business Model',
  canvas: 'Module 1, Unit 2: Business Model Canvas',
  legalStructure: 'Module 2, Unit 1: Legal Structure',
  discovery: 'Module 2, Unit 1: Customer Discovery',
  pitch: 'Module 2, Unit 2: The Pitch',
  fundraising: 'Module 3, Unit 1: Fundraising',
  bootstrapping: 'Module 3, Unit 1: Bootstrapping',
  networking1: 'Module 3, Unit 2: Networking I',
  networking2: 'Module 3, Unit 2: Networking II',
} as const;

/** One step: what to do, how, and how long it takes. */
export const step = (todo: string, how: string, minutes: number): PlayStep => ({ do: todo, how, minutes });

/** Who must decide, when it is not the founder and not the coach. */
export const REFERRALS = {
  urVentures: (bring: string): Play['referral'] => ({
    category: 'ip_licensing',
    role: 'specialist',
    who: 'UR Ventures, the University of Rochester technology transfer office',
    bring,
  }),
  lawyer: (bring: string): Play['referral'] => ({
    category: 'legal',
    role: 'specialist',
    who: 'A business lawyer; ask the Ain Center program lead for a legal referral',
    bring,
  }),
  accountant: (bring: string): Play['referral'] => ({
    category: 'legal',
    role: 'specialist',
    who: 'An accountant, with a business lawyer; ask the Ain Center program lead for a referral',
    bring,
  }),
  securities: (bring: string): Play['referral'] => ({
    category: 'securities_investment',
    role: 'specialist',
    who: 'A startup lawyer who handles securities, before you talk terms; start with your Ain Center EIR',
    bring,
  }),
  regulatory: (bring: string): Play['referral'] => ({
    category: 'medical_regulatory',
    role: 'specialist',
    who: 'A regulatory specialist, with UR Ventures for the invention; your EIR can make the introduction',
    bring,
  }),
  international: (bring: string): Play['referral'] => ({
    category: 'legal',
    role: 'university_support',
    who: 'The University of Rochester International Services Office (ISO), before any work starts',
    bring,
  }),
  eir: (bring: string): Play['referral'] => ({
    category: 'expert_judgment',
    role: 'eir',
    who: 'Your Entrepreneur in Residence (EIR) at the Ain Center',
    bring,
  }),
  programLead: (bring: string): Play['referral'] => ({
    category: 'expert_judgment',
    role: 'program_lead',
    who: 'The Ain Center program lead',
    bring,
  }),
} as const;
