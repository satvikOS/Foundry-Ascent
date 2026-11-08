/**
 * The Ain Foundry curriculum (owner, 2026-11-08: "add the PDFs into RAG"), curated from the programme's own materials
 * at the repository root: `1.pdf` (roadmap), `2.pdf` (welcome) and `3.pdf`–`5.pdf` (module checklists); reviewed in
 * docs/upgrade/CLIENT-MATERIALS.md. Programme-scope notes of the Ain tenant, retrieved like the programme handbook
 * (vector and keyword search, `program` weight) and cited as programme guidance.
 *
 * - Curated, not copied: the modules, their topics, activities and capstones; presenters' names are left out (a
 *   founder needs the topic, not who recorded it).
 * - No dates, counts or completion rules beyond what the checklists say, and every note says the programme adapts as
 *   it goes ("Live Response Design"), so the coach never presents a checklist as the current requirement
 *   (packages/ai prompts: coursework shows learning, not customer commitment).
 */
export interface CurriculumSource {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  readonly chunks: readonly { readonly heading: string; readonly content: string }[];
}

const OWNER = 'Ain Center for Entrepreneurship and Innovation';
const CURRENT =
  'The programme follows a "Live Response Design" approach and changes as it goes: check Blackboard or the ' +
  'Mentorship Hub for what is required in the current cohort.';

/** The home tenant these notes belong to (`SeedConfig.homeTenant.slug`). */
export const CURRICULUM_TENANT_SLUG = 'ain';

export const AIN_CURRICULUM: readonly CurriculumSource[] = [
  {
    key: 'ain-curriculum-roadmap',
    title: 'Ain Foundry curriculum: roadmap',
    owner: OWNER,
    chunks: [
      {
        heading: 'Three modules, three capstones',
        content:
          'The Ain Foundry series has three modules, each ending in a capstone. Module 1 (entrepreneurial mindset, ' +
          'customers versus users, the business model and the Business Model Canvas) ends with submitting a ' +
          'Business Model Canvas. Module 2 (legal structure, customer discovery, value proposition and the pitch) ' +
          'ends with submitting the pitch. Module 3 (fundraising, bootstrapping and networking) ends with submitting ' +
          'a business plan, with an evaluation of the business opportunity.',
      },
      {
        heading: 'How each module runs',
        content:
          'Each unit has short key-term videos, a quiz and an entry in the Foundry Mentor Journal, and students join ' +
          'entrepreneurship events during each module. Students also join the Ain Foundry Mentorship Hub and work ' +
          `with a mentor there. ${CURRENT}`,
      },
      {
        heading: 'Students shape the programme',
        content:
          'The Ain Center for Entrepreneurship and Innovation runs the series like a startup: it invites students, ' +
          'mentors and alumni to do customer discovery on the programme itself and to share feedback and ideas.',
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
          'Module 1 lays the groundwork: the entrepreneurial mindset (how entrepreneurs think and act to turn ideas ' +
          'into reality); the difference between customers and users (the customer chooses and pays, the user uses ' +
          'it, and they are not always the same person), which shapes what you build and who you sell to; and the ' +
          'Business Model Canvas, which lays out a business in parts such as the value proposition, customer ' +
          'segments and revenue streams.',
      },
      {
        heading: 'Module 1 activities',
        content:
          'Unit 1, Entrepreneurial Mindset: two mindset videos, a quiz, a Foundry Mentor Journal entry, joining the ' +
          'Ain Foundry Mentorship Hub and at least one entrepreneurial event. Unit 2, Customers vs. Users, Business ' +
          'Model and Business Model Canvas: three key-term videos (customer versus user, business model, Business ' +
          'Model Canvas), a quiz, a Foundry Mentor Journal entry and one entrepreneurial event.',
      },
      {
        heading: 'Module 1 capstone',
        content:
          'Submit a Business Model Canvas. A completed canvas lays out the assumptions to test; it does not show ' +
          `that customers want the product. ${CURRENT}`,
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
          'Module 2 turns an idea into a business. Legal structure: the main types of business entity, such as sole ' +
          'proprietorships, LLCs and corporations, and how to choose one, a choice that affects personal liability ' +
          'and later growth (the programme gives orientation, not legal advice). Customer discovery: talking ' +
          'directly with potential customers to understand their needs, test assumptions and refine the idea. Value ' +
          'proposition: what makes the offering unique and why it matters to customers. The pitch: communicating the ' +
          'idea clearly and confidently to investors, partners or anyone who could help.',
      },
      {
        heading: 'Module 2 activities',
        content:
          'Unit 1, Legal Structure and Customer Discovery: key-term videos on legal structure and customer ' +
          'discovery, a quiz, a Foundry Mentor Journal entry and joining the programme Slack. Unit 2, Value ' +
          'Proposition and The Pitch: key-term videos, a quiz, a Foundry Mentor Journal entry and one ' +
          'entrepreneurship event.',
      },
      {
        heading: 'Module 2 capstone',
        content: `Submit the pitch. ${CURRENT}`,
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
          'Module 3 is about funding and relationships. Fundraising: ways to raise capital, from venture capital and ' +
          'angel investors to crowdfunding and government grants, the pros and cons of each, and pitching to ' +
          'investors. Bootstrapping: funding the business from your own resources in its early stages, its benefits ' +
          'and challenges, and whether it suits you. Networking: building relationships with mentors, peers and ' +
          'industry professionals, and using them to open new opportunities.',
      },
      {
        heading: 'Module 3 activities',
        content:
          'Unit 1, Fundraising and Bootstrapping: key-term videos on fundraising and bootstrapping, a quiz, a ' +
          'Foundry Mentor Journal entry and work with a mentor on the Ain Foundry Mentorship Hub. Unit 2, Networking ' +
          'I and II: two networking videos, a quiz, a Foundry Mentor Journal entry and one entrepreneurship event.',
      },
      {
        heading: 'Module 3 capstone',
        content: `Submit a business plan, with an evaluation of the business opportunity. ${CURRENT}`,
      },
    ],
  },
];
