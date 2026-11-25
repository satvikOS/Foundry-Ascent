import type { PlaybookStage } from '../types.js';

/** The seven stages, in order, in a student's words. */
export const STAGES: readonly PlaybookStage[] = [
  {
    stage: 'idea',
    title: 'Pin down the idea',
    goal: 'Say in one page who has the problem, what they do about it today, and what could sink the idea.',
  },
  {
    stage: 'discovery',
    title: 'Talk to customers',
    goal: 'Hear the same problem from people who have it, and choose the one group to serve first.',
  },
  {
    stage: 'validation',
    title: 'Prove someone wants it',
    goal: 'Run a small test with a pass line set in advance, and get strangers to commit money, time or a signature.',
  },
  {
    stage: 'business_model',
    title: 'Make the numbers work',
    goal: 'Show how the venture gets paid, that one sale leaves money over, and what it costs to get going.',
  },
  {
    stage: 'commercialization',
    title: 'Win first customers',
    goal: 'Sell to ten customers who are not friends, find the one channel that works, and tell the story well.',
  },
  {
    stage: 'growth',
    title: 'Grow what works',
    goal: 'Show that customers come back and that new ones arrive without you doing everything by hand.',
  },
  {
    stage: 'transition',
    title: 'Leave the Ain Center',
    goal: 'Choose the next home for the venture and hand over with proof, a plan and the right people.',
  },
];
