"""The conversation matrix: does the vEIR hold up across every way people actually talk?

``datasets/matrix/taxonomy.yaml`` lists the dimensions of human conversation (what the founder asks, how they
answer, how they feel and how that moves, how the topic moves, the social move, what came before, the channel and
the register). The pieces:

- ``taxonomy``   loads and validates the taxonomy and the template bank (``datasets/matrix/templates.yaml``).
- ``generator``  combines the dimensions with a pairwise covering array (not the cartesian product) into
                 scenarios: a persona, a goal, topics, sessions and a turn-level plan (intent, feeling, register)
                 with the checks each turn implies. Deterministic for a seed; sized by a budget.
- ``simulator``  renders each planned turn into a founder message: a deterministic template simulator (CI, the
                 mock model) or an LLM simulator through Amazon Bedrock (the conversation lab, real models).
- ``checks``     rule graders over what the founder read and heard (presence policy, craft, attunement,
                 requests, topic moves, continuity, calls, crisis).
- ``judge``      the LLM-judge rubric (nine criteria, calibrated anchors), prompt assembly and parsing.
- ``runner``     runs scenarios against a deployed API (the evals runner's sessions, calls and budgets).
- ``report``     per-dimension pass rates, the weighted humanness score and the worst scenarios by id.

Nothing here prints or stores founder messages or replies except into an explicitly given private directory
(``--private-out``, sealed by the lab) or a mock-model recording (``--record-replies``, refused for real models).
"""
