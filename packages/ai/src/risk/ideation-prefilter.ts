import { foldDiacritics, foldLeetspeak, normalizeForMatching } from './normalize.js';

/**
 * A broad, high-recall net for indirect self-harm and suicidal-ideation language that the deterministic crisis rules
 * (rules.ts) do not flag on their own: "I'm thinking about ending it", "I won't be around much longer", "this is my
 * last message", "what's even the point anymore", "everyone would be better off if I wasn't here".
 *
 * It never decides anything. A hit only means that the founder's words share vocabulary with ideation, which ordinary
 * venture talk often does ("thinking about ending the pilot", "I can't do this deck anymore", "goodbye for now"), so a
 * hit asks the model-based safety screen (safety-screen.ts) to read the message in context. It may therefore
 * over-match freely; what it must not do is miss a phrasing, so every family is written for voice transcripts
 * (lower case, no apostrophes: "im thinking about ending it", "i dont wanna be here"), common misspellings, slang and
 * leetspeak ("kms", "unalive", "sewerslide", "end 1t all").
 *
 * The result names families only, never text, so it is safe to log.
 */
export interface IdeationPrefilterResult {
  readonly hit: boolean;
  /** The families that matched, in {@link IDEATION_FAMILIES} order. */
  readonly families: readonly IdeationFamily[];
}

export type IdeationFamily =
  | 'ending'
  | 'presence'
  | 'disappear'
  | 'meaning'
  | 'burden'
  | 'endurance'
  | 'farewell'
  | 'sleep'
  | 'self_harm'
  | 'means'
  | 'withdrawal'
  | 'dark_thoughts'
  | 'multilingual';

/** Hard cap on analysed characters (a turn's text is ≤ 8 000 characters by schema). */
const MAX_ANALYSED_CHARS = 20_000;

/** An optional gap of up to `n` whole words, each with the space before it: `X${G(2)} Y` reads "X a b Y". */
const G = (n: number): string => `(?: [\\p{L}\\p{N}]+){0,${n}}`;
/** "i", "im", "ive", "id", "ill" once apostrophes are removed. */
const I = '(?:i|im|ive|id|ill|i am|i have)';
/** Phrases that may close a sentence after the phrase itself ("what is even the point anymore honestly"). */
const TAIL =
  '(?: (?:anymore|any more|honestly|really|tbh|lol|at all|now|either|man|dude|i guess|right|already|forever|for good|please|tonight))*';

/**
 * Ordinary sign-offs: a plain "goodbye" in a message that also says one of these is a wrap-up ("thanks, goodbye",
 * "goodbye for now, see you Tuesday"). A final goodbye is still caught by its own phrasings ("this is goodbye",
 * "goodbye forever", "thank you for everything", "my last message").
 */
const SIGN_OFF =
  '\\b(?:thanks|thank you|thx|ty|see you|see ya|talk (?:soon|later|tomorrow|to you)|for now|for today|tomorrow|next (?:week|time|call|session)|later|have a (?:good|great|nice|lovely)|bye bye|cheers|catch you)\\b';

/**
 * A family's pattern: a regex source, or one that does not count when the whole message (flattened) matches
 * `unlessMessage`.
 */
type FamilyPattern = string | { readonly pattern: string; readonly unlessMessage: string };

/**
 * Families of indirect ideation, matched on one flattened sentence at a time (lower case, accents and apostrophes
 * removed, every other non-letter a single space; see {@link flatten}). `^` and `$` are the sentence's edges.
 */
