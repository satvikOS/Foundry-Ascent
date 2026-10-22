/**
 * A life of the coach's own, told when the founder asks about it (evals MX-0032: "lowkey, how was your weekend?" got
 * "Weekend was good, thanks for asking."). Read only in reply to the founder's own question about the coach's own
 * weekend, day, week, holiday, evening or plans ({@link askedLifeOf}); a plain "how are you?" is not one, nor the
 * founder's own plans ("should I make any plans for the weekend?"), a market's season ("How was Christmas for retailers
 * like us?"), a question they report from someone else ("my manager always asks how was your weekend"), want words for
 * ("Jo emailed me: how was your weekend? … draft my reply") or play ("roleplay: you're my investor"). Without such a
 * question nothing here applies: the prompt's banter rule keeps the coach from making a life up, and the identity rule
 * `personal_life` keeps its plain first-person forms out ("My weekend was good"), as it always did. The founder's own
 * story, bio, pitch, customer quote or draft is never read here (a question about the coach must come first, and a
 * draft or a quote, straight single quotes too, is never the coach's own voice).
 *
 * The identity validator (identity.ts, rule `personal_life`) takes such a sentence out of the reply (typed, spoken and
 * each streamed unit), keeps an honest answer about what the coach is and the founder's thanks, and turns the question
 * back to them ({@link lifeLeftover}, {@link finishLifeReply}). When the founder also told news of their own or asked
 * something else ("how was your weekend? my dog died on saturday"), only "Mine…", the first person or a sentence that
 * thanks them counts, only the made-up clause goes where the rest of its sentence answers them ({@link lifeRest}:
 * "Mine was quiet, but I'm so sorry about your dog." → "I'm so sorry about your dog."), a sentence whose rest leans on
 * the life stays whole ("Mine's been good, thanks — sorry yours hasn't."), and no thanks is put before their news. The
 * evals matrix presence check (G14, evals/foundry_evals/matrix/asked_life.py `asked_life_claim`) fails the same
 * sentences; the cases both must agree on are `asked_life` in evals/tests/fixtures/identity_cases.json, every input an
 * earlier, wider rule cut from the founder's own words stays as it was (evals/tests/fixtures/presence_regressions.json),
 * and so does every one this rule's first round cut, or it loses only the made-up life
 * (evals/tests/fixtures/asked_life_regressions.json).
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
 * - `reaction`: without a verb, where the reply opens and as all its sentence says ("Quiet weekend, thanks!", "A
 *   relaxing one");
 * - `bare`: how the time went, said bare where the reply opens ("Good, thanks!", "Not bad at all!", "Yes, lovely
 *   thanks"), only to how a time of the coach's went;
 * - `fragment`: what it did, named where the reply opens and as all its sentence says ("Probably a long walk and
 *   catching up on some reading.", never "Hiking, reading, whatever recharges you — do that this weekend.").
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
/** Where a question of its own opens: the message's start or after a break, past a few fillers ("so", "hey"). */
const OPENS = `(?:^|(?<=[.!?…,\\n])\\s*)(?:(?:and|so|hey|hi|also|oh|btw|ok|okay|lowkey|ngl|anyway|wbu|hbu)[\\s,!]+)*`;
/** Where such a question closes: its punctuation, or the end of the message. */
const CLOSES = '(?=\\s*(?:[?!.…]|$))';
/**
 * A holiday asked about without "your", as a question of its own ("how was thanksgiving?", "how were the holidays?"):
 * never "How was Christmas for retailers like us", nor "how was the holidays for your other founders?".
 */
