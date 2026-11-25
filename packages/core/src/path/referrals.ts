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

const AMOUNT = String.raw`\$? ?\d[\d,.]* ?(?:k|thousand|grand|m|mil|million)?(?: ?(?:dollars|bucks|usd))?`;
/** A part as a fraction is one of a company only when it stands alone, or is of it. */
const SHARE = String.raw`(?:an? )?(?:\d{1,2}(?:\.\d+)? ?(?:%|percent\b|pct\b)|(?:half|third|quarter|fifth|tenth)\b(?= of (?:it|us|the |my |our )|[.,;!?]|$))`;
/** An amount nobody pays for a thing. */
const LARGE = String.raw`(?:\$? ?\d[\d,.]* ?(?:k|thousand|grand|m|mil|million)\b|\$? ?\d{1,3},\d{3}|\$? ?\d{4,})(?: ?(?:dollars|bucks|usd))?`;
/** What a percentage is of when it is no part of a company. */
const NOT_A_PART = String.raw`(?! ?(?:off|discount|discounts|more|less|cheaper|cut|cuts|commission|fee|fees|tip|tips|interest|margin|markup|tax|of (?:the |each |every |all )?(?:sales?|orders?|revenue|profits?|proceeds|price|bill|fee|tickets?|customers?|users?|people|buyers?|students?|bookings?)|on (?:each|every|top)|faster|bigger|smaller|back))`;
const FOR_A_SHARE: readonly RegExp[] = [
  new RegExp(
    String.raw`(?:^|[^\w$.])${LARGE} (?:on the table )?(?:in exchange )?(?:for|to (?:get|own|have)|against|buys?) ${SHARE}${NOT_A_PART}`,
  ),
  new RegExp(
    String.raw`\b(?:invest|put(?:ting)?(?: in)?|offer(?:s|ed|ing)?|give[sn]?|giving|gave)\b.{0,40}${AMOUNT}.{0,24}\b(?:for|at)\b.{0,14}(?:${SHARE}${NOT_A_PART}|(?:shares|equity|a stake|a piece|part of (?:the company|it|us))\b)`,
  ),
  new RegExp(
    String.raw`\b(?:investors?|angels?|fund|vcs?|accelerator|incubator)\b.{0,40}\b(?:wants?|wanted|wanting|asks? for|asked for|asking for|gets?|takes?)\b.{0,16}${SHARE} (?:of (?:the |my |our )?(?:company|business|startup|venture|equity|it|us)|equity|stake|ownership)\b`,
  ),
  // As it is heard on a call: "a hundred thousand for ten percent".
  new RegExp(
    String.raw`\b(?:hundred|thousand|grand|million)(?: dollars| bucks)? (?:in exchange )?for (?:an? )?(?:[a-z]+[ -]){0,2}(?:percent\b|(?:half|third|quarter|fifth|tenth)\b(?= of |[.,;!?]|$))${NOT_A_PART}`,
  ),
  /\bangel(?: investor)?\b(?!s).{0,40}\b(?:offers|offered|is offering|invests|invested|is investing|will invest|would invest|wants? (?:in\b|to (?:invest|put|buy))|puts? in|gave|gives|wrote (?:us|me) a che(?:ck|que))\b/,
  /\b(?:invest(?:or|ment)?|put(?:ting)? money|buy(?:ing)?) (?:in(?:to)? )?.{0,24}\b(?:for|at|in exchange for) (?:an? |some )?(?:stake|equity|shares|piece of (?:the company|it|us)|valuation cap|cap)\b/,
  /\b(?:valuation )?cap (?:of|at) \$? ?\d|\b\$? ?\d[\d,.]* ?(?:k|m|mil|million) (?:valuation )?cap\b/,
];
/** They only ask what a word means, or where to find someone: nobody has offered anything. */
const GENERAL =
  /\b(?:what (?:is|are|does)|how (?:do|can|would|should) (?:i|we) (?:find|get|meet|reach|pitch)|where (?:do|can) (?:i|we) find|look(?:ing)? for|find an?|how does|should (?:i|we) (?:look|go|get|try|pitch|apply))\b/;

/** Money is put to them for a part of the company: what it is worth, and whether to take it, a person decides. */
export function offersForShares(message: string): boolean {
  const text = message.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');
  return text.split(/(?<=[.!?])\s+|\n+/).some((s) => !GENERAL.test(s) && FOR_A_SHARE.some((r) => r.test(s)));
}