const IDEATION_FAMILIES: Readonly<Record<IdeationFamily, readonly FamilyPattern[]>> = {
  // "ending it", "end it all", "end things", "I want it all to be over", "I want the pain to stop".
  ending: [
    `\\bend(?:ing|in|ed|s)? (?:it|things|everything|my life|my own life|myself|this life|it all|all of (?:it|this))\\b`,
    `\\b(?:it all|all of (?:this|it)|all this|everything|this life|my life|life|the pain|the hurting|the hurt|the suffering|the thoughts|the voices)${G(1)} (?:to|would|will|could) (?:just )?(?:end|stop|be over|go away|finish)\\b`,
    `\\b(?:want|need|wish|wanna)${G(2)} (?:it|this|that)${G(1)} (?:to )?(?:end|stop|be over|go away)${TAIL}$`,
    `\\b(?:it|itll|this|it all|everything|all this|all of this)(?: (?:will|would|is|ll|might|should|all|just|finally|soon))*(?: be)? (?:all )?over (?:for me|soon|tonight|forever)\\b`,
    `\\b(?:finish|finished|finishing) (?:it all|myself|everything)\\b`,
    `\\b(?:call|calling) it quits on (?:life|living|everything)\\b`,
  ],
  // "I don't want to be here/around/alive", "I won't be around much longer", "if I wasn't here", "never born".
  presence: [
    // "I don't want to be pushy" is no hit: "be" counts only with here, around or alive.
    `\\b(?:dont|do not|didnt|no longer|never|not)${G(2)} (?:want|wanna|wish|like|deserve|need|care)${G(2)} (?:(?:be|being|stay|staying) (?:here|around|alive)\\b|exist\\b|existing\\b|(?:live|living|keep living|go on|wake up)(?: (?:anymore|any more|any longer|tomorrow|like this|again|this life))?${TAIL}$)`,
    `\\b(?:dont|do not|didnt|never|no longer|not|shouldnt)${G(3)} (?:be|being|exist|existing|live|living|stay|staying) (?:here|around|alive|on this earth|in this world)\\b`,
    `\\b(?:wont|will not|not going to|not gonna|might not|may not) be (?:here|around)(?:${TAIL}$| (?:much longer|for long|long|for much longer|anymore|any more|soon|by|after|to see|for you|next year|this time next))`,
    `\\b(?:live|living|exist|existing|alive|be here|be around)(?: like this)? (?:anymore|any more|any longer)\\b`,
    `\\bif (?:${I} )?(?:was|were|wasnt|werent|am|m|d|had)${G(2)} (?:gone|dead|here|around|alive|born)\\b`,
    `\\bif (?:${I} )?(?:died|disappeared|vanished|was gone|were gone|was dead|was never born|never existed|didnt exist|didnt wake up|never woke up|was no longer|left for good|wasnt here|werent here|wasnt around|werent around)\\b`,
    `\\bwhen (?:${I} )?(?:(?:m|am|is|was) )?(?:gone|dead|no longer here|no longer around)\\b`,
    `\\b(?:never|not) (?:been |be |being )?born\\b`,
    `\\bwish (?:${I} )?(?:was|were|wasnt|werent|had|d|could|would)${G(3)} (?:dead|alive|born|gone|here|around|exist|disappear|vanish|die|died)\\b`,
  ],
  // "I want to disappear", "nobody would notice if I disappeared", "stop existing".
  disappear: [
    `\\b(?:i|me|myself|im|ill|id)(?: (?:just|really|honestly|sometimes|kinda|kind of|want|wanna|wish|could|would|should|to|need|have|gonna|going|feel like|like|literally|simply|already|might|may|will|hope|can|cant|d|ll))* (?:dis{1,2}ap{1,2}ea?r|vanish)\\w*`,
    `\\b(?:dis{1,2}ap{1,2}ea?r|vanish)\\w* (?:forever|for good|completely|from (?:this|the) (?:world|earth|planet)|into|and never|without a trace|for ever)\\b`,
    `\\b(?:cease to exist|stop existing|not existing)\\b`,
    `\\b(?:i|me|wish|want|wanna|rather)${G(3)} (?:not exist|didnt exist|never existed|dont exist)\\b`,
  ],
  // "what's the point (of any of this / anymore)", "no reason to go on", "nothing left to live for".
  meaning: [
    `^(?:[\\p{L}\\p{N}]+ ){0,5}(?:whats|what is|wheres|where is|is there|there is no|theres no|no|whats even|what is even|is there even|is there any|no real)(?: even| any| really| a)? (?:the )?(?:point|use|reason|purpose|meaning)(?: (?:of|in|to|for) (?:any of (?:this|it)|it all|all this|all of (?:this|it)|anything|everything|life|living|me|my life|being alive|existing|trying|even trying|going on|waking up|getting up|carrying on|being here|continuing|me being here))?(?: in the morning)?${TAIL}$`,
    `\\b(?:point|reason|purpose|meaning|use|will) (?:of|in|to|for) (?:living|live|life|my life|being alive|existing|exist|going on|go on|keep going|waking up|getting up|me being here|carrying on)\\b`,
    `\\b(?:nothing|no one|nobody|noone|nothing left|nothing more)${G(2)} (?:to live for|worth living|to stay for|to keep going for)\\b`,
    `\\b(?:not|isnt|is not|aint|wasnt) worth (?:living|it anymore|it any more|going on|staying)\\b`,
    `\\b(?:lost|lose|losing) (?:the |my |all )?(?:will|reason|desire|want) to (?:live|go on|keep going|be alive)\\b`,
    `\\b(?:no|any) point (?:anymore|any more|any longer)\\b`,
    `\\b(?:no|any|what|the) (?:real )?(?:reason|point|purpose) (?:for me )?(?:to|in|of) (?:be|being|stay|staying|live|living|exist|existing|go on|going on|keep going|wake up|get up|carry on)\\b`,
    `\\b(?:its all|it all|everything|life|living|existence|my life|its|it|all of this|this all)(?: (?:just|all|so|kinda|really))? (?:is |feels |seems )?(?:so |completely |totally |just )?(?:pointless|meaningless)${TAIL}$`,
    `\\b(?:im|i am|i feel)(?: so| just| completely| totally)? (?:pointless|meaningless|worthless)\\b`,
    `\\b(?:what|who) (?:am i|is there|do i have)${G(2)} (?:living for|alive for|to live for|staying for)\\b`,
  ],
  // "everyone would be better off without me", "nobody would miss me", "a burden", "you won't have to worry about me".
  burden: [
    `\\bbetter off (?:without me|if ${I}|dead|with me gone|when ${I}|without my)`,
    `\\b(?:happier|better|easier|lighter|simpler|fine) (?:off )?(?:without me|if (?:${I} )?(?:was|were|wasnt|werent|d|had|never|didnt|disappeared|died|left|was not|were not|am not|m not)\\b)`,
    `\\bwithout me in (?:it|the picture|their lives|the world)\\b`,
    `\\b(?:miss|missed|notice|noticed|care|cared|matter|mattered|mourn)\\w* if ${I}\\b`,
    `\\b(?:nobody|no one|noone|who would|would anyone|would anybody)${G(2)} (?:miss|misses|notice|notices|care|cares|mourn|cry)(?: (?:about|for|if|that|when))? (?:me|i|im|my absence)\\b`,
    `\\b(?:nobody|no one|noone|would anyone|would anybody)${G(2)} (?:miss|misses|notice|notices|care|cares|mourn|cry)${TAIL}$`,
    `\\b(?:a|such a|the|just a|being a|be a|only a|another|huge|big)${G(1)} burden\\b(?! of (?:proof|evidence|compliance|regulation|reporting))`,
    `\\b(?:wont|will not|dont|wouldnt|would not|never|no longer|not)${G(1)} (?:have|need|gotta) to (?:worry about|deal with|put up with|see|hear from|bother with|carry|take care of|think about) me\\b`,
    `\\b(?:nobody|no one|noone|everyone|you|they)${G(2)} (?:will|would|wont|will not) (?:have to |need to )?(?:deal with|worry about|be rid of|be free of) me\\b`,
    `\\b(?:rid of me|free of me|without me around)\\b`,
  ],
  // "I can't do this anymore", "can't take it anymore", "I can't keep going", "at my breaking point".
  endurance: [
    // What the speaker cannot bear, not what they cannot do alone or handle at work ("I can't do this alone").
    `\\b(?:cant|cannot|can not|unable to|couldnt)(?: (?:just|really|honestly|even|seriously|literally|simply))? (?:(?:do|take|handle|stand|bear|face) (?:it|this|any of this|life)(?: (?:anymore|any more|any longer|like this)|${TAIL}$)|take (?:any more|anymore|much more)|keep (?:going|doing this|doing it|living|pretending|fighting)|keep on(?: (?:going|living))?${TAIL}$|go on(?: (?:like this|anymore|any more|any longer|living))?${TAIL}$|cope|carry on|anymore|any more|breathe|live like this|face (?:tomorrow|another day)|fight (?:it|anymore|any more)|stand myself|hold on(?: (?:anymore|any more|much longer))?${TAIL}$)`,
    `\\b(?:breaking point|end of my rope|at my limit|end of the road for me|cant anymore|cant even anymore)\\b`,
    `\\b(?:dont|do not|no longer) (?:wanna|want to)${G(1)} (?:live like this|keep going|go on|keep living|continue|fight anymore|fight any more)\\b`,
    `\\btired of (?:fighting|living|life|existing|being alive|everything|it all|trying)(?: (?:it|this|anymore|any more|everything|everyone|all of this))?${TAIL}$`,
    `\\btired of (?:living|life|existing|being alive|being me)\\b`,
  ],
  // "this is goodbye", "my last message", "thank you for everything", "you won't hear from me again".
  farewell: [
    { pattern: `\\bgood ?bye\\b`, unlessMessage: SIGN_OFF },
    `\\b(?:farewell|bye forever)\\b`,
    `\\b(?:last|final) (?:message|goodbye|words|note|letter|thing (?:i|youll))\\b`,
    `\\blast time (?:youll|you will|anyone will|anyone|you are going to|youre going to)${G(1)} (?:hear|see|talk)\\b`,
    `\\bthis is (?:it for me|goodbye|the end|my goodbye|my last)\\b`,
    `\\bthank(?:s| you) for (?:everything|trying|being there|all you(?:ve)? done)\\b`,
    `\\b(?:wont|will not|never)${G(1)} (?:see|talk to|hear from|speak to|bother) (?:me|you) again\\b`,
    `\\b(?:tell|let) (?:my|them|everyone|her|him)${G(3)} (?:i love|im sorry|sorry|i loved)\\b`,
    `\\bsorry for everything\\b`,
  ],
  // "go to sleep and never wake up", "I hope I don't wake up tomorrow", "not waking up".
  sleep: [
    `\\b(?:never|not|dont|didnt|wont|stop|no longer|do not|did not)${G(2)} wak(?:e|ing) up\\b(?! (?:early|on time|in time|before|at|until|till|late|for (?:the|my|class|work)))`,
    `\\bsleep (?:forever|for ever|and (?:never|not|dont))\\b`,
    `\\b(?:go|went|going) to sleep and\\b`,
    `\\beternal (?:sleep|rest)\\b`,
  ],
  // Self-harm and dying in the speaker's words, slang, algospeak and misspellings.
  self_harm: [
    `\\b(?:hurt|harm|cut|burn|starve|punish|kill|kil|off|unalive|end|drown|poison|shoot|hang|stab)\\w* my ?self\\b`,
    `\\b(?:kill|unalive|end) me (?:now|already|please|pls)\\b|\\bjust (?:kill|end) me\\b`,
    `(?<![\\p{N}] )\\bkms\\b`,
    `\\b(?:unalive|unaliving|sewer ?slide|sewerslide|delete myself)\\b`,
    `\\bsu+[i1!l]+c+[i1!l]+d\\w*`,
    `\\bself ?harm\\w*`,
    `\\b(?:want|wanna|wanting|going|gonna|ready|wish|wishing|plan|planning|deserve|deserves)${G(1)} (?:to |2 )?(?:d[i1]e|be dead)\\b`,
    `\\b(?:think|thinking|thinkin|thought|thoughts|dream|dreaming|fantasi[sz]e|fantasi[sz]ing)\\w* (?:about|of|bout) (?:dying|death|being dead|killing|hurting|my death|my funeral|suicide)\\b`,
    `\\b(?:dying|die) (?:every day|soon|tonight|alone)\\b`,
    `\\bbe dead\\b`,
  ],
  // Means and acts: pills, jumping, a rope, a gun; the subject is often dropped ("took a bottle of pills").
  means: [
    // "patients take their medication" is no hit: only quantities and the speaker's own pills.
    `\\b(?:took|take|taking|swallow|swallowed|swallowing|ate|downed|overdos\\w*|od|oded|stockpil\\w*|hoard\\w*|saving up|save up)(?: (?:a|an|the|all|of|my|whole|entire|bunch|handful|lot|lots|every|box|pack|packet|load|ton|few|some|extra|more|too many|double|at once))* (?:pills|meds|medication|medications|tablets|bottle|tylenol|paracetamol|acetaminophen|ibuprofen|sleeping pills|xanax|opioids|everything i have)\\b`,
    `\\b(?:jump|jumping|jumped|fall|falling|throw myself|throwing myself|leap|leaping)(?: off| from| out of| in front of| into| onto| out)+${G(3)} (?:bridge|roof|rooftop|building|ledge|cliff|window|balcony|train|bus|truck|car|traffic|sea|ocean|river|lake|water|tracks|highway|freeway|subway|tower)\\b(?! (?:acquisition|analytics|numbers|data|growth|sources|metrics|reports?|committee|project|team|board|permits?|codes?|industry|market|startups?))`,
    `\\b(?:walk|walking|walked|step|stepping|stepped|drive|driving|drove|crash|crashing|swim|swimming|lie|lying|lay|run|running|ran)(?: out)? (?:into|in front of|under|onto|off)${G(3)} (?:train|bus|truck|car|traffic|sea|ocean|river|lake|tracks|highway|freeway|subway|bridge|cliff)\\b(?! (?:acquisition|analytics|numbers|data|growth|sources|metrics|reports?|industry|market|startups?))`,
    `\\b(?:standing|stand|sitting|sit|stood|sat) on (?:the |a |my |this )?(?:bridge|roof|rooftop|ledge|edge|tracks|balcony)\\b`,
    `\\b(?:bought|got|loaded|holding|tied|found)${G(2)} (?:rope|noose|gun|pistol|razor blades|razors)\\b`,
    `\\b(?:with|using) (?:my |a |the |dads |his |moms |her )?(?:gun|pistol|rope|pills|razor|blades)\\b`,
    `\\bnoose\\b`,
    `\\bwrote (?:a |my )?(?:note|letter|will) (?:for|to) (?:my|everyone|them)\\b`,
    `\\b(?:gave|giving|give|given) away (?:all )?(?:my|of my)${G(1)} (?:stuff|things|belongings|possessions|clothes|books)\\b`,
    `\\b(?:made up my mind|my mind is made up|planning how to do it|plan how to do it|how (?:i|im|ill) (?:would |will |am going to |going to |gonna )?do it)\\b`,
    `\\bmy (?:own )?funeral\\b`,
  ],
  // "I'm done with life / with it all / with everything", "give up on everything", "I just want out", "no way out".
  withdrawal: [
    `\\bgiv(?:e|ing|en)? up on (?:everything|life|living|myself|it all|me|all of it|the world)\\b`,
    `\\b(?:done|finished|through|over) with (?:it all|everything|everyone|life|living|this life|all of (?:it|this)|myself|this world|the world|existing|being alive|people)\\b`,
    `\\b(?:done|tired|sick|exhausted) (?:of|with) (?:life|living|existing|being alive|being me|this life|my life)\\b`,
    `^(?:[\\p{L}\\p{N}]+ ){0,3}${I} (?:just |so |really |honestly )?done(?: (?:now|honestly|tbh|for good|man|anymore))?$`,
    `\\b(?:just |really |all i )?want(?:s|ed)? out(?:${TAIL}$| of (?:this life|life|here|it all|everything|this world|existence|my life)\\b)`,
    `\\b(?:no|any|the only|a)${G(1)} way out\\b`,
    `\\b(?:hate|hating|despise|loathe) (?:my ?self|my life|who i am|being alive|being me|living|existing|this life)\\b`,
  ],
  // "dark thoughts", "intrusive thoughts", "I'm not okay".
  dark_thoughts: [
    `\\b(?:dark|darkest|intrusive|morbid|scary) (?:thoughts|place|thinking|urges)\\b`,
    `\\bthoughts (?:of|about) (?:dying|death|ending|suicide|hurting|not being)\\b`,
    `\\b(?:not|never) (?:going to be |gonna be )?(?:ok|okay|alright|all right) (?:anymore|any more|again)\\b`,
    `\\b(?:i am|im) not (?:ok|okay|alright|all right)(?: (?:at all|really|honestly|tbh|right now|anymore|lately))*$`,
    `\\b(?:urges?|plan|plans|planning|plotting) to (?:hurt|harm|end|kill)(?: (?:my ?self|me|it all|my life|everything)\\b|${TAIL}$)`,
  ],
  // Common phrasings in the program's other languages that rules.ts does not hold.
  multilingual: [
    `\\b(?:mejor|mejores) sin mi\\b`,
    `\\b(?:en finir|disparaitre|plus envie de vivre|j en peux plus|je n en peux plus|marre de vivre)\\b`,
    `\\b(?:acabar con todo|ya no puedo mas|no puedo mas|no aguanto mas|desaparecer|no quiero estar aqui|terminar con todo)\\b`,
    `\\b(?:kann nicht mehr|will nicht mehr|nicht mehr da sein|verschwinden|besser ohne mich)\\b`,
    `\\b(?:nao aguento mais|sumir|melhor sem mim|acabar com tudo)\\b`,
    `\\b(?:non ce la faccio piu|sparire|meglio senza di me|farla finita)\\b`,
  ],
};

