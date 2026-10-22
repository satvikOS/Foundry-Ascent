/**
 * A life of the coach's own, told when the founder asks about it (evals MX-0032: "lowkey, how was your weekend?" got
 * "Weekend was good, thanks for asking."). Read only in reply to a question about the coach's own weekend, day, week,
 * holiday, evening or plans ({@link askedLifeOf}); a plain "how are you?" is not one. Without such a question nothing
 * here applies: the prompt's banter rule keeps the coach from making a life up, and the identity rule `personal_life`
 * keeps its plain first-person forms out ("My weekend was good"), as it always did. The founder's own story, bio,
 * pitch, customer quote or draft is never read here (a question about the coach must come first, and a draft or a
 * quote is never the coach's own voice).
 *
 * The identity validator (identity.ts, rule `personal_life`) takes such a sentence out of the reply (typed, spoken and
 * each streamed unit), keeps an honest answer about what the coach is and the founder's thanks, and turns the question
 * back to them ({@link lifeLeftover}, {@link finishLifeReply}). The evals matrix presence check (G14,
 * evals/foundry_evals/matrix/asked_life.py `asked_life_claim`) fails the same sentences; the cases both must agree on are
 * `asked_life` in evals/tests/fixtures/identity_cases.json, and every input an earlier, wider rule cut from the founder's
 * own words stays as it was (evals/tests/fixtures/presence_regressions.json).
 *
 * Pure patterns and text helpers: no import from identity.ts (which imports this module).
 */

const APOS = "['’]";
/** Not inside a word. */
const NL = '(?![\\p{L}])';

/** The coach's own time ("weekend", "day off", "holiday"). */
export const LIFE_TIME =
  '(?:(?:long\\s+|bank\\s+holiday\\s+)?weekend|(?:mon|tues|wednes|thurs|fri|satur|sun)day|week|day|morning|afternoon|evening|night|holidays?|vacation|trip|break|summer|time\\s+off|days?\\s+off|birthday|christmas|thanksgiving|easter|new\\s+year)';
/** Only a time of the founder's work, not of a life ("the weekend market", "the morning session", "holiday pricing"). */
export const LIFE_TIME_END =
  '(?![-\\p{L}]|\\s+(?:session|call|meeting|class|workshop|chat|shift|slot|market|stall|sales?|rush|crowd|traffic|numbers|launch|event|pop-?up|plans?|campaign|promo|deal|special|menu|service|hours|rates?|prices?|pricing|edition|issue|demand|orders?|bookings?|signups?|sign-ups?)(?![\\p{L}]))';
/** How such a time went. */
const LIFE_ADJ =
  '(?:good|great|fine|lovely|nice|relaxing|relaxed|restful|refreshing|quiet|chill|chilled|calm|peaceful|fun|busy|hectic|lazy|slow|easy|wonderful|amazing|fantastic|brilliant|awesome|excellent|perfect|eventful|uneventful|low-?key|mellow|cosy|cozy|rough|long|tiring|exhausting|packed|full|decent|solid|alright|okay|ok|sunny|special|crazy|wild|memorable|beautiful|productive|not\\s+bad)';
/** Words that only shade it ("pretty", "nice and"). */
const LIFE_SHADE =
  '(?:(?:really|very|pretty|so|super|quite|rather|fairly|nice\\s+and|lovely\\s+and|a\\s+bit|a\\s+little|kind\\s+of|kinda|sort\\s+of|actually|honestly|mostly|surprisingly|genuinely|properly|too)\\s+){0,3}';
/** One or more of them before a noun ("a lovely, long, relaxing weekend"), bounded. */
export const LIFE_ADJS = `(?:${LIFE_SHADE}${LIFE_ADJ}(?:\\s*,\\s*|\\s+and\\s+|\\s+)){1,4}`;
/** Somewhere one goes, or something one goes out to. */
const LIFE_OUTING = `(?:hike|hiking|run|running|walk|stroll|swim|swimming|road\\s+trip|trip|vacation|holiday|camping|skiing|surfing|climbing|cycling|bike\\s+ride|beach|gym|movies|cinema|theatre|theater|concert|gig|festival|wedding|party|museum|gallery|park|coast|seaside|mountains|lake|countryside|farmers${APOS}?\\s+market|brunch|dinner|lunch|drinks|picnic|date|spa|yoga|pilates|barbecue|bbq|pub(?:\\s+quiz)?|quiz\\s+night)(?![-\\p{L}])`;
/** Something one eats or drinks. */
const LIFE_FOOD =
  '(?:lunch|dinner|breakfast|brunch|supper|coffee|tea|drinks?|bite|snack|meal|picnic|barbecue|bbq|takeaway|takeout|pizza|pasta|salad|soup|sandwich|curry|sushi|tacos?|burrito|burger|noodles|ramen|toast|eggs|pancakes|waffles|cereal|porridge|oatmeal|smoothie|roast|cake|cookies?|ice\\s+cream|chocolate|wine|beer|cocktails?)(?![-\\p{L}])';
/**
 * Where a thing done ends its clause, or goes on with when, where or with whom ("had coffee with friends", "took a walk
 * to clear my head"): never "had coffee shops in mind", "took a walk through your numbers" or "watched the game play
 * out", which are coaching.
 */
