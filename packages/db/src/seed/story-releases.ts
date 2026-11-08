/**
 * Demo-story releases the platform owner approved: a seeded founder's whole backstory replaced in a database that
 * already holds the old one. The seed never rewrites what it inserted (ON CONFLICT DO NOTHING), so a changed story in
 * ./ventures.ts would never reach production; a story release does it once instead, on the deploy whose seed
 * configuration names it (the same list as the persona releases: `SEED_OWNER_RELEASES`, production's
 * infra/cdk/config/production.json → `homeTenant.ownerReleases`; ./owner-releases.ts).
 *
 * - A new venture, not an edit: the founder gets a new seeded venture (memory, a document, a notebook), coached by the
 *   release's vEIR, and leaves the ventures the release names. Nothing is deleted: the old venture keeps its
 *   conversations, recordings and memory, so the vEIR, which reads only the venture a conversation is in, never
 *   brings the old story back, and restoring the membership undoes it.
 * - Idempotent: applied only while the new venture's deterministic id is absent; a later change made in the product
 *   (a deleted memory item, a renamed venture, a restored membership) is never undone by a redeploy.
 * - Fresh databases (tests, `pnpm db:reset` without production's list) keep ./ventures.ts as it is.
 *
 * Content is synthetic and generic (ADR-0006): no real person, venture or program.
 */
import { type SeedVenture } from './ventures.js';

export interface StoryRelease {
  /** The key `SEED_OWNER_RELEASES` names. */
  readonly key: string;
  /** The day the owner asked for it (ISO date). */
  readonly approvedOn: string;
  /** Seed key of the founder whose story this is (`SEED_FOUNDERS[].key`). */
  readonly founder: string;
  /** Seeded ventures the founder leaves (their memberships are revoked, nothing else changes). */
  readonly leaves: readonly string[];
  /** New titles of seeded people, by seed key. */
  readonly titles: Readonly<Record<string, string>>;
  /** The new venture; `day(n)` renders the deploy day + n days as YYYY-MM-DD. Its `eir` names the coaching vEIR. */
  readonly venture: (day: (offsetDays: number) => string) => SeedVenture;
}

/**
 * Seam Again (owner, 2026-11-08): Amara's podiatry insole (SoleSignal) made every test conversation about medical
 * device regulation, which nobody testing the product can judge. Her story is now a simple campus business anyone can
 * picture and check: a weekly clothes-repair pop-up, with a first day's real numbers, a pricing question, an overdue
 * commitment and two open next steps, so memory, follow-ups, teaching and the reference library are easy to see.
 */