const NAMED_HOLIDAY = `(?:(?:the\\s+)?(?:holidays?|long\\s+weekend|bank\\s+holiday)|christmas|thanksgiving|easter|new\\s+year)${LIFE_TIME_END}(?:\\s+go)?${CLOSES}`;
/** Plans of a kind or a time ("fun plans", "plans for the weekend", "weekend plans tonight"); never "plans for the pilot". */
/** When, after a question about the coach's time ("… anything fun over the weekend", "… anywhere for the holidays"). */
const WHEN = `(?:\\s+(?:(?:this|over|for|on|at|next|last)\\s+(?:the\\s+)?)?(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END})?`;
const PLANS = `(?:(?:fun|exciting|nice|big|weekend|holiday|summer|christmas|evening|vacation)\\s+plans(?:\\s+(?:(?:for|this|over|on)\\s+(?:the\\s+)?(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}|tonight|later|tomorrow))?|plans\\s+(?:(?:for|this|over|on)\\s+(?:the\\s+)?(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|tonight|later|tomorrow)|tonight|later|tomorrow))(?![\\p{L}])`;

/** Asks how a time of the coach's own went: "your" weekend, never "the" week or launch (the founder's own). */
const ASKED_PAST_SOURCES = [
  `how\\s*(?:${APOS}?d|\\s+was|\\s+were|\\s+did)\\s+(?:${YOUR}\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}|${NAMED_HOLIDAY})`,
  `(?:did|have)\\s+${YOU}\\s+(?:have|get|enjoy|had)\\s+(?:a|an|any|some)\\s+(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|rest|fun|one${NL})`,
  `${YOU}\\s+(?:have|had|get)\\s+(?:a|an)\\s+${LIFE_ADJS}(?:${LIFE_TIME}${LIFE_TIME_END}|one)\\s*\\?`,
  // "good weekend?", "nice holiday?" as a question of its own.
  `${OPENS}${LIFE_ADJS}${LIFE_TIME}\\s*\\?`,
  // A wish that invites the same answer ("hope you had a nice weekend!", "hope your weekend was good").
  `hope\\s+(?:${YOU}(?:${APOS}ve|\\s+have)?\\s+had\\s+(?:a|an|such\\s+a)\\s+(?:${LIFE_ADJS})?(?:${LIFE_TIME}${LIFE_TIME_END}|one${NL})|${YOUR}\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}\\s+(?:was|went|has\\s+been))`,
  `(?:did|have)\\s+${YOU}\\s+(?:do|get\\s+up\\s+to|been\\s+up\\s+to|done)\\s+(?:anything|something)\\s+(?:fun|nice|good|exciting|interesting|cool|special)${WHEN}`,
  `what\\s+did\\s+${YOU}\\s+(?:get\\s+up\\s+to|do\\s+(?:(?:this|last|over\\s+the|on\\s+the|on|for|at)\\s+)?(?:${LIFE_TIME}${LIFE_TIME_END}|yesterday|last\\s+night))`,
];
/**
 * Asks about the coach's own day, evening or plans, or how its life goes ("how's your day going?", "any plans this
 * weekend?"). Plans asked without "you" only as a question of their own: "should I make any plans for the weekend?" and
 * "I'm not doing anything fun this weekend" are the founder's own.
 */
const ASKED_OTHER_SOURCES = [
  `how\\s*(?:${APOS}?s|\\s+is|\\s+has|\\s+are)\\s+${YOUR}\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}(?:\\s+(?:going|been|looking|so\\s+far))?`,
  `how${APOS}?s\\s+life(?:\\s+treating\\s+${YOU})?|how\\s+is\\s+life`,
  `(?:what\\s+are\\s+${YOUR}|${YOU}\\s+(?:got|have)\\s+any)\\s+${PLANS}`,
  `${OPENS}(?:got\\s+)?any\\s+${PLANS}${CLOSES}`,
  `what\\s+(?:are|r)\\s+${YOU}\\s+(?:up\\s+to|doing)\\s+(?:(?:this|over\\s+the|on\\s+the|for\\s+the|at\\s+the|next)\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END}|tonight|later|tomorrow|today)`,
  `what\\s+(?:are|r)\\s+${YOU}\\s+up\\s+to\\s*(?:[?!.]|$)`,
  `(?:are|r)\\s+${YOU}\\s+(?:going|travel(?:l)?ing|heading|getting)\\s+(?:anywhere|away|on\\s+(?:holiday|vacation|a\\s+trip))${WHEN}`,
  `(?:(?:(?:are|r)\\s+)?${YOU}\\s+|${OPENS})(?:doing|up\\s+to)\\s+anything\\s+(?:fun|nice|good|exciting|special)\\s+(?:(?:this|over\\s+the|for\\s+the|on\\s+the)(?:\\s+(?:${LIFE_ADJS})?${LIFE_TIME}${LIFE_TIME_END})?|tonight|later)`,
];