const LIFE_DID_END = `(?=\\s*(?:[,.;:!?…—–)]|-\\s|\\n|$)|\\s+(?:with|at|in(?!\\s+(?:mind|prices?|pricing|rates?|fees?|costs?|the\\s+(?:price|model|numbers|data|plan)|your|our|their)${NL})|on|to(?!\\s+(?:test|check|see\\s+(?:if|whether)|validate|measure|prove|learn|try|compare)${NL})|around|along|outside|outdoors|this|last|yesterday|today|tonight|tomorrow|earlier|later|before|after|then|too|again|together|first|for\\s+(?:me|a\\s+(?:few|bit|while|change|couple)|an\\s+hour|some|(?:the|a|an)\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}|dinner|lunch|drinks|coffee)|while|here|myself|alone|out|now|soon|over|so|if|and(?!\\s+${LIFE_FOOD}\\s+\\p{L}))${NL})`;
/** When, after "baked" or "relaxed": a time of its own ("all weekend", "this morning"), or "a lot" (not "a lot of"). */
const LIFE_DONE_WHEN = `all\\s+(?:the\\s+)?${LIFE_TIME}${LIFE_TIME_END}|a\\s+lot(?!\\s+of${NL})|this\\s+(?:past\\s+)?${LIFE_TIME}${LIFE_TIME_END}(?!${APOS})`;
/**
 * What one did with the time, said with or without "I" ("slept in", "went hiking", "caught up with old friends"). Never
 * a form an instruction shares ("Read a book" may be advice), and never work on the founder's venture.
 */
const LIFE_DONE = [
  'slept\\s+(?:in|late|badly|like\\s+a\\s+(?:log|baby))',
  'caught\\s+up\\s+(?:on\\s+(?:some\\s+|my\\s+)?(?:sleep|reading|rest|tv|netflix|chores|errands|laundry|(?:a|an)\\s+(?:book|novel|show|series))|with\\s+(?:some\\s+|a\\s+few\\s+|an\\s+)?(?:old\\s+)?(?:friends?|family|mates))',
  'binged|binge-watched|gardened|napped|lounged',
  // Never "hiked the price" or "baked into the model".
  `hiked(?!\\s+(?:the|your|our|its|their|it|up|prices?|rates?|fees?)${NL})`,
  `baked\\s+(?:(?:a|some)\\s+(?:(?:big|huge|little|fresh|lovely|quick)\\s+)?)?(?:bread|sourdough|cookies|cakes?|brownies|banana\\s+bread|muffins|scones|pies?)${NL}`,
  // "this" and "all" only before a time of its own: "baked this into the table", "relaxed all the constraints" are work.
  `baked(?=\\s*(?:[,.;:!?…—–)]|$)|\\s+(?:${LIFE_DONE_WHEN}|on|at|with|and)${NL})`,
  `(?:relaxed|rested|unwound|chilled(?:\\s+out)?)(?=\\s*(?:[,.;:!?…—–)]|$)|\\s+(?:${LIFE_DONE_WHEN}|mostly|over|on|at|with|by|in|outside|outdoors|and|properly)${NL})`,
  'went\\s+(?:hiking|running|swimming|climbing|cycling|camping|skiing|surfing|dancing|shopping|sailing|fishing)',
  `got\\s+out\\s+(?:for\\s+(?:a|an)\\s+(?:${LIFE_ADJS})?(?:walk|run|hike|swim|ride|bike\\s+ride|drive|stroll)|on\\s+the\\s+(?:bike|water|hills))`,
  // "Went to a friend's wedding", "went for a long walk", "went out for drinks".
  `went\\s+(?:out\\s+(?:for|to|with)|for\\s+(?:a|an)\\s+(?:${LIFE_ADJS})?(?:walk|run|hike|swim|ride|bike\\s+ride|drive|stroll|coffee|drink|meal|dinner|lunch|brunch)|to\\s+(?:a|an|the|my|some)\\s+(?:\\p{L}+${APOS}s\\s+)?(?:${LIFE_ADJS})?${LIFE_OUTING}|on\\s+(?:a|an)\\s+(?:${LIFE_ADJS})?(?:hike|walk|run|trip|road\\s+trip|date|picnic|bike\\s+ride))`,
  `(?:got|came)\\s+back\\s+from\\s+(?:(?:a|an|the|my|some)\\s+)?(?:${LIFE_ADJS})?(?:${LIFE_OUTING}|${LIFE_TIME}${LIFE_TIME_END})`,
  'cooked\\s+(?:dinner|lunch|breakfast|brunch|pasta|for\\s+(?:my|friends|family|the\\s+kids)|a\\s+(?:big\\s+|lovely\\s+|nice\\s+)?(?:meal|dinner|lunch|roast|curry|feast))',
  'made\\s+(?:(?:a|some|my|the)\\s+)?(?:pancakes|waffles|pasta|bread|cookies|cake|dinner|lunch|breakfast|brunch|soup|curry)',
  `watched\\s+(?:a|an|the|some)\\s+(?:${LIFE_ADJS})?(?:movie|film|show|series|match|game|documentary|tv)${LIFE_DID_END}`,
  // "Took it easy on you in that round" is a critique, "took a walk through your numbers" a reading.
  `took\\s+(?:the\\s+dog|the\\s+kids|a\\s+(?:long\\s+)?(?:walk|hike|nap|stroll|swim|day\\s+off|break)${LIFE_DID_END}|it\\s+easy(?!\\s+(?:on|with)\\s)|some\\s+time\\s+off)`,
  'walked\\s+(?:the|my)\\s+dogs?',
  // Never "had people over-promise".
  'had\\s+(?:some\\s+)?(?:friends|family|people|mates|the\\s+(?:family|kids|neighbou?rs))\\s+over(?![-\\p{L}])',
  'visited\\s+(?:my|family|friends|the\\s+(?:coast|beach|mountains|lake|museum|gallery|seaside|countryside))',
  'got\\s+(?:some|a\\s+bit\\s+of|plenty\\s+of)\\s+(?:sun|fresh\\s+air|sleep|rest)',
  // A meal where its clause ends or goes on with when or with whom: never "had coffee shops in mind".
  `(?:grabbed|ate|had)\\s+(?:(?:a|an|some|a\\s+(?:big|quick|late|huge|little))\\s+)?(?:${LIFE_ADJS})?${LIFE_FOOD}${LIFE_DID_END}`,
  'ate\\s+(?:way\\s+)?too\\s+much',
  'played\\s+(?:some\\s+)?(?:tennis|football|soccer|golf|basketball|board\\s+games|video\\s+games|chess|guitar|piano)',
  'ran\\s+(?:a|my)\\s+(?:5k|10k|half(?:\\s+marathon)?|marathon|race)',
  'did\\s+(?:some|a\\s+bit\\s+of|a\\s+little)\\s+(?:gardening|hiking|cooking|baking|yoga|running|painting|shopping)',
  // "Tried a new ramen place downtown": never "tried a new framing for the pitch".
  `tried\\s+(?:a|an|this|that|the|some)\\s+(?:new\\s+)?(?:[\\p{L}'’-]+\\s+){0,2}?(?:place|restaurant|caf[eé]|bar|recipe|spot|bakery|pub|dish)${NL}`,
].join('|');
/** Where a told time ends its clause ("Weekend was good, thanks", "Pretty quiet one here"). */
const LIFE_CLAUSE_END = `\\s*(?:[,.;:!?…—–)]|-\\s|\\n|$)|\\s+(?:here|so\\s+far|though|overall|really|thanks|thank\\s+you|cheers|for\\s+me|all\\s+round|honestly|and|but|too|actually|tbh|at\\s+home|in\\s+the\\s+(?:garden|sun|park)|with\\s+(?:family|friends|the\\s+family)|indoors|outdoors|how|what|you|so|just)${NL}`;
/**
 * Plans of its own: "planning a long hike", "heading up to the lake", "off to the gym", "going to relax". An outing only
 * after "a" or "the", where its clause ends or goes on with when or with whom ("going to run the numbers", "planning a
 * run of three tests" are work).
 */
