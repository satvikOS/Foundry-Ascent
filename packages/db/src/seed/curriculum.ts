/**
 * The Ain Foundry curriculum (owner, 2026-11-08: "add the PDFs into RAG"), curated from the programme's own materials
 * at the repository root: `1.pdf` (the roadmap, an image), `2.pdf` (welcome) and `3.pdf`–`5.pdf` (module checklists);
 * reviewed in docs/upgrade/CLIENT-MATERIALS.md. Programme-scope notes of the Ain tenant, cited as programme guidance.
 *
 * - Asked for, not pushed: a curriculum passage is a candidate only when the founder's own message is about the
 *   programme (`retrievalRepo.asksAboutProgramme`, sources marked by {@link CURRICULUM_URI_PREFIX}); otherwise the
 *   coach's two shared slots stay with its own library and the programme handbook.
 * - What the materials say, in their words: no glosses of ours attributed to the programme; presenters' names are left
 *   out (a founder needs the topic, not who recorded it).
 * - Never the current requirement: every passage says the programme changes as it goes ("Live Response Design"), and
 *   the event counts say the materials disagree (the Module 1 outline asks for more than the checklist), so the coach
 *   points to Blackboard or the Mentorship Hub instead of presenting a checklist as what is due.
 */
import { CURRICULUM_URI_PREFIX } from '../repositories/retrieval.js';

export { CURRICULUM_URI_PREFIX };

export interface CurriculumSource {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  readonly chunks: readonly { readonly heading: string; readonly content: string }[];
}

const OWNER = 'Ain Center for Entrepreneurship and Innovation';
const CURRENT =
  'As of the programme materials (it changes as it goes, "Live Response Design"; confirm current requirements on ' +
  'Blackboard or the Mentorship Hub):';
const EVENTS =
  'Events: the Module 1 checklist lists one per unit and the Module 1 outline asks for at least three, so confirm ' +
  'the number for the current cohort.';

const EVENTS_LEAD = `${CURRENT} ${EVENTS}`;

/** The home tenant these notes belong to (`SeedConfig.homeTenant.slug`). */
export const CURRICULUM_TENANT_SLUG = 'ain';

interface DraftChunk {
  readonly heading: string;
  readonly content: string;
  /** Said first, so it survives the excerpt the coach reads (600 characters). */
  readonly lead?: string;
}