function questionRegex(sources: readonly string[], flags: string): RegExp {
  return new RegExp(sources.map((s) => `(?<![\\p{L}'’])(?:${s})`).join('|'), flags);
}

const ASKED_PAST = questionRegex(ASKED_PAST_SOURCES, 'giu');
const ASKED_OTHER = questionRegex(ASKED_OTHER_SOURCES, 'giu');
const ASKED_ANY = questionRegex([...ASKED_PAST_SOURCES, ...ASKED_OTHER_SOURCES], 'giu');

/**
 * Small talk that goes with such a question and asks nothing else ("anything fun?", "what's up?", "how are you?"): not
 * a question of the founder's own business.
 */
const SMALL_TALK_TOO = new RegExp(
  `(?<![\\p{L}'’])(?:${OPENS}(?:(?:did|do|are|r)\\s+${YOU}\\s+)?(?:do\\s+|doing\\s+|get\\s+up\\s+to\\s+)?(?:anything|something)\\s+(?:fun|nice|good|exciting|interesting|special|cool)(?:\\s+(?:planned|happen(?:ing|ed)?))?|how\\s+(?:are|r)\\s+${YOU}(?:\\s+doing)?|what${APOS}?s\\s+(?:up|new|good)|how${APOS}?s\\s+it\\s+going)\\s*\\?`,
  'giu',
);

/** What the founder's message asks about the coach's own life, and whether it tells or asks something else. */
export interface AskedLife {
  /** How a time of the coach's went (`past`: "how was your weekend?"), or its day, plans or life (`other`). */
  readonly asked: 'past' | 'other';
  /**
   * The message tells something of the founder's own besides asking ("how was your weekend? mine was busy", "…we sold
   * out"): a life said without "I" may then be a reaction to theirs, so only "Mine…", the first person, or a sentence
   * that thanks them for asking counts, and a sentence that also answers their news keeps that answer.
   */
  readonly news: boolean;
  /**
   * The message also asks something of the founder's own ("what are you up to this weekend? should I go to the farmers
   * market?"): read as `news` is, since the reply answers that question too.
   */
  readonly more: boolean;
}

/** A quoted passage in the founder's message (someone else's words: "my customer asked 'how was your weekend?'"). */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu;
/**
 * A message about someone else's question, not the coach's: the founder wants words to send or say ("draft my reply",
 * "what do I say", "how do I answer"), or plays a part ("roleplay: you're my investor. I'll start.").
 */