const LIFE_PLAN = `(?:(?:planning|going|heading|off)\\s+(?:(?:up|down|out|over|back)\\s+)?(?:(?:to|on|for|out\\s+(?:to|for))\\s+)?|hoping\\s+to\\s+(?:go\\s+(?:on|for|to|out\\s+(?:to|for))\\s+)?)(?:(?:a|an|the|some|my)\\s+(?:${LIFE_ADJS})?${LIFE_OUTING}${LIFE_DID_END}|on\\s+(?:holiday|vacation)|(?:to\\s+)?(?:relax|rest(?!\\s+(?:my|the|our)\\s+case)|unwind|chill|recharge|sleep\\s+in|take\\s+it\\s+easy(?!\\s+(?:on|with)\\s)|(?:visit|see)\\s+(?:family|friends|old\\s+friends|my\\s+(?:family|friends|folks|parents)))(?![-\\p{L}])|camping|hiking|skiing|travel(?:l)?ing|away)`;
/** An activity, said as a fragment ("Hiking, mostly!", "catching up on some reading"). */
const LIFE_DOING =
  '(?:hiking|reading|cooking|baking|gardening|running|swimming|cycling|walking|resting|relaxing|sleeping(?:\\s+in)?|napping|chilling|lounging|binge-?watching|painting|knitting|camping|skiing|surfing|climbing|travel(?:l)?ing|yoga|catching\\s+up(?:\\s+on\\s+(?:some\\s+|my\\s+)?(?:sleep|reading|rest|tv|netflix|chores|errands|laundry))?)(?![\\p{L}])';
/** Something one did or had, named as a fragment ("a long walk", "pancakes", "a bit of a lie-in", "hiking"). */
const LIFE_THING = `(?:(?:a\\s+bit\\s+of\\s+)?(?:(?:a|an|the|some)\\s+)?(?:${LIFE_ADJS})?(?:${LIFE_OUTING}|${LIFE_FOOD}|lie-?in|movie\\s+night|game\\s+night|night\\s+(?:in|out)|day\\s+out|book|novel|nap|film|movie|bath|sunshine|fresh\\s+air)(?![-\\p{L}])|${LIFE_DOING})`;
/**
 * How a time went, said bare ("Good, thanks!"). Never "okay", "alright", "perfect" or "brilliant", which also
 * acknowledge ("Perfect. Send it over.").
 */
const LIFE_BARE_ADJ =
  '(?:good|great|fine|lovely|nice|relaxing|relaxed|restful|refreshing|quiet|chill|chilled|calm|peaceful|fun|busy|hectic|lazy|slow|easy|wonderful|eventful|uneventful|low-?key|mellow|cosy|cozy|rough|long|tiring|exhausting|packed|decent|sunny|beautiful|not\\s+bad)';

/**
 * How a life is told (see `askedLifeAccepts` in identity.ts):
 * - `i`: in the first person ("My weekend was good", "I had a great time at the concert", "I'm heading to the coast"),
 *   anywhere in its sentence;
 * - `mine`: "Mine was relaxing", opening its clause;
 * - `told`: without "I", opening its clause ("Weekend was good", "It was lovely", "Slept in and read", "Spent it
 *   hiking", "Heading up to the lake with friends");
 * - `reaction`: without a verb ("Quiet weekend", "A relaxing one");
 * - `bare`: how the time went, said bare where the reply opens ("Good, thanks!", "Not bad at all!", "Yes, lovely
 *   thanks"), only to how a time of the coach's went;
 * - `fragment`: what it did, named where the reply opens ("Probably a long walk and catching up on some reading.").
 */
export type LifeForm = 'i' | 'mine' | 'told' | 'reaction' | 'bare' | 'fragment';

