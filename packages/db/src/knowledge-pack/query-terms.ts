/**
 * The content of a message for lexical retrieval: its distinct words, each with the other names a founder or a source
 * uses for the same thing. Every entry is one `websearch_to_tsquery` text (`vc or "venture capital"`), so a passage
 * that says either counts once. Conversational words that carry no subject are left out: a passage sharing only
 * "want", "help" and "make" with a message is not about it.
 */

const GENERIC: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by for from has have he her his i if in into is it its of on or our she so that ' +
    'the their them they this to was we were will with you your not no do does did can could should would may might ' +
    'about after before than then there these those which who what when where how why my me us am im ive id ill dont ' +
    'doesnt didnt cant isnt whats thats lets wanna gonna gotta any some all also just really very much many more most ' +
    'too even still yet only own same such other another each every both few lot lots bit kind sort stuff thing things ' +
    'something anything everything nothing someone anyone everyone one ones want wants wanted need needs needed help ' +
    'helps make makes making made know knows think thinks thinking like get gets getting got go goes going do doing done ' +
    'say says said tell tells told give gives please thanks thank hi hey hello ok okay yes yeah sure well now today ' +
    'tomorrow yesterday way ways good better best great nice right wrong maybe actually basically literally probably ' +
    'guess feel feels see look looks looking use try trying tried put take takes come comes let keep keeps work works ' +
    'talk question questions answer idk btw lol because since while during over up down out off again here got ' +
    'having being able without between through'
  ).split(' '),
);

/** Other names of the same thing; every key and alternative is lower case. Never broader or narrower terms. */
const SAME: Readonly<Record<string, readonly string[]>> = {
  vc: ['venture capital'],
  vcs: ['venture capital'],
  bmc: ['business model canvas'],
  mvp: ['minimum viable product'],
  llc: ['limited liability company'],
  // Not "doing business as": only "business" of it is a word to the text search, which any passage says.
  dba: ['trade name'],
  ein: ['employer identification number'],
  tam: ['market size'],
  ip: ['intellectual property'],
  cofounder: ['co-founder'],
  cofounders: ['co-founder'],
  clients: ['customer'],
  client: ['customer'],
  buyer: ['customer'],
  buyers: ['customer'],
  competitors: ['competition', 'competitive'],
  competitor: ['competition', 'competitive'],
  competition: ['competitor', 'competitive'],
  expenses: ['cost'],
  expense: ['cost'],
  costs: ['expense'],
  cost: ['expense'],
  incorporate: ['corporation'],
  incorporating: ['corporation'],
  fundraise: ['fundraising', 'raise money'],
  fundraising: ['raise money', 'funding'],
  raise: ['fundraising'],
  raising: ['fundraising'],
  funding: ['fundraising'],
  bootstrap: ['self-funding', 'bootstrapping'],
  bootstrapping: ['self-funding'],
  startup: ['start-up'],
  startups: ['start-up'],
  crowdfund: ['crowdfunding'],
  kickstarter: ['crowdfunding'],
  trademark: ['trade mark'],
  deck: ['pitch deck'],
  slides: ['pitch deck'],
  breakeven: ['break-even'],
  nonprofit: ['non-profit'],
  taxes: ['tax'],
  sued: ['sue', 'lawsuit'],
  liable: ['liability'],
  steal: ['theft'],
  stealing: ['theft', 'steal'],
  introvert: ['introverted', 'introverts'],
  shares: ['stock'],
};

/** At most this many words of a message are read (its first ones): a long message names its subject early and again. */
export const MAX_QUERY_TERMS = 40;

/** The message's distinct content words, in order. */
export function contentTerms(text: string): string[] {
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[’‘`´']/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (seen.has(word) || GENERIC.has(word) || (word.length < 2 && !/\d/.test(word))) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/** One `websearch_to_tsquery` text per content word ({@link contentTerms}), with its other names. */
export function queryTermGroups(text: string): string[] {
  return contentTerms(text).map((word) => {
    const same = Object.hasOwn(SAME, word) ? (SAME[word] ?? []) : [];
    return [word, ...same.map((s) => `"${s}"`)].join(' or ');
  });
}

/**
 * Words that name one thing (a legal form, a filing, a programme, a method): a passage whose title or heading says the
 * same word is about it whatever its vector says, so its place in the word ranking counts as much as the vector's
 * (`RETRIEVAL_FUSION.rescue`). Everyday words never are: "safe" only as SAFE.
 */
const NAMED: ReadonlySet<string> = new Set(
  (
    'patent patents patented provisional trademark trademarks trademarked copyright copyrights nda ndas llc llcs dba ' +
    'dbas ein eins corp incorporate incorporating incorporation proprietorship proprietor nonprofit nonprofits ' +
    'accredited crowdfunding crowdfund kickstarter sbir sttr corps nsf sba irs uspto fda hipaa ferpa 506 1040 vesting ' +
    'convertible capstone capstones blackboard canvas bmc mvp mvps tam cac ltv breakeven swot linkedin visa'
  ).split(' '),
);

/**
 * The entries of {@link queryTermGroups} that name one thing: a word of {@link NAMED}, or an acronym as the founder
 * wrote it ("a SAFE note", "our CRM"), unless they write everything in capitals.
 */
export function namedTermGroups(text: string): string[] {
  const shouting = !/[a-z]/.test(text);
  const acronyms = new Set(
    shouting ? [] : (text.match(/\b[A-Z][A-Z0-9]{1,5}s?\b/g) ?? []).map((w) => w.toLowerCase()),
  );
  return queryTermGroups(text).filter((group) => {
    const word = group.split(' or ', 1)[0] ?? '';
    return NAMED.has(word) || acronyms.has(word);
  });
}

/** Words nearly every venture on the platform uses: sharing one says nothing about what a message is about. */
export const PLATFORM_WORDS: ReadonlySet<string> = new Set(
  (
    'venture ventures startup startups business businesses company companies idea ideas project product products ' +
    'campus college university school student students founder founders entrepreneur entrepreneurs app apps ' +
    'customer customers client clients user users people person team teams friend friends money week weeks month ' +
    'months day days year years time program programme center centre late early first next new plan plans planning ' +
    'start started starting build building built launch sell selling problem problems'
  ).split(' '),
);

/** {@link queryTermGroups} without the words every venture uses: what a resource or a lesson must be about. */
export function subjectTermGroups(text: string): string[] {
  return queryTermGroups(text).filter((group) => !PLATFORM_WORDS.has(group.split(' or ', 1)[0] ?? ''));
}
