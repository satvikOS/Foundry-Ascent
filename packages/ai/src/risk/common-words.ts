/**
 * Common English words (and everyday venture-coaching vocabulary) that a venture name must not consist
 * of. Other ventures' names feed the cross-venture guard, which blocks any coaching turn of the tenant
 * whose text contains one as a whole phrase; a venture called "the", "pilot" or "customer discovery"
 * would block nearly every turn of every other venture (denial of service). Static, lower-case,
 * diacritic-free; matched after `normalizeForMatching` + diacritic folding. Deliberately compact: it
 * covers the words that realistically occur in founder questions and coach answers, not a dictionary.
 */
const WORDS = `
a about above across act action actions active actually add after again against age ago agree ahead
air all allow almost alone along already also always am among amount an analysis and another answer
any anyone anything app apps approach are area areas around art as ask asked assumption at available
average away back bad bank base based basic be became because become been before began begin behind
being believe below best better between big bill bit black blue board body book both box brand break
bring brought build building built business but buy by call called came campus can cannot capital car
card care case cases cash cause center central certain chain chance change changes channel charge
check child children choice choose city class clear client clients climate close club coach coaching
code cold college come comes coming common community company compare competition competitor
competitors complete concept consider consumer contact content continue contract control core cost
costs could country course cover create created credit cup current customer customers cut daily data
date day days deal decide decision decisions deep demand design detail develop development device did
different direct discovery do does doing done door down draft drive during each early easy eat
economic edge education effect effort either else email end energy enough enter entire even event
ever every everyone evidence exactly example expect experience experiment experiments expert fact
factor fail failure fair fall family far fast feature features feedback feel few field figure file
final finally financial find fine finish fire firm first fit five fix focus follow food for force
form found founder founders four free friend friends from front full fund funding future gain game
general get give given global go goal goals going good got government great green ground group grow
growth guide had half hand happen hard has have he head health hear help her here high him his hold
home hope hospital hour hours house how however human hypothesis idea ideas if impact important in
include income increase industry information innovation inside insight instead interest interview
interviews into investor investors is issue issues it item its job jobs join just keep key kind know
knowledge lab labs land language large last late later launch law lead leader learn least leave left
legal less let level life light like likely line list little live local long look loop lose loss lot
love low machine made main make maker making manage management manager many market marketing markets
material matter may maybe me mean measure medical meet member members mentor method might mind minute
model models moment money month months more most move much must my name need needs network never new
news next nice night no none not note nothing now number of off offer office often old on once one
only open option or order other others our out outcome over own page paid pain part partner partners
party pass past patient patients pay people per percent perhaps period person phone pick picture
piece pilot pitch place plan planning plans plant platform play point policy position possible post
power practice present pressure price prices pricing private probably problem problems process product
products profit program progress project projects proof provide public pull purpose push put quality
question questions quick quickly quiet quite raise range rate rather reach read ready real really
reason receive record red reduce report research resource resources rest result results return
revenue review right risk risks road role room round rule run safe safety said sale sales same save
say scale school science score second see seed seek seem segment sell send sense series serve service
services session set seven several shall share she short should show side sign signal simple since
single site six size skill small smart so social software solution solutions some someone something
sometimes soon sort sound source space speak special spend staff stage stand standard start started
startup startups state step still stock stop store story strategy strong student students study
subject success such suggest summer supply support sure system systems table take talk target task
team teams tech technology tell ten term terms test testing tests than thank that the their them then
theory there these they thing things think third this those though thought three through time times
to today together too tool tools top total toward track trade training trial true trust try turn two
type under understand unit university until up upon us use used user users using usually value values
various venture ventures very view visit voice wait want was watch water way we week weeks well went
were what when where whether which while white who whole why will win with within without work worker
workers world would write year years yes yet you young your
`;

/** The common-word set (lower case). */
export const COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter((w) => w !== ''));