export const SEAM_AGAIN_RELEASE: StoryRelease = {
  key: 'amara-seam-again-2026-11-08',
  approvedOn: '2026-11-08',
  founder: 'amara',
  leaves: ['solesignal'],
  titles: { amara: 'Founder, Seam Again (synthetic)', graham: 'Advisor (synthetic)' },
  venture: (day) => ({
    key: 'seamagain',
    name: 'Seam Again',
    oneLiner:
      'A weekly campus pop-up where students drop off clothes with a small rip or a missing button in the morning ' +
      'and pick them up fixed the same evening.',
    stage: 'validation',
    domain: 'consumer',
    cohort: 'Spring cohort (synthetic)',
    currentGoal:
      'Find out whether a weekly repair stand can pay its two sewers at least the campus job rate.',
    eir: 'eir-corin',
    members: [
      { person: 'amara', role: 'founder' },
      { person: 'graham', role: 'advisor' },
    ],
    memory: [
      {
        key: 'h-same-day-fix',
        type: 'hypothesis',
        title: 'Students will pay $4–8 for a same-day fix of clothes they stopped wearing',
        content:
          'Students keep clothes they no longer wear because of a small rip, a loose seam or a missing button, and ' +
          'will pay $4–8 to have them fixed on campus the same day.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.55,
        origin: 'founder',
        author: 'amara',
        attributes: { assumption_type: 'desirability', riskiness: 'high' },
        pinned: true,
      },
      {
        key: 'e-student-interviews',
        type: 'evidence',
        title: '15 interviews with students about damaged clothes',
        content:
          'Eleven of fifteen students had at least one item they had stopped wearing because of a small rip or a ' +
          'missing button; seven said they would pay $5–8 for a same-day fix; only two own a sewing kit. The ' +
          'nearest tailor is off campus, charges at least $15 and takes about a week.',
        status: 'confirmed',
        visibility: 'advisors',
        confidence: 0.7,
        origin: 'founder',
        author: 'amara',
        attributes: { source: 'interview notes', collected_on: day(-20), n: 15, strength: 'statement' },
      },
      {
        key: 'x-first-popup',
        type: 'experiment',
        title: 'First pop-up day in the student union',
        content:
          'One Wednesday table in the student union lobby: drop-off 11:00–15:00, pick-up by 18:00, priced per ' +
          'repair (button $4, seam $6, hem $8). Amara and her flatmate Jun did the sewing.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.75,
        origin: 'founder',
        author: 'amara',
        attributes: {
          prediction: 'At least 15 items dropped off and fixed the same day',
          method: 'One staffed table, a borrowed sewing machine, a paper ticket per item',
          sample_size: 23,
          success_criteria: '15 or more items fixed and collected the same day',
          result:
            '23 items dropped off; 21 fixed and collected the same day (9 seams, 8 buttons, 4 hems); 2 zip repairs ' +
            'handed back unfinished; $118 taken; about 14 minutes per repair on average.',
          status: 'completed',
        },
      },
      {
        key: 'd-scope',
        type: 'decision',
        title: 'Buttons, seams and hems only: no zips, leather or alterations',
        content:
          'Offer only the three quick repairs; turn away zips, leather and alterations, which took over 40 minutes ' +
          'each on the first day.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.7,
        origin: 'founder',
        author: 'amara',
        attributes: {
          rationale: 'The two zip jobs took more time than six buttons and were still not finished',
          alternatives: ['Charge $15+ for zips', 'Take zips home and return them next week'],
          reversal_condition: 'If zip requests become a large share of drop-offs',
          decided_on: day(-5),
        },
      },
      {
        key: 'r-hourly-pay',
        type: 'risk',
        title: 'The stand may pay less than the campus job rate',
        content:
          'The first day took $118 for two people staffing about five hours each, about $11.80 an hour per person ' +
          'before supplies, against the $16 an hour a campus job pays.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.75,
        origin: 'founder',
        author: 'amara',
        attributes: {
          likelihood: 'high',
          impact: 'high',
          mitigation:
            'Price by minutes per repair type; test a $10 hem; look for groups that bring many items at once',
        },
      },
      {
        key: 'a-hem-price-test',
        type: 'action',
        title: 'Test a $10 hem price with five people from the waitlist',
        content:
          'Offer five people from the pop-up waitlist a hem at $10 instead of $8 and note who says yes.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.9,
        origin: 'founder',
        author: 'amara',
        attributes: { owner: 'Amara Nwosu-Belling', due: day(-2), status: 'open' },
      },
      {
        key: 'a-book-table',
        type: 'action',
        title: 'Book the student union table for the next four Wednesdays',
        content:
          'Ask the student union events office whether the same lobby table can be booked four weeks in a row.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.9,
        origin: 'founder',
        author: 'amara',
        attributes: { owner: 'Amara Nwosu-Belling', due: day(5), status: 'open' },
      },
      {
        key: 'a-theatre-email',
        type: 'action',
        title: 'Email the theatre society’s costume manager',
        content:
          'Ask whether the theatre society would book a repair session before its next show, paid as one batch.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.9,
        origin: 'founder',
        author: 'amara',
        attributes: { owner: 'Amara Nwosu-Belling', due: day(3), status: 'open' },
      },
      {
        key: 'm-four-wednesdays',
        type: 'milestone',
        title: 'Four Wednesday pop-ups in a row, 80 repairs in total',
        content: 'Run the stand four Wednesdays in a row and reach 80 completed repairs.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.7,
        origin: 'founder',
        author: 'amara',
        attributes: { owner: 'Amara Nwosu-Belling', target_date: day(30), status: 'planned' },
      },
      {
        key: 'f-supplies',
        type: 'fact',
        title: 'Supplies cost $42; the sewing machine is borrowed',
        content:
          'Thread, buttons, needles and hem tape for the first day cost $42 and should last about three more pop-ups. ' +
          'The sewing machine is borrowed from the campus makerspace after its safety induction.',
        status: 'confirmed',
        visibility: 'team',
        confidence: 0.8,
        origin: 'founder',
        author: 'amara',
        attributes: { source: 'receipts' },
      },
      {
        key: 'f-waitlist',
        type: 'fact',
        title: '31 people joined the waitlist on the first day',
        content:
          'Thirty-one people left an email address to hear about the next pop-up; four asked about hemming.',
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.85,
        origin: 'founder',
        author: 'amara',
        attributes: { source: 'sign-up sheet' },
      },
      {
        key: 'p-one-day',
        type: 'preference',
        title: 'Keeping the venture to one day a week',
        content:
          'Amara wants to keep Seam Again to one weekday during term so it does not eat into exam preparation; Jun ' +
          'can only sew on Wednesdays.',
        status: 'confirmed',
        visibility: 'founder_private',
        confidence: 0.8,
        origin: 'founder',
        author: 'amara',
        attributes: {},
      },
      {
        key: 'i-group-customers',
        type: 'insight',
        title: 'Groups may matter more than single students',
        content:
          'Clubs that wear kit or costumes, such as the theatre society or sports teams, could bring many repairs at ' +
          'once, which would make each hour at the table pay more than single drop-offs do.',
        status: 'proposed',
        visibility: 'venture',
        confidence: 0.5,
        origin: 'ai',
        author: 'amara',
        attributes: {},
      },
      {
        key: 'rel-advisor-timing',
        type: 'relationship',
        title: 'Graham suggested timing every repair type',
        content:
          'Graham suggested writing down the minutes each repair takes, by type, and setting prices from those ' +
          'minutes rather than from what feels fair.',
        status: 'confirmed',
        visibility: 'advisors',
        confidence: 0.8,
        origin: 'founder',
        author: 'amara',
        attributes: { counterpart_role: 'advisor' },
      },
    ],
    documents: [
      {
        key: 'doc-popup-log',
        filename: 'first-popup-day-log.md',
        title: 'First pop-up day log',
        uploadedBy: 'amara',
        sections: [
          {
            heading: 'What came in',
            content:
              '23 items in four hours: 9 loose or split seams, 8 missing buttons, 4 hems and 2 broken zips. Most ' +
              'were jackets, shirts and trousers that people said they had stopped wearing.',
          },
          {
            heading: 'Timing and money',
            content:
              'Buttons took about 6 minutes, seams about 15 and hems about 25; the two zips took over 40 minutes ' +
              'each and went back unfinished. 21 repairs earned $118 (8 buttons at $4, 9 seams at $6, 4 hems at $8). ' +
              'Supplies cost $42.',
          },
          {
            heading: 'What people said',
            content:
              'Several people said they had kept an item with a missing button for months. Three asked whether the ' +
              'stand would be there every week. One person asked for a dress hem before a formal that Friday. 31 ' +
              'people joined the waitlist.',
          },
          {
            heading: 'Next time',
            content:
              'Turn away zips; put the prices and the pick-up time on the sign; write down the minutes for every ' +
              'repair; ask the events office about a regular Wednesday booking.',
          },
        ],
      },
    ],
  }),
};

export const STORY_RELEASES: readonly StoryRelease[] = [SEAM_AGAIN_RELEASE];

export type StoryReleaseOutcome = 'applied' | 'present' | 'no_demo_data' | 'no_owner' | 'no_persona';

export interface StoryReleaseResult {
  readonly key: string;
  readonly outcome: StoryReleaseOutcome;
  /** The new venture's id (deterministic), whatever the outcome. */
  readonly ventureId: string;
  /** Memberships the founder left on this run. */
  readonly left: number;
}
