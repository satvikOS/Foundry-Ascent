# Client suite scenarios

Fixed founder lines for `conversation_lab/client` (docs/runbooks/conversation-lab.md, "Client test"). Every venture,
person, number and record is invented; nothing here comes from a real conversation or a client document. A line with a
`wording` key stands for one of the client's own questions: the text here is our equivalent, and the exact text is laid
over it at run time from the client's pack, which is never committed.

| File                  | Group       | What it holds                                                                     |
| --------------------- | ----------- | --------------------------------------------------------------------------------- |
| `c1-protocol.yaml`    | protocol    | the client's short protocol in order, typed and on a call, with the next-day part |
| `c2-questions.yaml`   | questions   | the twenty questions, each on a venture and role that fits it                     |
| `c3-organise.yaml`    | organise    | a first-time engineer asks to be organised, knows no business, brings a new idea  |
| `c4-calls.yaml`       | calls       | unit economics, value proposition, pitch preparation, "last time"                 |
| `c5-arcs.yaml`        | arcs        | several sessions with days between them; constraints, moods, speech-to-text noise |
| `c6-repeats.yaml`     | repeats     | ten key asks, three fresh sessions each: the same step every time                 |
| `c7-adversarial.yaml` | adversarial | a small simulated set that pushes for invented facts, rulings and other ventures  |
| `c8-numbers.yaml`     | numbers     | twelve calculations on the founder's own numbers                                  |
| `c9-news.yaml`        | news        | eight results and events, read for what they mean                                 |
| `c10-followups.yaml`  | followups   | questions about the step just given                                               |
| `c11-novice.yaml`     | novice      | first-time engineers, in plain words                                              |
| `c12-odd.yaml`        | odd         | ten asks in wordings no rule has                                                  |
| `c13-memory.yaml`     | memory      | one founder, five sessions over six weeks, a pivot and a pivot back               |
| `c14-hard.yaml`       | hard        | two ventures mixed, a hard critique, broken English, one ask four ways, a page    |
| `c15-heldout.yaml`    | heldout     | sixteen held-out conversations, played only when named; never tuned against       |
| `c16-heldoutb.yaml`   | heldoutb    | sixteen more, written after the first were read; played only when named           |

The judge's hand-graded set is beside this folder (`../client-calibration.yaml`).

Schema: `conversation_lab/client/scenarios.py` (strict; `python -m pytest tests/test_client_scenarios.py`). Dates are
relative to the run's day: `{date+9}`, `{weekday+3}`, `{iso+9}`.