interface CompiledFamily {
  readonly family: IdeationFamily;
  /** Every plain pattern of the family as one alternation (null when it has none). */
  readonly plain: RegExp | null;
  readonly conditional: readonly { readonly pattern: RegExp; readonly unlessMessage: RegExp }[];
}

const FAMILY_ORDER = Object.keys(IDEATION_FAMILIES) as IdeationFamily[];
const COMPILED: readonly CompiledFamily[] = FAMILY_ORDER.map((family) => {
  const patterns = IDEATION_FAMILIES[family];
  const plain = patterns.filter((p): p is string => typeof p === 'string');
  return {
    family,
    plain: plain.length === 0 ? null : new RegExp(plain.map((source) => `(?:${source})`).join('|'), 'u'),
    conditional: patterns
      .filter((p): p is Exclude<FamilyPattern, string> => typeof p !== 'string')
      .map((p) => ({ pattern: new RegExp(p.pattern, 'u'), unlessMessage: new RegExp(p.unlessMessage, 'u') })),
  };
});

/**
 * One sentence as the families read it: apostrophes dropped (`don't` → `dont`, `I'm` → `im`), every other run of
 * non-letters (punctuation, emoji, digits standing alone) a single space, trimmed.
 */
function flatten(sentence: string): string {
  return sentence
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Sentences of a message (split at `.`, `!`, `?`, `;`, `…` and line breaks), each flattened, plus the whole message
 * flattened (a phrase a voice transcript runs across a stray full stop).
 */
function sentencesOf(lower: string): string[] {
  const parts = lower
    .split(/[.!?;…\n]+/u)
    .map(flatten)
    .filter((s) => s !== '');
  const whole = flatten(lower);
  return whole === '' ? parts : [...parts, whole];
}

/**
 * Whether a founder message uses language that may be indirect suicidal ideation or self-harm, which the deterministic
 * rules do not flag (see the module comment). Read with accents removed and again with leetspeak folded.
 */
export function ideationPrefilter(text: string): IdeationPrefilterResult {
  if (typeof text !== 'string' || text.trim() === '') return { hit: false, families: [] };
  const bounded = text.length > MAX_ANALYSED_CHARS ? text.slice(0, MAX_ANALYSED_CHARS) : text;
  const lower = foldDiacritics(normalizeForMatching(bounded));
  const leet = foldLeetspeak(lower);
  const variants = leet === lower ? [lower] : [lower, leet];
  const sentences = variants.flatMap(sentencesOf);
  const wholes = variants.map(flatten);
  const families = COMPILED.filter(
    ({ plain, conditional }) =>
      (plain !== null && sentences.some((s) => plain.test(s))) ||
      conditional.some(
        ({ pattern, unlessMessage }) =>
          sentences.some((s) => pattern.test(s)) && !wholes.some((w) => unlessMessage.test(w)),
      ),
  ).map(({ family }) => family);
  return { hit: families.length > 0, families };
}
