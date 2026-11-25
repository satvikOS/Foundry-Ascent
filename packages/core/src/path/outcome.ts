import { ratiosIn, saidNumbers } from './calc.js';
import { ownSentences } from './kinds.js';
import { toldCounts } from './told-counts.js';
import { plain } from './words.js';

/**
 * Whether a message reports an outcome: what somebody did, said or paid, a count, a test, a refusal. A verdict opens only
 * over one. An idea just told, a step that was not done, the time they have, a plan or a question of it report none. Pure.
 */

/** What somebody else does that shows something: in the past, or as it stands. */
const DID =
  '(?:said|says|paid|pays|paying|told|tells|bought|buys|ordered|orders|signed|signs|came|comes|returned|cancell?ed|left|quit|asked|asks|replied|answered|emailed|wrote|writes|called|phoned|texted|refused|refuses|declined|rejected|turned|liked|likes|loved|loves|hated|hates|laughed|shrugged|wants|wanted|tried|uses|used|stopped|rented|rents|booked|renewed|offered|offers|agreed|approved|launched|picked|took|kept|gave|got|sent|pulled|joined|opened|finished|clicked|walked|complained|subscribed|dropped|switched|showed|prepaid|pre-?ordered|promised|cried|invited|lent|stayed|say|write|tell)';
const SOMEBODY =
  '(?:nobody|no one|no-one|none|they|he|she|people|everyone|everybody|someone|somebody|most|many|some|all|half|few|the rest|both|neither)';
const OTHERS_DID = new RegExp(
  `\\b${SOMEBODY}(?: (?:of|from|in|on) (?:them|those|these|it|the \\w+|my \\w+|\\w+))?(?: (?:just|also|even|already|really|all|only|never|still|actually|have|has|had|would|did|didn['’]?t))* ${DID}\\b`,
);
/** "Two caterers said", "one mother wrote", "the hotel buyer turned". */
const ONES_DID = new RegExp(
  `\\b(?:\\d+|an?|one|two|three|another|my|our|the|her|his|their)(?: (?:of|other) (?:them|those|the))?(?: [a-z'’-]+){1,4}? (?:(?:just|also|already|finally|have|has|had|still|only|all) )*${DID}\\b`,
);
/** "4 left an address". */
const SO_MANY_DID = new RegExp(`(?<![\\d.$])\\b\\d+ ${DID}\\b`);
/** What they did themselves that tries it on somebody. */
const TRIED =
  /\b(?:i|we)(?:['’]ve| have|['’]d)? (?:just |also |finally |already |only |even )*(?:asked|interviewed|talked|spoke|called|phoned|emailed|messaged|texted|showed|shown|offered|sold|surveyed|pitched|presented|met|rented|charged|handed|delivered|r[au]n (?:an?|the|\d+)|tested|launched|put up|gave|did (?:\w+ )?(?:\d+|the interviews|the talks|the test|the friday|one)|made \$|earned|had \d+|have \d+ (?:\w+ )?(?:customers|users|orders|sign-?ups|listings|buyers|clients|subscribers))\b/;
const NOT_DONE =
  /\b(?:i|we) (?:did ?n['’]?t|did not|have ?n['’]?t|have not|never|could ?n['’]?t|could not|forgot|skipped|missed|was too|were too|had no)\b/;
/** What has not happened. */
const NOT_YET =
  /\b(?:would|will|might|could|should|want to|wants to|hope|hopes|plan|plans|going to|gonna|thinking (?:of|about)|if|say|suppose|imagine|when i|once i)\b/;
/** The time they have, and what is in its way. */
const OF_TIME =
  /\b(?:took|ate|eats|takes) (?:up )?(?:the|my|all|most)\b[^.]*\b(?:weeks?|month|days?|weekend|time)\b|\b(?:exams?|midterms?|finals|hours?|classes|semester|break|schedule|busy|free time|weeks? off|sick)\b/;

/** What somebody advises. */
const ADVISES =
  /\b(?:says?|said|tells?|told) (?:me |us |that )?(?:to|we|i|you|get|hire|sell|add|do|go|put|make|charge|start|stop|it['’]?s (?:normal|easy))\b/;
/** Counts of it that hold whatever else the sentence says. */
const COUNTED = new RegExp(
  `\\b\\d+ (?:out )?(?:of|outta) (?:the |my |our )?\\d+ (?:[a-z'’-]+ ){0,3}?${DID}\\b`,
);

const own = (message: string): string[] =>
  ownSentences(message).flatMap((s) => s.split(/(?<=[.!?;])\s+|\s+\/\/\s+|\n+|\s+but\s+/u));

/** Whether what they tell is an outcome. */
export function reportsOutcome(message: string): boolean {
  if (toldCounts(message) !== null) return true;
  return own(message).some((s) => {
    const t = saidNumbers(s);
    if (/\?\s*$/.test(s) && !/\bsaid\b|\bpaid\b|\bbought\b/.test(t)) return false;
    if (NOT_DONE.test(t) || /\b(?:i|we)(?:['’]ve)? (?:decided|pivot|chang)/.test(t)) return false;
    if (COUNTED.test(t)) return true;
    if (/\b(?:told|asked|wrote|emailed|called|texted) (?:me|us)\b/.test(t) && !ADVISES.test(t)) return true;
    if (ADVISES.test(t)) return false;
    const happened = !NOT_YET.test(t) || /\b(?:said|says?|told|asked|offered|paid|bought)\b/.test(t);
    if (!happened) return false;
    if (ratiosIn(s).length > 0) return true;
    if (OF_TIME.test(t) && !/\b(?:said|paid|bought|sold|asked)\b/.test(t)) return false;
    return (
      TRIED.test(t) ||
      /(?:^|[,:;] )(?:said|paid|pays|loves|hates|refused|bought) (?:yes|no|it|that|\d|what|a|the|us|me)\b/.test(
        t,
      ) ||
      SO_MANY_DID.test(t) ||
      OTHERS_DID.test(t) ||
      ONES_DID.test(t) ||
      /\b\d+ (?:[a-z'’-]+ ){0,2}(?:paying|paid|sold|signed up|rented|bought|bowls|orders|sign-?ups|yes(?:es)?|no['’]?s)\b/.test(
        t,
      ) ||
      /\b(?:sold|rented|made|earned) (?:out|\$? ?\d)/.test(t)
    );
  });
}

/** Whether they ask what to make of what came. */
const OF_WHAT_CAME =
  /\b(?:is|was|isn['’]?t) (?:that|this|it)(?: \w+)? (?:good|bad|ok(?:ay)?|enough|proof|a (?:yes|no|result|lot)|normal|fine|low|high)\b|\bgood or (?:bad|not)\b|\b(?:good|bad) news\b|\bwhat (?:does|do|did) (?:that|this|it|they|those) (?:mean|show|tell|prove)\b|\bdoes (?:that|this|it) (?:mean|show|prove|count)\b|\bwhat do i (?:make|do) (?:of|with) (?:that|this|it)\b|\bso what does\b|\bthat['’]?s a (?:yes|no)\b|\bwhat (?:do|did) i learn\b|\bwhat mean (?:this|that|it)\b/;

/** Whether a result may be read of the turn: an outcome told now, or one told before that they ask about. */
export const readsOutcome = (message: string, earlier: readonly string[]): boolean =>
  reportsOutcome(message) || (OF_WHAT_CAME.test(plain(message)) && earlier.some(reportsOutcome));