/** The life patterns by form, as sources (identity.ts compiles them with its word boundaries). */
export const ASKED_LIFE_SOURCES: readonly { readonly form: LifeForm; readonly source: string }[] = [
  {
    form: 'i',
    source: [
      `my\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}(?:${APOS}s\\s+(?:been|going)|\\s+(?:was|were|has\\s+been|went|is\\s+going|was\\s+just))`,
      `I(?:${APOS}ve|\\s+have)?\\s+(?:(?:just|also|really|finally|actually|already)\\s+)?(?:had|enjoyed|spent)\\s+(?:a|an|my|the|this|such\\s+a)\\s+(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|night\\s+out|day\\s+out|lie-in)`,
      `I(?:${APOS}ve|\\s+have)?\\s+(?:(?:just|also|really|finally|actually)\\s+)?had\\s+(?:a|an|such\\s+a)\\s+${LIFE_ADJS}time\\s+(?:at|with|in|on|away|out|off)${NL}`,
      `I(?:${APOS}m|\\s+am)\\s+(?:really\\s+|just\\s+)?having\\s+(?:a|an|such\\s+a)\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}`,
      `I(?:${APOS}ve|\\s+have)?\\s+(?:(?:just|also|finally|mostly|really|actually|recently)\\s+)?(?:${LIFE_DONE})`,
      `I\\s+(?:(?:just|also|finally)\\s+)?spent\\s+(?:(?:the|my|all|most\\s+of\\s+the)\\s+(?:day|morning|afternoon|evening|weekend)|(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\\s+(?:morning|afternoon|evening|night))?)\\s+(?:at|with|in|outside|outdoors|by\\s+the|on\\s+the|\\p{L}+ing${NL})`,
      `I(?:${APOS}m|\\s+am)\\s+(?:just\\s+)?back\\s+from\\s+(?:a|an|my|the)\\s+(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|${LIFE_OUTING})`,
      `I(?:${APOS}m|\\s+am)\\s+(?:(?:just|probably|mostly|really)\\s+)?${LIFE_PLAN}`,
      `I(?:${APOS}ll|\\s+will)\\s+be\\s+(?:relaxing|hiking|resting|travel(?:l)?ing|camping|skiing|unwinding|recharging|visiting\\s+(?:my|family|friends)|away|on\\s+(?:holiday|vacation|leave|a\\s+trip)|at\\s+the\\s+(?:beach|coast|lake|cottage|cabin|seaside))`,
    ].join('|'),
  },
  {
    form: 'mine',
    source: `mine(?:${APOS}s\\s+(?:been|going)|\\s+(?:was|were|has\\s+been|went|is\\s+going))\\s+(?:${LIFE_SHADE}(?:${LIFE_ADJ}|well)(?=${LIFE_CLAUSE_END})|(?:a|an)\\s+${LIFE_ADJS}(?:one|${LIFE_TIME})(?=${LIFE_CLAUSE_END})|spent|all\\s+about|full\\s+of)`,
  },
  {
    form: 'told',
    source: [
      `(?:(?:the|this|last)\\s+)?(?:${LIFE_TIME}|today)(?:${APOS}s\\s+(?:been|going)|\\s+(?:was|has\\s+been|went|is\\s+going|was\\s+just))\\s+(?:${LIFE_SHADE}(?:${LIFE_ADJ}|well)|(?:a|an)\\s+${LIFE_ADJS}(?:one|${LIFE_TIME}))(?=${LIFE_CLAUSE_END})`,
      // "It was lovely", "It's been a quiet one", and without "it" ("Been busy but in a good way").
      `(?:it(?:${APOS}s\\s+been|\\s+was|\\s+has\\s+been)|been)\\s+(?:${LIFE_SHADE}${LIFE_ADJ}|(?:a|an|such\\s+a)\\s+${LIFE_ADJS}(?:one|${LIFE_TIME}))(?=${LIFE_CLAUSE_END})`,
      `(?:had|having|enjoyed)\\s+(?:a|an|the|such\\s+a)\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}`,
      `(?:had|having|enjoyed)\\s+(?:a|an|such\\s+a)\\s+${LIFE_ADJS}one(?=${LIFE_CLAUSE_END})`,
      `(?:had|having)\\s+(?:a|an|such\\s+a)\\s+${LIFE_ADJS}time\\s+(?:at|with|in|on|away|out|off)${NL}`,
      `spent\\s+(?:it|most\\s+of\\s+it|all\\s+of\\s+it|(?:the|all|most\\s+of\\s+the)\\s+(?:whole\\s+)?${LIFE_TIME}|(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\\s+(?:morning|afternoon|evening|night))?)\\s+(?:\\p{L}+ing|at|with|outside|outdoors|in\\s+the|by\\s+the|on\\s+the|mostly|just)${NL}`,
      `(?:just\\s+)?back\\s+from\\s+(?:a|an|the|my)\\s+(?:${LIFE_ADJS})?(?:${LIFE_OUTING}|${LIFE_TIME}${LIFE_TIME_END})`,
      LIFE_DONE,
      `${LIFE_PLAN}(?!\\s+(?:is|was|can|could|helps?|might|may|would|will|should|works?|tends?)${NL})`,
      `(?:just|mostly)\\s+(?:relaxing|chilling|resting|unwinding|recharging|lounging|hiking|cooking|baking|gardening|napping|sleeping\\s+in|taking\\s+it\\s+easy)${NL}`,
    ].join('|'),
  },
  {
    form: 'reaction',
    source: `(?:(?:a|an|just\\s+a|such\\s+a)\\s+)?(?!(?:good|nice|great|fun|fair|tough|solid|long)\\s+one${NL}|good\\s+(?:morning|afternoon|evening|day|night)${NL})${LIFE_ADJS}(?:one|${LIFE_TIME})(?=${LIFE_CLAUSE_END})`,
  },
  {
    form: 'bare',
    source: `${LIFE_SHADE}${LIFE_BARE_ADJ}(?:\\s*,?\\s+(?:but|and|yet)\\s+${LIFE_SHADE}${LIFE_BARE_ADJ})?(?:\\s*,?\\s+(?:mostly|really|though|overall|honestly|at\\s+all))?(?=\\s*(?:[.!…]|\\n|$)|\\s*[,—–-]?\\s*(?:thanks|thank\\s+you|cheers)${NL})`,
  },
  {
    form: 'fragment',
    source: `(?:(?:just|mostly|probably|maybe|hopefully|lots\\s+of|a\\s+lot\\s+of|plenty\\s+of|loads\\s+of)\\s+)?${LIFE_THING}(?:\\s*,?\\s+(?:and|&|plus|then|with)\\s+${LIFE_THING}){0,3}(?=\\s*(?:[,.;:!?…—–)]|-\\s|\\n|$)|\\s+(?:mostly|honestly|really|though|thanks|thank\\s+you|if|at\\s+home|in\\s+the\\s+(?:garden|park|sun)|this\\s+(?:morning|afternoon|evening|weekend)|tomorrow|tonight|later|for\\s+me|here)${NL})`,
  },
];

