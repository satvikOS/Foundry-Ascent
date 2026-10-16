"""Word lists the identity grader shares with the validator (packages/ai).

``COMMON_WORDS`` mirrors ``packages/ai/src/risk/common-words.ts`` and ``NAME_WORDS`` mirrors ``NAME_WORDS`` in
``packages/ai/src/validators/identity.ts``; ``tests/test_graders_identity.py`` fails when either drifts.
"""

from __future__ import annotations


def _word_set(text: str) -> frozenset[str]:
    return frozenset(text.split())


_COMMON = """
a about above across act action actions active actually add after again against age ago agree ahead air
all allow almost alone along already also always am among amount an analysis and another answer any
anyone anything app approach apps are area areas around art as ask asked assumption at available average
away back bad bank base based basic be became because become been before began begin behind being
believe below best better between big bill bit black blue board body book both box brand break bring
brought build building built business but buy by call called came campus can cannot capital car card
care case cases cash cause center central certain chain chance change changes channel charge check child
children choice choose city class clear client clients climate close club coach coaching code cold
college come comes coming common community company compare competition competitor competitors complete
concept consider consumer contact content continue contract control core cost costs could country course
cover create created credit cup current customer customers cut daily data date day days deal decide
decision decisions deep demand design detail develop development device did different direct discovery
do does doing done door down draft drive during each early easy eat economic edge education effect
effort either else email end energy enough enter entire even event ever every everyone evidence exactly
example expect experience experiment experiments expert fact factor fail failure fair fall family far
fast feature features feedback feel few field figure file final finally financial find fine finish fire
firm first fit five fix focus follow food for force form found founder founders four free friend friends
from front full fund funding future gain game general get give given global go goal goals going good got
government great green ground group grow growth guide had half hand happen hard has have he head health
hear help her here high him his hold home hope hospital hour hours house how however human hypothesis
idea ideas if impact important in include income increase industry information innovation inside insight
instead interest interview interviews into investor investors is issue issues it item its job jobs join
just keep key kind know knowledge lab labs land language large last late later launch law lead leader
learn least leave left legal less let level life light like likely line list little live local long look
loop lose loss lot love low machine made main make maker making manage management manager many market
marketing markets material matter may maybe me mean measure medical meet member members mentor method
might mind minute model models moment money month months more most move much must my name need needs
network never new news next nice night no none not note nothing now number of off offer office often old
on once one only open option or order other others our out outcome over own page paid pain part partner
partners party pass past patient patients pay people per percent perhaps period person phone pick
picture piece pilot pitch place plan planning plans plant platform play point policy position possible
post power practice present pressure price prices pricing private probably problem problems process
product products profit program progress project projects proof provide public pull purpose push put
quality question questions quick quickly quiet quite raise range rate rather reach read ready real
really reason receive record red reduce report research resource resources rest result results return
revenue review right risk risks road role room round rule run safe safety said sale sales same save say
scale school science score second see seed seek seem segment sell send sense series serve service
services session set seven several shall share she short should show side sign signal simple since
single site six size skill small smart so social software solution solutions some someone something
sometimes soon sort sound source space speak special spend staff stage stand standard start started
startup startups state step still stock stop store story strategy strong student students study subject
success such suggest summer supply support sure system systems table take talk target task team teams
tech technology tell ten term terms test testing tests than thank that the their them then theory there
these they thing things think third this those though thought three through time times to today together
too tool tools top total toward track trade training trial true trust try turn two type under understand
unit university until up upon us use used user users using usually value values various venture ventures
very view visit voice wait want was watch water way we week weeks well went were what when where whether
which while white who whole why will win with within without work worker workers world would write year
years yes yet you young your
"""

_NAMES = """
amber angel april august autumn baker bill bishop bliss bob brook buck bud butler carol carter cash
chance charity chase chip chuck clay cliff cooper crystal curt daisy dale dawn dean destiny dick dirk
don drew duke dusty earl eddy eve faith fay ford forest frank gale gene gill ginger glen grace grant
gray grey guy hank harmony haven hazel heath heather herb holly honor honour hope hunter iris ivory ivy
jack jade jay jean jewel journey joy judge june justice ken king kit lance lane lark laurel lee liberty
lily lord lucky major march mark marsh marshall mason max mercy merit miles misty moss nick noble norm
ocean olive page parker pat patience pearl penny pepper pierce piper poppy porter price prince rain ram
randy raven ray reed reign rich rick river rob robin rocky rod roger roman rose rosemary royal ruby
rusty sage saint sally sandy scout shepherd skip sky sonny spike spring star sterling stone storm sue
summer sunny tanner terry tom tony trey troy tucker valentine van victor violet wade walker ward warren
winter wolf woody worth wren
"""

#: Common English words and everyday venture vocabulary (lower case).
COMMON_WORDS: frozenset[str] = _word_set(_COMMON)

#: First names that are also everyday words ("frank feedback", "grant money").
NAME_WORDS: frozenset[str] = _word_set(_NAMES)
