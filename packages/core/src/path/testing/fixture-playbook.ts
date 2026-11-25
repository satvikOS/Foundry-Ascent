import type { Play } from '@foundry/contracts';

import { type Playbook } from '../types.js';

/** A small playbook with every shape the engine reads (tests): three stages, a referral, plays without a criterion. */
function play(p: Pick<Play, 'id' | 'title' | 'stage' | 'answer'> & Partial<Play>): Play {
  return {
    intents: [],
    criteria: [],
    why: 'What people did last time tells you more than what they say they will do.',
    steps: [
      { do: 'List the people you can reach this week', how: 'Names, not groups.', minutes: 20 },
      { do: 'Do the first one today', how: 'Start with the easiest.', minutes: 30 },
    ],
    doneWhen: 'It is written down and dated.',
    days: 5,
    template: null,
    traps: ['Asking friends only.'],
    referral: null,
    citations: [{ sourceId: 'mom-test', locator: 'Chapter 1' }],
    next: [],
    ...p,
  };
}

export const FIXTURE_PLAYBOOK: Playbook = {
  version: 'fixture-1',
  stages: [
    { stage: 'idea', title: 'Pin down the idea', goal: 'Say who has the problem and what they do today.' },
    {
      stage: 'discovery',
      title: 'Talk to customers',
      goal: 'Hear the same problem from people who have it.',
    },
    { stage: 'validation', title: 'Prove someone wants it', goal: 'Get strangers to commit something.' },
    {
      stage: 'business_model',
      title: 'Make the numbers work',
      goal: 'Show that one sale leaves money over.',
    },
    { stage: 'commercialization', title: 'Win first customers', goal: 'Sell to people who are not friends.' },
    { stage: 'growth', title: 'Grow what works', goal: 'Show that customers come back.' },
    { stage: 'transition', title: 'Leave the center', goal: 'Choose the next home.' },
  ],
  criteria: [
    {
      id: 'idea-page',
      stage: 'idea',
      title: 'The idea is on one page',
      evidence: 'Five lines are written: who, problem, today, idea, why you.',
      playId: 'idea-on-a-page',
    },
    {
      id: 'idea-risk',
      stage: 'idea',
      title: 'The biggest risk is named',
      evidence: 'One sentence says what must be true.',
      playId: 'name-the-risk',
    },
    {
      id: 'discovery-interviews',
      stage: 'discovery',
      title: 'Ten interviews about the last time it happened',
      evidence: 'Notes from 10 interviews with people who have the problem.',
      playId: 'ten-interviews',
    },
    {
      id: 'discovery-segment',
      stage: 'discovery',
      title: 'One customer segment is chosen',
      evidence: 'One group is named with the reason.',
      playId: 'choose-segment',
    },
    {
      id: 'validation-test',
      stage: 'validation',
      title: 'An experiment with a pass line has run',
      evidence: 'The result is next to the pass line.',
      playId: 'run-a-test',
    },
    {
      id: 'validation-customers',
      stage: 'validation',
      title: 'First paying customers',
      evidence: 'At least 2 pilots are signed and paid.',
      playId: 'signed-pilots',
    },
    {
      id: 'model-unit',
      stage: 'business_model',
      title: 'Unit economics of one sale',
      evidence: 'A one-sale table with your own numbers.',
      playId: 'unit-economics',
    },
    {
      id: 'sales-channel',
      stage: 'commercialization',
      title: 'One sales channel is ahead',
      evidence: 'Three channels tried and one chosen.',
      playId: 'channel-choice',
    },
  ],
  plays: [
    play({
      id: 'idea-on-a-page',
      title: 'Put the idea on one page',
      stage: 'idea',
      answer:
        'Write five lines before anything else: who, the problem, what they do today, your idea and why you.',
      criteria: ['idea-page'],
      doneWhen: 'Five lines are on one page and one other person has read them.',
      days: 2,
      next: ['name-the-risk'],
    }),
    play({
      id: 'name-the-risk',
      title: 'Name the thing most likely to sink it',
      stage: 'idea',
      answer:
        'The biggest risk is usually that nobody does this today; write the one sentence that must be true.',
      criteria: ['idea-risk'],
      days: 2,
    }),
    play({
      id: 'ten-interviews',
      title: 'Interview ten people about the last time',
      stage: 'discovery',
      answer:
        'Ask ten people to walk you through the last time it happened; never pitch and never ask "would you".',
      criteria: ['discovery-interviews'],
      doneWhen: 'Notes from 10 interviews, each about the last time.',
      days: 7,
      template: { title: 'Interview script', body: 'Tell me about the last time…' },
      next: ['choose-segment'],
    }),
    play({
      id: 'choose-segment',
      title: 'Choose one customer segment',
      stage: 'discovery',
      answer: 'Pick the group that already pays something to live with the problem, and make the rest wait.',
      criteria: ['discovery-segment'],
    }),
    play({
      id: 'run-a-test',
      title: 'Run one test with a pass line',
      stage: 'validation',
      answer:
        'Write the number that would change your mind before you run the test, then run the smallest one.',
      criteria: ['validation-test'],
      days: 10,
    }),
    play({
      id: 'signed-pilots',
      title: 'Sign two paid pilots',
      stage: 'validation',
      answer:
        'Offer a small paid pilot with a start date; a signature tells you more than any amount of praise.',
      criteria: ['validation-customers'],
      doneWhen: 'Two pilots are signed and the first invoice is sent.',
      days: 14,
    }),
    play({
      id: 'unit-economics',
      title: 'Work out one sale',
      stage: 'business_model',
      answer: 'Take one sale: the price, what it costs to serve, what it cost to win, and what is left over.',
      criteria: ['model-unit'],
    }),
    play({
      id: 'channel-choice',
      title: 'Try three sales channels',
      stage: 'commercialization',
      answer:
        'Try three channels for a week each and keep the one with the most customers for each hour spent.',
      criteria: ['sales-channel'],
    }),
    play({
      id: 'price-it',
      title: 'Set a first price',
      stage: 'validation',
      answer:
        'Start from what the problem costs them today and charge a fraction of it; offer it, do not survey it.',
      days: 3,
    }),
    play({
      id: 'service-or-product',
      title: 'Choose between service and product',
      stage: 'idea',
      answer:
        'Start as a service: you learn what people pay for while they pay you; turn the repeated part into product.',
    }),
    play({
      id: 'who-owns-it',
      title: 'Find out who owns it',
      stage: 'idea',
      answer:
        'Do not guess who owns work done in a university lab: the technology transfer office decides, early.',
      referral: {
        category: 'ip_licensing',
        role: 'specialist',
        who: 'The technology transfer office',
        bring: 'A one-page description, the dates and who funded the lab.',
      },
    }),
    play({
      id: 'conflict-help',
      title: 'Get help with a conflict',
      stage: 'idea',
      answer:
        'A serious conflict in the team is for a person to help with; write down what happened and when, first.',
      referral: {
        category: 'conflict_harassment',
        role: 'program_lead',
        who: 'The program lead',
        bring: 'What happened, when, and what you want to happen next.',
      },
    }),
  ],
  intents: [
    {
      id: 'idea-page',
      playId: 'idea-on-a-page',
      phrases: ['write down my idea', 'describe my idea', 'idea on a page'],
    },
    {
      id: 'interviews',
      playId: 'ten-interviews',
      phrases: [
        'talk to customers',
        'customer interviews',
        'interview questions',
        'what do I ask ... customers',
      ],
    },
    {
      id: 'segment',
      playId: 'choose-segment',
      phrases: ['which customer', 'who should I sell to', 'target customer', 'customer segment'],
    },
    {
      id: 'test',
      playId: 'run-a-test',
      phrases: ['test my idea', 'run an experiment', 'validate my idea', 'know if people want it'],
    },
    {
      id: 'pricing',
      playId: 'price-it',
      phrases: [
        'what should I charge',
        'how much should I charge',
        'set a price',
        'price my product',
        'pricing',
      ],
      unless: ['ticket', 'conference'],
    },
    {
      id: 'pilots',
      playId: 'signed-pilots',
      phrases: ['paid pilot', 'get my first customers', 'sign a pilot'],
    },
    {
      id: 'service-or-product',
      playId: 'service-or-product',
      phrases: ['service business', 'service or product', 'consulting or'],
    },
    {
      id: 'unit',
      playId: 'unit-economics',
      phrases: ['unit economics', 'profit per sale', 'make money on each sale'],
    },
    {
      id: 'channels',
      playId: 'channel-choice',
      phrases: ['sales channel', 'which channel', 'where do I find buyers'],
    },
    {
      id: 'ownership',
      playId: 'who-owns-it',
      phrases: ['who owns', 'university lab ... own', 'own the idea'],
      referral: true,
    },
    { id: 'conflict', playId: 'conflict-help', phrases: ['fight with my cofounder'], referral: true },
  ],
  sources: [
    {
      id: 'mom-test',
      kind: 'book',
      title: 'The Mom Test',
      authors: 'Rob Fitzpatrick',
      year: 2013,
      url: 'https://www.momtestbook.com/',
    },
  ],
};