const NOT_TO_THE_COACH =
  /(?<![\p{L}'’])(?:(?:draft|write|compose)\s+(?:(?:a|an|my|the|our)\s+)?(?:reply|response|answer|email|e-mail|message|text|note|dm)|(?:what|how)\s+(?:do|should|would|can|could|might)\s+i\s+(?:say|reply|respond|answer|write|put|text|tell)|(?:know|knowing|sure)\s+(?:what|how)\s+to\s+(?:say|reply|respond|answer|write)|help\s+me\s+(?:reply|respond|answer|write)|role[\s-]?play(?:ing)?|pretend(?:ing)?\s+(?:to\s+be|you|you['’]re|that)|in\s+character|(?:act|acting|play|playing)\s+(?:as\s+)?(?:the|my|a|an)\s+(?:investor|customer|buyer|client|manager|boss|vc|cofounder|co-founder|interviewer|prospect|recruiter)|you(?:['’]re|\s+are)\s+(?:my|the|a|an)\s+(?:investor|customer|buyer|client|manager|boss|vc|cofounder|co-founder|interviewer|prospect|recruiter)|i['’]ll\s+(?:start|go\s+first)|let['’]?s\s+(?:practi[cs]e|rehearse)|mock\s+(?:call|pitch|interview|meeting))(?![\p{L}])/iu;
/** Words that report a question someone else asked ("my manager always asks", "Jo emailed me:", "a customer said"). */
const REPORTED =
  /(?<![\p{L}'’])(?:ask(?:s|ed|ing)?|says?|said|saying|wr(?:ote|ites?|iting)|e-?mail(?:s|ed|ing)?|text(?:s|ed|ing)?|messag(?:e|es|ed|ing)|dm(?:s|ed|['’]d)?|replied|repl(?:y|ies)|respond(?:s|ed)?|answer(?:s|ed)?|goes)(?![\p{L}'’])/giu;
/** The founder asking it themselves ("I wanted to ask", "let me ask", "can I ask"). */
const ASKING_MYSELF = /^(?:i|i['’]d|i['’]ll|i['’]m|to|me|just)$/iu;
/** The founder in the first person ("I", "we", "my", "mine"). */
const FOUNDER_SELF = /(?<![\p{L}'’])(?:i|we|my|our|mine|ours)(?![\p{L}])/iu;
/** A time, or something done in it: with the founder in the first person, they tell their own. */
const FOUNDER_OWN_TIME = new RegExp(
  `(?<![\\p{L}])(?:${LIFE_TIME}|today|yesterday|went|spent|had|did|got|was|were|sold|ran|made|took|slept|hiked|launched|shipped|signed|closed)(?![\\p{L}])`,
  'iu',
);
/** Words that tell nothing on their own beside a question about the coach ("hey!", "lol", "thanks!", "wbu"). */
const FOUNDER_FILLER =
  /^(?:hi|hey|hello|yo|hiya|morning|evening|afternoon|good|ok|okay|so|also|btw|anyway|lowkey|ngl|lol|haha|ha|thanks|thank|you|u|ya|yours|cheers|there|um|uh|oh|happy|wait|and|by|the|way|then|wbu|hbu|i|just|wanted|meant|to|ask|me|let|can|quick|q|question|curious|this|it|go|going|been|so|far|for|over|weekend|week|day|tonight|today|holidays?|summer|christmas|evening|night|morning|afternoon|(?:mon|tues|wednes|thurs|fri|satur|sun)day)$/iu;
/**
 * A question about what the coach is ("are you a bot?", "is this really Corin?", "are you corin?"), asked beside one
 * about its life.
 */
const ABOUT_WHAT_IT_IS =
  /(?<![\p{L}'’])(?:bot|robot|ai|a\.i\.?|human|person|real|really|actual|actually|machine|chatbot|program|software|twin|alive|sentient)(?![\p{L}])|^[\s,!]*(?:(?:wait|so|hey|hi|also|and|ok|okay|um|lol)[\s,!]+)*(?:(?:are|r)\s+(?:you|u)|is\s+(?:this|it)|am\s+i\s+(?:talking|speaking|chatting)\s+(?:to|with))\s+(?:[\p{L}'’.-]+\s+){0,2}[\p{L}'’.-]+\s*\?+[\s"”’)*_]*$/iu;

function wordsIn(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'’]+$/gu, ''))
    .filter((w) => w !== '');
}

/** The founder asks it themselves: no one else's words report it in its sentence ("my manager always asks how…"). */
function askedByTheFounder(said: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/[.!?\n]/u.test(said.charAt(start - 1))) start -= 1;
  const prefix = said.slice(start, index);
  REPORTED.lastIndex = 0;
  for (const m of prefix.matchAll(REPORTED)) {
    const before = wordsIn(prefix.slice(0, m.index)).slice(-2);
    if (!before.some((w) => ASKING_MYSELF.test(w))) return false;
  }
  return true;
}

/** Which question about the coach's own life `said` asks (the founder's own, not one they report), or null. */
function askedIn(said: string): 'past' | 'other' | null {
  for (const [re, asked] of [
    [ASKED_PAST, 'past'],
    [ASKED_OTHER, 'other'],
  ] as const) {
    re.lastIndex = 0;
    for (const m of said.matchAll(re)) if (askedByTheFounder(said, m.index)) return asked;
  }
  return null;
}

/**
 * What the founder's message asks about the coach's own life ({@link AskedLife}), or null when it asks nothing about
 * it: a question about the coach's own weekend, day, week, holiday, evening or plans ("lowkey, how was your weekend?",
 * "good holiday?", "how's your day going?", "any plans this weekend?", "what are you up to?"). A plain "how are you?",
 * "how did the week go?" (the founder's own week), a wish ("hope your weekend was good!"), the founder's own plans
 * ("should I make any plans for the weekend?"), a market's season ("How was Christmas for retailers like us?"), a
 * question quoted or reported from someone else ("my manager always asks how was your weekend") and a message asking
 * for words to send or a part to play ("Jo emailed me: how was your weekend? … draft my reply", "roleplay: …") are not.
 */
export function askedLifeOf(founderText: string): AskedLife | null {
  const said = founderText.replace(QUOTED, ' ');
  if (NOT_TO_THE_COACH.test(said)) return null;
  const asked = askedIn(said);
  if (asked === null) return null;
  // What the message says besides its questions about the coach and the small talk that goes with them.
  const rest = said.replace(ASKED_ANY, ' ').replace(SMALL_TALK_TOO, ' ');
  const sentences = rest.split(/(?<=[.!?…])\s+|\n+/u).filter((s) => /\p{L}/u.test(s));
  const filler = (s: string): boolean => wordsIn(s).every((w) => FOUNDER_FILLER.test(w));
  const question = (s: string): boolean => /\?[\s"”’)*_]*$/u.test(s);
  // A question about what the coach is, asked without its question mark ("r u human lol."), tells nothing of theirs.
  const news = sentences.some(
    (s) =>
      (FOUNDER_SELF.test(s) && FOUNDER_OWN_TIME.test(s)) ||
      (!question(s) && !filler(s) && !ABOUT_WHAT_IT_IS.test(`${s.trim()}?`)),
  );
  const more = sentences.some((s) => question(s) && !filler(s) && !ABOUT_WHAT_IT_IS.test(s));
  return { asked, news, more };
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
const THANKS_WRITTEN_SOURCE = `(?<![\\p{L}])(?:${THANKS_HEAD}(?:\\s+for\\s+(?:asking|checking\\s+in|the\\s+question|wondering)(?![\\p{L}])|\\s+for\\s+[^.!?…\\n,;:—–()]*[^\\s.!?…\\n,;:—–()])?|cheers|thx|appreciate\\s+(?:you\\s+asking|the\\s+question))(?![\\p{L}])(?!\\s+to(?![\\p{L}]))`;
/**
 * Any thanks to the founder, with what it is for, as written ("thanks for sending the deck"): kept when a life goes.
 * "Thanks for asking" is read first, so a transcript that runs on keeps only that ("thanks for asking slept in and read").
 */
const THANKS_WRITTEN = new RegExp(THANKS_WRITTEN_SOURCE, 'iu');
/** A thanks that opens a text, with the punctuation after it ("thanks — but…" → "but…"). */
const THANKS_OPENING = new RegExp(`^[\\s"“'‘*_(]*${THANKS_WRITTEN_SOURCE}[\\s,;:!.…—–-]*`, 'iu');

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

// What a sentence that told a life says besides, and where a life is not the coach's own ---------------------------

/** A connector that opens what follows a made-up life in its sentence ("Mine was quiet, but 10k MRR is huge."). */
const CONNECTOR_OPENING = /^(?:but|and|so|though|yet|anyway|also|plus|still)(?![\p{L}'’])[\s,;:—–-]*/iu;
/** The founder, or a reaction to their news ("I'm so sorry about your mom", "congrats"). */
const FOR_THE_FOUNDER =
  /(?<![\p{L}'’])(?:you|your|yours|yourself|ya|u|ur|sorry|congrats|congratulations|condolences|glad|proud|well\s+done)(?![\p{L}])/iu;
/** Leans on what went before it: an ellipsis or "too" ("sorry yours hasn't", "hope you had fun too"). */
const LEANS_BACK =
  /(?<![\p{L}'’])(?:too|as\s+well|either|has|have|had|is|was|were|did|does|do|am|are|(?:has|have|had|is|was|were|did|does|do|are)n['’]t)[\s.!?…"”’)*_]*$/iu;

/**
 * What else a sentence that told a made-up life says once the life's clauses are out (`rest`, as cut): `kept`, a
 * clause of its own that answers the founder ("Mine was quiet — but I'm so sorry about your mom." → "I'm so sorry about
 * your mom."; "Mine was fine, thanks — sorry about the exam, that's rough." → "Sorry about the exam, that's rough."),
 * without the thanks or the connector that tied it to the life; `leans`, when that clause leans on the life ("Mine's
 * been good, thanks — sorry yours hasn't."); null when nothing else is said (only thanks or a question turned back) or
 * when what is left is not plainly something else ("Mine was busy too — lots of calls."): the sentence then goes whole.
 * `answers`: the founder also asked something of their own, so a clause after the thanks answers it ("Weekend was good,
 * thanks — £4 is fine." → "£4 is fine.").
 */
export function lifeRest(rest: string, answers: boolean): { kept: string } | 'leans' | null {
  let t = rest.trim();
  const thanked = THANKS_OPENING.test(t);
  t = t.replace(THANKS_OPENING, '');
  const connected = CONNECTOR_OPENING.test(t) || (answers && thanked);
  t = t.replace(CONNECTOR_OPENING, '').replace(THANKS_OPENING, '').trim();
  const said = t.replace(THANKS_GLOBAL, ' ').replace(TURN_BACK_GLOBAL, ' ');
  if (!/\p{L}/u.test(said) || (!connected && !FOR_THE_FOUNDER.test(said))) return null;
  if (LEANS_BACK.test(t)) return 'leans';
  return { kept: upperFirst(t) };
}

/** Words that may follow a verbless life to the end of its sentence ("Hiking, mostly!", "Quiet one here, thanks!"). */
const LIFE_TAIL_WORDS = new Set([
  'mostly',
  'honestly',
  'really',
  'though',
  'overall',
  'actually',
  'probably',
  'just',
  'thanks',
  'thank',
  'cheers',
  'ha',
  'haha',
  'lol',
  'tbh',
  'ngl',
  'here',
  'for',
  'me',
  'at',
  'home',
  'in',
  'the',
  'garden',
  'park',
  'sun',
  'this',
  'morning',
  'afternoon',
  'evening',
  'weekend',
  'today',
  'yesterday',
  'tomorrow',
  'tonight',
  'later',
  'so',
  'far',
  'too',
  'all',
  'round',
  'again',
  'and',
  'then',
  'a',
  'bit',
  'of',
  'lots',
  'loads',
  'plenty',
  'some',
  'little',
]);

/** More of the same life after a verbless one ("Quiet one, mostly reading and a bit of gardening"). */
const MORE_LIFE = new RegExp(`(?<![\\p{L}'’])(?:${LIFE_THING}|${LIFE_DONE}|${LIFE_PLAN})`, 'giu');
/** A condition that ends the sentence ("Probably a hike if the weather holds"). */
const CONDITION_TAIL = /(?<![\p{L}'’])if\s+[^,;:—–]*$/iu;

/**
 * Whether what follows a verbless life to the end of its sentence (`rest`) adds nothing but such words, more of the same
 * life, a condition that says nothing of the founder ("Probably a hike if the weather holds."), thanks or a question
 * turned back: "Hiking, reading, whatever recharges you — do that this weekend." and "Sunshine, a long lunch, no
 * laptop." are advice.
 */
export function onlyLifeTail(rest: string): boolean {
  let said = rest.replace(THANKS_GLOBAL, ' ').replace(TURN_BACK_GLOBAL, ' ');
  const condition = CONDITION_TAIL.exec(said);
  if (condition !== null && !ABOUT_THE_FOUNDER.test(condition[0])) said = said.slice(0, condition.index);
  return wordsIn(said.replace(MORE_LIFE, ' ')).every((w) => LIFE_TAIL_WORDS.has(w.toLowerCase()));
}

/** A verb after an "-ing" in its clause, which makes the "-ing" its subject. */
const GERUND_PREDICATE =
  /^[^,.;:!?…—–\n]*?(?<![\p{L}'’])(?:is|was|are|were|will|would|could|can|should|might|may|must|beats?|helps?|works?|makes?|gives?|keeps?|matters?|sounds?|seems?|feels?|tends?|pays?|wins?)(?![\p{L}'’])/iu;

/**
 * Whether a life told without "I" (`life`) opens with an "-ing" that is the subject of the rest of its clause
 * (`after`): "Going to the farmers market this weekend is a great idea", "Going hiking on Sunday beats another sprint".
 */
export function gerundSubject(life: string, after: string): boolean {
  return (
    /^\s*(?:(?:just|mostly|probably)\s+)?\p{L}+ing(?![\p{L}])/iu.test(life) && GERUND_PREDICATE.test(after)
  );
}

/**
 * Whether `index` sits inside straight single quotes in its paragraph ("Pick one true detail: 'Good, thanks — went
 * climbing on Saturday.'"): a line the founder will say. An apostrophe ("it's") never opens or closes one.
 */
export function inSingleQuotes(text: string, index: number): boolean {
  const from = Math.max(0, index - 600, text.lastIndexOf('\n\n', index) + 1);
  let open = false;
  for (let i = from; i < index; i += 1) {
    if (text.charAt(i) !== "'") continue;
    const wordBefore = /[\p{L}\p{N}]/u.test(text.charAt(i - 1));
    const wordAfter = /[\p{L}\p{N}]/u.test(text.charAt(i + 1));
    if (wordBefore && wordAfter) continue;
    if (!open && !wordBefore && /\S/u.test(text.charAt(i + 1))) open = true;
    else if (open && !wordAfter) open = false;
  }
  return open;
}

/** "Anyway —" opening what is left once the opening life went ("Anyway — how did the pilot calls go?"). */
const LEANING_OPENING = /^(?:(?:so|but|and)\s+)?(?:anyway|anyhow)(?![\p{L}'’])[\s,;:—–-]*/iu;

/** `text` without an "Anyway —" that leaned on the life before it. */
function withoutLeaningOpening(text: string): string {
  const out = text.replace(LEANING_OPENING, '');
  return out === text || !/\p{L}/u.test(out) ? text : upperFirst(out);
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

/** `text` with its first letter capitalised, when it opens with one ("10k MRR is huge" stays as it is). */
export function upperFirst(text: string): string {
  return text.replace(
    /^([\s"“'‘*_(]*)(\p{Ll})/u,
    (_, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`,
  );
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

/** A sentence with its own punctuation, or a line. */
const SENTENCE_GLOBAL = /[^.!?…\n]+(?:[.!?…]+["”’)*_]*|(?=\n)|$)/gu;

/**
 * A reply once its made-up life is out, so it still turns to the founder: nothing left → "Thanks for asking! How was
 * yours?"; only thanks (or a plain "I'm good") → the question turned back after it; thanks (or nothing) and a terse
 * "You?" → the question in full ("Thanks! How was yours?"); a question to the founder alone ("How was yours?", "Did
 * you get a break?") → "Thanks for asking!" before it; a longer reply with a terse "You?" anywhere → the question in
 * full, thanked unless it thanks them before it ("I'm Corin's digital twin. Thanks for asking! How was yours?", "Thanks
 * for asking! How was yours? Also, did the survey go out?"). `opened`: the life that went opened the reply, so an
 * "Anyway —" that leaned on it goes too ("Anyway — how did the pilot calls go?" → "How did the pilot calls go?").
 * Anything else stays as it is.
 */
export function finishLifeReply(text: string, life: AskedLife, opened = false): string {
  let t = text.trim();
  if (!/\p{L}/u.test(t)) return lifeFallback(life);
  if (opened) t = withoutLeaningOpening(t);
  if (t.length <= SHORT_REPLY_CHARS) {
    if (ONLY_THANKS.test(t)) return `${asSentence(t, '!')} ${lifeTurnBack(life)}`;
    const done = withTurnBack(t, life);
    if (done !== null) return done;
  }
  SENTENCE_GLOBAL.lastIndex = 0;
  for (const m of t.matchAll(SENTENCE_GLOBAL)) {
    if (!TERSE_TURN_BACK.test(m[0])) continue;
    const before = t.slice(0, m.index).trimEnd();
    const after = t.slice(m.index + m[0].length);
    const said = fullTurnBack(before, life);
    return `${before}${before === '' ? '' : ' '}${said}${after === '' || /^\s/u.test(after) ? '' : ' '}${after}`;
  }
  return t === text.trim() ? text : t;
}

/**
 * Thanks (or nothing) and one question turned to the founder, said in full (see {@link finishLifeReply}). After the
 * founder's own news, never a "Thanks for asking!" before what answers it ("I'm so sorry — how are you holding up?").
 */
function withTurnBack(text: string, life: AskedLife): string | null {
  const m = THANKS_AND_QUESTION.exec(text);
  if (m === null) return null;
  const thanks = (m.groups?.thanks ?? '').trim();
  const question = (m.groups?.question ?? '').trim();
  const terse = TERSE_TURN_BACK.test(question);
  if (!terse && (life.news || thanks !== '' || !ABOUT_THE_FOUNDER.test(question))) return null;
  const back = terse ? lifeTurnBack(life) : question;
  if (thanks !== '') return `${asSentence(thanks, '!')} ${back}`;
  return life.news ? back : `Thanks for asking! ${back}`;
}

/** The question turned back in full, thanked unless the reply thanked them before it or told its own news. */
function fullTurnBack(before: string, life: AskedLife): string {
  return `${life.news || THANKS.test(before) ? '' : 'Thanks for asking! '}${lifeTurnBack(life)}`;
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
    return fullTurnBack(released, life);
  if (!isOnlyThanks(released)) return unit;
  const before = released.trim();
  // Nothing was released: the life that went opened the reply, and an "Anyway —" that leaned on it goes too.
  const said = before === '' ? withoutLeaningOpening(unit.trim()) : unit;
  const whole = before === '' ? said : `${before} ${said.trim()}`;
  if (whole.length > SHORT_REPLY_CHARS) return said;
  const done = withTurnBack(whole, life);
  if (done === null || done === whole) return said;
  if (before === '') return done;
  return done.startsWith(before) ? done.slice(before.length).trim() : said;
}

/**
 * For the sentence gate, when the reply ends after a unit lost a made-up life: what it says last so it turns to the
 * founder ("Thanks for asking! How was yours?" after nothing, "How was yours?" after only thanks), or null.
 */
export function lifeClosing(released: string, life: AskedLife): string | null {
  if (!/\p{L}/u.test(released)) return lifeFallback(life);
  return ONLY_THANKS.test(released.trim()) ? lifeTurnBack(life) : null;
}