// The founder's question ---------------------------------------------------------------------------------------------

const YOU = '(?:you|u|ya)';
const YOUR = '(?:your|ur|yr)';
/** A holiday asked about without "your" ("how was thanksgiving?", "how were the holidays?"). */
const NAMED_HOLIDAY = `(?:(?:the\\s+)?(?:holidays?|long\\s+weekend|bank\\s+holiday)|christmas|thanksgiving|easter|new\\s+year)${LIFE_TIME_END}`;

/** Asks how a time of the coach's own went: "your" weekend, never "the" week or launch (the founder's own). */
const ASKED_PAST_SOURCES = [
  `how\\s*(?:${APOS}?d|\\s+was|\\s+were|\\s+did)\\s+(?:${YOUR}\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}|${NAMED_HOLIDAY})`,
  `(?:did|have)\\s+${YOU}\\s+(?:have|get|enjoy|had)\\s+(?:a|an|any|some)\\s+(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|rest|fun|one${NL})`,
  `${YOU}\\s+(?:have|had|get)\\s+(?:a|an)\\s+${LIFE_ADJS}(?:${LIFE_TIME}${LIFE_TIME_END}|one)\\s*\\?`,
  // "good weekend?", "nice holiday?" as a question of its own.
  `(?:^|(?<=[.!?…,])\\s*)(?:(?:and|so|hey|hi|also|oh|btw|ok|okay|lowkey|ngl|anyway)[\\s,!]+)*${LIFE_ADJS}${LIFE_TIME}\\s*\\?`,
  `hope\\s+(?:${YOU}(?:${APOS}ve|\\s+have)?\\s+had\\s+(?:a|an|such\\s+a)\\s+(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|one${NL})|${YOUR}\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}\\s+(?:was|went|has\\s+been))`,
  `(?:did|have)\\s+${YOU}\\s+(?:do|get\\s+up\\s+to|been\\s+up\\s+to|done)\\s+(?:anything|something)\\s+(?:fun|nice|good|exciting|interesting|cool|special)`,
  `what\\s+did\\s+${YOU}\\s+(?:get\\s+up\\s+to|do\\s+(?:(?:this|last|over\\s+the|on\\s+the|on|for|at)\\s+)?(?:${LIFE_TIME}${LIFE_TIME_END}|yesterday|last\\s+night))`,
];
/** Asks about the coach's own day, evening or plans, or how its life goes ("how's your day going?", "any plans?"). */
const ASKED_OTHER_SOURCES = [
  `how\\s*(?:${APOS}?s|\\s+is|\\s+has|\\s+are)\\s+${YOUR}\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}(?:\\s+(?:going|been|looking|so\\s+far))?`,
  `how${APOS}?s\\s+life(?:\\s+treating\\s+${YOU})?|how\\s+is\\s+life`,
  `(?:any|got\\s+any|${YOU}\\s+(?:got|have)\\s+any)\\s+(?:fun\\s+|exciting\\s+|nice\\s+)?plans\\s+(?:for|this|over|on)\\s+(?:the\\s+)?(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|tonight|later|tomorrow)`,
  `(?:any|got\\s+any|what\\s+are\\s+${YOUR}|${YOU}\\s+(?:got|have)\\s+any)\\s+(?:weekend|holiday|summer|christmas|evening|vacation|fun|exciting)\\s+plans`,
  `what\\s+are\\s+${YOUR}\\s+plans\\s+(?:for|this|over)\\s+(?:the\\s+)?(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|tonight|later)`,
  `what\\s+(?:are|r)\\s+${YOU}\\s+(?:up\\s+to|doing)\\s+(?:(?:this|over\\s+the|on\\s+the|for\\s+the|at\\s+the|next)\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}|tonight|later|tomorrow|today)`,
  `what\\s+(?:are|r)\\s+${YOU}\\s+up\\s+to\\s*(?:[?!.]|$)`,
  `(?:are|r)\\s+${YOU}\\s+(?:going|travel(?:l)?ing|heading|getting)\\s+(?:anywhere|away|on\\s+(?:holiday|vacation|a\\s+trip))`,
  `(?:doing|up\\s+to)\\s+anything\\s+(?:fun|nice|good|exciting|special)\\s+(?:this|over\\s+the|for\\s+the|on\\s+the|tonight|later)`,
];

function questionRegex(sources: readonly string[], flags: string): RegExp {
  return new RegExp(sources.map((s) => `(?<![\\p{L}'’])(?:${s})`).join('|'), flags);
}

const ASKED_PAST = questionRegex(ASKED_PAST_SOURCES, 'iu');
const ASKED_OTHER = questionRegex(ASKED_OTHER_SOURCES, 'iu');
const ASKED_ANY = questionRegex([...ASKED_PAST_SOURCES, ...ASKED_OTHER_SOURCES], 'giu');

