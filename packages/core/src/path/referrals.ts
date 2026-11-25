import { type RiskCategory } from '@foundry/contracts';

import { type PathIntent, type Playbook } from './types.js';
import { plain } from './words.js';

/**
 * Which play a risk the classifier found leads to when no phrase of the playbook names the ask: the person who decides,
 * and what to bring. The first of the list whose words the message has, else the last. Ids are the playbook's plays.
 */
const PLAYS: Readonly<
  Partial<Record<RiskCategory, readonly (readonly [play: string, words: RegExp | null])[]>>
> = {
  cross_venture_request: [['other-teams-privacy', null]],
  ip_licensing: [
    [
      'patent-now-or-wait',
      /\b(?:patent\w*|provisional|disclos\w+|publish\w*|poster|conference|prior art|trade secret)\b/,
    ],
    ['student-ip', null],
  ],
  securities_investment: [
    ['term-sheet', /\b(?:term sheet|safe|convertible|note|liquidation|board seat|side letter)\b/],
    [
      'friends-family-money',
      /\b(?:uncle|aunt|parents?|mom|mother|dad|father|family|relative|cousin|friends?|crowdfund\w*)\b/,
    ],
    ['valuation', null],
  ],
  medical_regulatory: [
    ['regulated-data', /\b(?:hipaa|patient (?:data|records?|information)|health (?:data|records?)|irb)\b/],
    ['medical-rules', null],
  ],
  legal: [
    ['international-student', /\b(?:visa|immigration|f-?1|j-?1|opt|cpt|green card|work authori[sz]ation)\b/],
    ['equity-split', /\b(?:equity|shares?|vest\w*|split)\b/],
    ['taxes', /\b(?:tax(?:es)?|irs|ein|deduct\w*)\b/],
    ['regulated-data', /\b(?:privacy|gdpr|ferpa|personal data|user data|data protection)\b/],
    ['permits-food', /\b(?:permits?|health department|food|alcohol|campus sales)\b/],
    [
      'legal-structure',
      /\b(?:llc|c-?corp|s-?corp|incorporat\w*|legal entity|sole proprietor\w*|nonprofit|non-profit|bylaws)\b/,
    ],
    [
      'cofounder-agreement',
      /\b(?:co-?founders?|founders?['’]? agreement|operating agreement|partnership agreement)\b/,
    ],
    ['contracts-and-insurance', null],
  ],
};

/** The referral's intent for the risk the classifier found, or null. */
export function referralForRisk(
  playbook: Playbook,
  categories: readonly RiskCategory[],
  message: string,
): PathIntent | null {
  const text = plain(message);
  const intentOf = (playId: string): PathIntent | null =>
    playbook.intents.find((i) => i.playId === playId && (i.referral === true || i.holds === true)) ?? null;
  for (const category of categories) {
    for (const [playId, words] of PLAYS[category] ?? []) {
      if (words !== null && !words.test(text)) continue;
      const intent = intentOf(playId);
      if (intent !== null) return intent;
    }
    // A category with no play of its own here (a conflict): the playbook's referral of that category.
    if (category === 'legal') continue;
    const found = playbook.intents.find(
      (intent) =>
        intent.referral === true &&
        playbook.plays.find((x) => x.id === intent.playId)?.referral?.category === category,
    );
    if (found !== undefined) return found;
  }
  return null;
}