const DRAFT: readonly (Omit<CurriculumSource, 'chunks'> & { readonly chunks: readonly DraftChunk[] })[] = [
  {
    key: 'ain-curriculum-roadmap',
    title: 'Ain Foundry curriculum: roadmap',
    owner: OWNER,
    chunks: [
      {
        heading: 'Three modules, three capstones',
        content:
          'The Ain Foundry Roadmap (powered by Ain CFEI) starts with "Launching Your Personalized Foundry Program ' +
          'Series" and ends with "From Student to Mentor: Join the Foundry Alumni Network". In between are three ' +
          'modules, each with a capstone: Module 1, the Business Model Canvas; Module 2, The Perfect Pitch; Module 3, ' +
          `The Business Plan.`,
        lead: CURRENT,
      },
      {
        heading: 'What each module includes on the roadmap',
        content:
          'Module 1: Pick Your Journey, the Foundry Hub Mentorship Program, an Innovation Event, Entrepreneurial ' +
          'Mindset I and II, the Customer Discovery AI Validation Process and EIR Foundry Sessions. Module 2: the ' +
          'Foundry Hub Mentorship Program, an Innovation Event, Legal Structure and Customer Discovery, Value ' +
          'Proposition and Pitch, the Customer Discovery Validation Process: End User, and EIR Foundry Sessions. ' +
          'Module 3: the Foundry Hub Mentorship Program, an Innovation Event, Fundraising and Bootstrapping, ' +
          'Networking I and II, EIR Foundry Sessions, and Evaluation Opportunity: Innovation Incubators and VC ' +
          `Opportunities.`,
        lead: CURRENT,
      },
    ],
  },
  {
    key: 'ain-curriculum-module-1',
    title: 'Ain Foundry curriculum: Module 1 (mindset, customers and users, Business Model Canvas)',
    owner: OWNER,
    chunks: [
      {
        heading: 'What Module 1 covers',
        content:
          'Module 1 lays the groundwork: the entrepreneurial mindset, the way successful entrepreneurs think and act ' +
          'to turn ideas into reality; the distinction between customers and users, which helps you design products ' +
          'and services that meet the needs of your market; and the Business Model Canvas, which breaks a business ' +
          'into components such as the value proposition, customer segments and revenue streams.',
      },
      {
        heading: 'Module 1 checklist',
        content:
          'Unit 1, Introduction to Entrepreneurial Mindset: Entrepreneurial Mindset videos (Parts I and II), a quiz, ' +
          'the Foundry Mentor Journal, joining the Ain Foundry Mentorship Hub and an entrepreneurial event. Unit 2, ' +
          'Customers vs. Users, Business Model and Business Model Canvas: key-term videos on customer versus user, ' +
          'the business model and the Business Model Canvas, a quiz, the Foundry Mentor Journal and an ' +
          `entrepreneurial event. Capstone: submit a Business Model Canvas.`,
        lead: EVENTS_LEAD,
      },
    ],
  },
  {
    key: 'ain-curriculum-module-2',
    title:
      'Ain Foundry curriculum: Module 2 (legal structure, customer discovery, value proposition, the pitch)',
    owner: OWNER,
    chunks: [
      {
        heading: 'What Module 2 covers',
        content:
          'Module 2 covers what turns an idea into a sustainable business. Legal structure: the types of business ' +
          'entity, such as sole proprietorships, LLCs and corporations, and how to choose one for your goals. ' +
          'Customer discovery: engaging directly with potential customers to understand their needs, validate ' +
          'assumptions and refine the idea. Value proposition: what makes the offering unique and why it matters to ' +
          'customers. The pitch: communicating the idea clearly and confidently to investors, partners or anyone who ' +
          'might help.',
      },
      {
        heading: 'Module 2 checklist',
        content:
          'Unit 1, Legal Structure and Customer Discovery: key-term videos on legal structure and customer ' +
          'discovery, a quiz, the Foundry Mentor Journal and joining Slack. Unit 2, Value Proposition and The Pitch: ' +
          'key-term videos, a quiz, the Foundry Mentor Journal and an entrepreneurship event. Capstone: submit the ' +
          `pitch (The Perfect Pitch on the roadmap).`,
        lead: CURRENT,
      },
    ],
  },
  {
    key: 'ain-curriculum-module-3',
    title: 'Ain Foundry curriculum: Module 3 (fundraising, bootstrapping, networking)',
    owner: OWNER,
    chunks: [
      {
        heading: 'What Module 3 covers',
        content:
          'Module 3 covers fundraising, bootstrapping and networking. Fundraising: raising capital, from venture ' +
          'capital and angel investors to crowdfunding and government grants, the pros and cons of each, and a pitch ' +
          'that attracts investors. Bootstrapping: relying on your own resources to fund the business in its early ' +
          'stages, its benefits and challenges, and whether it is right for you. Networking: building relationships ' +
          'with mentors, peers and industry professionals, and using them to open new opportunities.',
      },
      {
        heading: 'Module 3 checklist',
        content:
          'Unit 1, Fundraising and Bootstrapping: key-term videos on fundraising and bootstrapping, a quiz, the ' +
          'Foundry Mentor Journal and working with a mentor on the Ain Foundry Mentorship Hub. Unit 2, Networking I ' +
          'and II: two networking videos, a quiz, the Foundry Mentor Journal and an entrepreneurship event. ' +
          'Capstone: submit the business plan (The Business Plan on the roadmap; the checklist also names an ' +
          `evaluation of the business opportunity).`,
        lead: CURRENT,
      },
    ],
  },
];

export const AIN_CURRICULUM: readonly CurriculumSource[] = DRAFT.map((source) => ({
  ...source,
  chunks: source.chunks.map(({ heading, content, lead }) => ({
    heading,
    content: lead === undefined ? content : `${lead} ${content}`,
  })),
}));