/** What the founder's message asks about the coach's own life, and whether it tells something of their own. */
export interface AskedLife {
  /** How a time of the coach's went (`past`: "how was your weekend?"), or its day, plans or life (`other`). */
  readonly asked: 'past' | 'other';
  /**
   * The message tells something of the founder's own besides asking ("how was your weekend? mine was busy", "…we sold
   * out"): a life said without "I" may then be a reaction to theirs, so only "Mine…", the first person, or a sentence
   * that thanks them for asking counts.
   */
  readonly news: boolean;
}

/** A quoted passage in the founder's message (someone else's words: "my customer asked 'how was your weekend?'"). */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu;
/** The founder in the first person ("I", "we", "my", "mine"). */
const FOUNDER_SELF = /(?<![\p{L}'’])(?:i|we|my|our|mine|ours)(?![\p{L}])/iu;
/** A time, or something done in it: with the founder in the first person, they tell their own. */
const FOUNDER_OWN_TIME = new RegExp(
  `(?<![\\p{L}])(?:${LIFE_TIME}|today|yesterday|went|spent|had|did|got|was|were|sold|ran|made|took|slept|hiked|launched|shipped|signed|closed)(?![\\p{L}])`,
  'iu',
);
/** Words that tell nothing on their own beside a question about the coach ("hey!", "lol", "thanks!"). */
const FOUNDER_FILLER =
  /^(?:hi|hey|hello|yo|hiya|morning|evening|afternoon|good|ok|okay|so|also|btw|anyway|lowkey|ngl|lol|haha|ha|thanks|thank|you|cheers|there|um|uh|oh|happy|wait|and|by|the|way|(?:mon|tues|wednes|thurs|fri|satur|sun)day)$/iu;

function wordsIn(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'’]+$/gu, ''))
    .filter((w) => w !== '');
}

/**
 * What the founder's message asks about the coach's own life ({@link AskedLife}), or null when it asks nothing about
 * it: a question about the coach's own weekend, day, week, holiday, evening or plans ("lowkey, how was your weekend?",
 * "good holiday?", "how's your day going?", "any plans this weekend?", "what are you up to?"). A plain "how are you?",
 * "how did the week go?" (the founder's own week) and a question quoted from someone else are not.
 */
export function askedLifeOf(founderText: string): AskedLife | null {
  const said = founderText.replace(QUOTED, ' ');
  const asked = ASKED_PAST.test(said) ? 'past' : ASKED_OTHER.test(said) ? 'other' : null;
  if (asked === null) return null;
  // What the message says besides its questions about the coach.
  const rest = said.replace(ASKED_ANY, ' ');
  const sentences = rest.split(/(?<=[.!?…])\s+|\n+/u).filter((s) => /\p{L}/u.test(s));
  const news = sentences.some(
    (s) =>
      (FOUNDER_SELF.test(s) && FOUNDER_OWN_TIME.test(s)) ||
      (!/\?[\s"”’)*_]*$/u.test(s) && !wordsIn(s).every((w) => FOUNDER_FILLER.test(w))),
  );
  return { asked, news };
}

// Thanks and the question turned back -------------------------------------------------------------------------------

const THANKS_HEAD = '(?:thanks|thank\\s+you)(?:\\s+(?:so|very)\\s+much|\\s+a\\s+(?:lot|bunch|ton))?';
/**
 * Thanking the founder for asking ("thanks", "thank you so much for asking", "cheers"): never a thanks for something
 * else ("thanks for sharing the numbers"), and never "thanks to the market".
 */
const THANKS_SOURCE = `(?<![\\p{L}])(?:${THANKS_HEAD}(?:\\s+for\\s+(?:asking|checking\\s+in|the\\s+question|wondering)(?![\\p{L}])|(?![\\p{L}])(?!\\s+for(?![\\p{L}])))|(?:cheers|thx)(?![\\p{L}])|appreciate\\s+(?:you\\s+asking|the\\s+question)(?![\\p{L}]))(?!\\s+to(?![\\p{L}]))`;
/** A sentence that thanks the founder for asking. */
export const THANKS = new RegExp(THANKS_SOURCE, 'iu');
const THANKS_GLOBAL = new RegExp(THANKS_SOURCE, 'giu');
/** Any thanks to the founder, with what it is for, as written ("thanks for sending the deck"): kept when a life goes. */
const THANKS_WRITTEN = new RegExp(
  `(?<![\\p{L}])(?:${THANKS_HEAD}(?:\\s+for\\s+[^.!?…\\n,;:—–()]*[^\\s.!?…\\n,;:—–()])?|cheers|thx|appreciate\\s+(?:you\\s+asking|the\\s+question))(?![\\p{L}])(?!\\s+to(?![\\p{L}]))`,
  'iu',
);

/**
 * A question turned back to the founder, also as a call transcribes it, without a question mark ("…how was yours",
 * "…what about you"): its "you" does not make the life before it theirs.
 */
const TURN_BACK_SOURCE = `(?<![\\p{L}])(?:(?:so|and)\\s+)?(?:(?:how|what)\\s+about\\s+(?:you|yours|yourself|u)|how\\s*(?:${APOS}?s|\\s+is|\\s+was|\\s+were|\\s+did|\\s+has)\\s+(?:yours|your\\s+(?:${LIFE_ADJS})?${LIFE_TIME})(?:\\s+(?:been|going|go))?|how\\s+(?:are|r)\\s+(?:you|u)(?:\\s+doing)?|what${APOS}?s\\s+(?:on\\s+your\\s+mind|new\\s+with\\s+you)|what\\s+did\\s+you\\s+get\\s+up\\s+to|any\\s+plans\\s+yourself|hbu|wbu|(?:you|yours)(?=[\\s"”’)*_]*\\?))(?![\\p{L}])`;
const TURN_BACK = new RegExp(TURN_BACK_SOURCE, 'iu');
const TURN_BACK_GLOBAL = new RegExp(TURN_BACK_SOURCE, 'giu');
/** A question turned back too short to stand alone ("You?", "And yours?", "hbu"). */
const TERSE_TURN_BACK =
  /^[\s"“'‘*_(]*(?:and\s+)?(?:you|yours|u|ya|yourself|hbu|wbu)[\s"”’)*_]*\?*[\s"”’)*_]*$/iu;

/** The founder in a clause ("Busy weekend for you"), not in a thanks ("thank you") or a question turned back. */
const ABOUT_THE_FOUNDER = /(?<![\p{L}'’])(?:you|your|yours|yourself|ya|u|ur)(?![\p{L}])/iu;

/** Whether `clause` is about the founder: their "you", outside a thanks or a question turned back to them. */
export function aboutTheFounder(clause: string): boolean {
  return ABOUT_THE_FOUNDER.test(clause.replace(THANKS_GLOBAL, ' ').replace(TURN_BACK_GLOBAL, ' '));
}

/** What follows the last thanks in `lead` ("it was good thanks " → " "), or all of it. */
export function afterThanks(lead: string): string {
  let end = 0;
  THANKS_GLOBAL.lastIndex = 0;
  for (const m of lead.matchAll(THANKS_GLOBAL)) end = m.index + m[0].length;
  return lead.slice(end);
}

/** Where a question turned back starts in `text` (its "and…" included), or -1. */
export function turnBackAt(text: string): number {
  const m = TURN_BACK.exec(text);
  return m === null ? -1 : m.index;
}

/** Words that may open a clause before a life told without "I" ("Honestly, mine was quiet", "Oh, just relaxing"). */
export const LIFE_LEAD_WORDS = new Set([
  'and',
  'but',
  'so',
  'oh',
  'ah',
  'aw',
  'ha',
  'haha',
  'hah',
  'honestly',
  'well',
  'yeah',
  'yes',
  'yep',
  'mostly',
  'overall',
  'just',
  'really',
  'actually',
  'though',
  'hmm',
  'anyway',
  'also',
  'plus',
  'oof',
  'phew',
  'lol',
  'ngl',
  'tbh',
  'lowkey',
  'probably',
  'maybe',
  'hopefully',
]);

function upperFirst(text: string): string {
  const i = text.search(/\p{L}/u);
  return i < 0 ? text : `${text.slice(0, i)}${text.charAt(i).toUpperCase()}${text.slice(i + 1)}`;
}

/** The question turned back to the founder once a made-up life is out ("How was yours?"). */
export function lifeTurnBack(life: AskedLife): string {
  if (life.news) return life.asked === 'past' ? 'Tell me more about yours.' : 'Tell me more.';
  return life.asked === 'past' ? 'How was yours?' : 'How about you?';
}

/** "Thanks for asking!" and the question turned back: what a reply that was only a made-up life becomes. */
export function lifeFallback(life: AskedLife): string {
  return `Thanks for asking! ${lifeTurnBack(life)}`;
}

/** A thanks, a turn-back or a sentence as a sentence of its own ("thank you" → "Thank you!"). */
function asSentence(text: string, stop: string): string {
  const t = upperFirst(text.trim().replace(/[\s,;:—–-]+$/u, ''));
  return /[.!?…]["”’)*_]*$/u.test(t) ? t : `${t}${stop}`;
}

/**
 * What stays of a sentence that told a made-up life (`sentence`, the life ending at `lifeEnd` in it): the founder's
 * thanks, as written ("Weekend was good, thanks for asking." → "Thanks for asking!", "…, thanks for sending the deck!"
 * → "Thanks for sending the deck!"; `thanks` false when the reply thanks them for asking elsewhere), and a question turned back after the life ("it was lovely thank you how about you" → "Thank
 * you! How about you?"; a terse "and yours?" in full). '' when neither is there.
 */
export function lifeLeftover(
  sentence: string,
  lifeEnd: number,
  life: AskedLife,
  thanks: boolean,
): { text: string; thanked: boolean } {
  const parts: string[] = [];
  let thanked = false;
  const back = TURN_BACK.exec(sentence.slice(lifeEnd));
  const backAt = back === null ? sentence.length : lifeEnd + back.index;
  if (thanks) {
    const m = THANKS_WRITTEN.exec(sentence.slice(0, backAt));
    if (m !== null) {
      parts.push(asSentence(m[0], '!'));
      thanked = true;
    }
  }
  if (back !== null) {
    // The turn-back as said, to the end of its sentence ("how about you", "and yours?" in full).
    const said = sentence
      .slice(backAt)
      .replace(/^\s*(?:and|so)\s+/iu, '')
      .replace(/[\s.!?…"”’)*_]+$/u, '');
    parts.push(TERSE_TURN_BACK.test(said) ? lifeTurnBack(life) : asSentence(said, '?'));
  }
  return { text: parts.join(' '), thanked };
}

/** One piece of a reply that is only thanks or a plain "I'm good" ("Ha", "Thanks for asking", "Can't complain"). */
const THANKS_ITEM = `(?:ha(?:ha)*|aw+|oh|ah|well|honestly|${THANKS_SOURCE}|that${APOS}s\\s+(?:kind|sweet|nice)\\s+of\\s+you(?:\\s+to\\s+ask)?|kind\\s+of\\s+you\\s+to\\s+ask|I(?:${APOS}m|\\s+am)\\s+(?:doing\\s+)?(?:really\\s+|pretty\\s+)?(?:good|great|well|fine|okay|ok|alright)|I(?:${APOS}ve|\\s+have)\\s+been\\s+(?:really\\s+|pretty\\s+)?(?:good|great|well|fine|okay|ok|alright)|(?:doing|been)\\s+(?:really\\s+|pretty\\s+)?(?:good|great|well|fine|okay|ok|alright)|can${APOS}?t\\s+complain|no\\s+complaints|all\\s+good)`;
/** Text that is only thanks or a plain "I'm good" (pieces set apart by punctuation or space, so it stays linear). */
const ONLY_THANKS = new RegExp(
  `^[\\s"“'‘*_(]*${THANKS_ITEM}(?:[\\s,.!…—–-]+${THANKS_ITEM})*[\\s,.!…—–"”’)*_-]*$`,
  'iu',
);
/** Text that is only thanks (or nothing) and one short question ("Thanks! You?", "Did you get a break?"). */
const THANKS_AND_QUESTION = new RegExp(
  `^(?<thanks>[\\s"“'‘*_(]*${THANKS_ITEM}(?:[\\s,.!…—–-]+${THANKS_ITEM})*[\\s,.!…—–-]*)?(?<question>[^.!?…\\n]{1,80}\\?+)[\\s"”’)*_]*$`,
  'iu',
);

/** Whether `text` is only thanks or a plain "I'm good" ("Thanks for asking!"), or nothing at all. */
export function isOnlyThanks(text: string): boolean {
  return !/\p{L}/u.test(text) || ONLY_THANKS.test(text.trim());
}

/** Longest text the turn-back rules read: a reply left with only thanks and a short question is shorter. */
const SHORT_REPLY_CHARS = 160;

/**
 * A reply once its made-up life is out, so it still turns to the founder: nothing left → "Thanks for asking! How was
 * yours?"; only thanks (or a plain "I'm good") → the question turned back after it; thanks (or nothing) and a terse
 * "You?" → the question in full ("Thanks! How was yours?"); a question to the founder alone ("How was yours?", "Did
 * you get a break?") → "Thanks for asking!" before it; a longer reply that ends in a terse "You?" → the question in
 * full, thanked unless it thanks them already ("I'm Corin's digital twin. Thanks for asking! How was yours?"). Anything
 * else stays as it is.
 */
export function finishLifeReply(text: string, life: AskedLife): string {
  const t = text.trim();
  if (!/\p{L}/u.test(t)) return lifeFallback(life);
  if (t.length <= SHORT_REPLY_CHARS) {
    if (ONLY_THANKS.test(t)) return `${asSentence(t, '!')} ${lifeTurnBack(life)}`;
    const done = withTurnBack(t, life);
    if (done !== null) return done;
  }
  // Where the last sentence starts: after the sentence end before its own closing punctuation.
  let i = t.length - 1;
  while (i >= 0 && /[\s.!?…"”’)*_]/u.test(t.charAt(i))) i -= 1;
  const at = Math.max(...['.', '!', '?', '…', '\n'].map((c) => t.lastIndexOf(c, i))) + 1;
  if (at === 0 || !TERSE_TURN_BACK.test(t.slice(at))) return text;
  const before = t.slice(0, at).trimEnd();
  return `${before} ${THANKS.test(before) ? '' : 'Thanks for asking! '}${lifeTurnBack(life)}`;
}

/** Thanks (or nothing) and one question turned to the founder, said in full (see {@link finishLifeReply}). */
function withTurnBack(text: string, life: AskedLife): string | null {
  const m = THANKS_AND_QUESTION.exec(text);
  if (m === null) return null;
  const thanks = (m.groups?.thanks ?? '').trim();
  const question = (m.groups?.question ?? '').trim();
  const terse = TERSE_TURN_BACK.test(question);
  if (!terse && !ABOUT_THE_FOUNDER.test(question)) return null;
  if (!terse && thanks !== '') return null;
  const back = terse ? lifeTurnBack(life) : question;
  return `${thanks === '' ? 'Thanks for asking!' : asSentence(thanks, '!')} ${back}`;
}

/**
 * For the sentence gate, after a unit lost a made-up life (`released`: what the reply released so far): the next unit
 * as the whole reply will read once validated ({@link finishLifeReply}): "You?" → "Thanks for asking! How was yours?"
 * (or "How was yours?" after a thanks); after nothing but thanks, a question to the founder thanked ("Did you get a
 * break?" → "Thanks for asking! Did you get a break?"). The unit unchanged when it is something else.
 */
export function lifeUnitAfterRemoval(released: string, unit: string, life: AskedLife): string {
  // A terse "You?" is said in full however the reply began, thanked unless it thanked them already.
  if (TERSE_TURN_BACK.test(unit) && /\p{L}/u.test(released) && !isOnlyThanks(released))
    return `${THANKS.test(released) ? '' : 'Thanks for asking! '}${lifeTurnBack(life)}`;
  if (!isOnlyThanks(released)) return unit;
  const before = released.trim();
  const whole = before === '' ? unit.trim() : `${before} ${unit.trim()}`;
  if (whole.length > SHORT_REPLY_CHARS) return unit;
  const done = withTurnBack(whole, life);
  if (done === null || done === whole) return unit;
  if (before === '') return done;
  return done.startsWith(before) ? done.slice(before.length).trim() : unit;
}

/**
 * For the sentence gate, when the reply ends after a unit lost a made-up life: what it says last so it turns to the
 * founder ("Thanks for asking! How was yours?" after nothing, "How was yours?" after only thanks), or null.
 */
export function lifeClosing(released: string, life: AskedLife): string | null {
  if (!/\p{L}/u.test(released)) return lifeFallback(life);
  return ONLY_THANKS.test(released.trim()) ? lifeTurnBack(life) : null;
}
