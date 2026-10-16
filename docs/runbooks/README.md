# Runbooks

Operational procedures for Foundry Ascent. Each runbook states who may act, the exact steps, and how to
verify and reverse them. Decisions behind them are in the [ADRs](../architecture/adr/).

| Runbook                                                                     | Use it when                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Owner actions](owner-actions.md)                                           | What only the owner can do: alarm subscriptions, budget, GitHub settings, AI opt-out, reviews, consents, models |
| [Deploy and rollback](deploy-and-rollback.md)                               | Shipping main, a failed deploy, rolling back, probing Bedrock                                                   |
| [Kill switch and persona suspension](kill-switch-and-persona-suspension.md) | Stopping one persona, calls, streaming, all AI, or the whole API — with or without the product UI               |
| [Incident response](incident-response.md)                                   | Leak allegation, compromised code or credential, harmful response, vendor outage                                |
| [Access codes](access-codes.md)                                             | Issuing, revoking and reviewing codes; rotating the owner code                                                  |
| [Cost controls](cost-controls.md)                                           | Understanding the bill, caps and alarms (speech and distillation included); Aurora not pausing; a cap was hit   |
| [Evals](evals.md)                                                           | Evaluating production: running and reading the gates                                                            |
| [Platform insights](insights.md)                                            | How the platform is used: conversations, calls, distillation, spend; the sealed transcript export               |
| [Local development](local-development.md)                                   | Running and testing everything on one machine                                                                   |

Archived: [legacy AWS cleanup](legacy-aws-cleanup.md) (one-time removal of pre-existing resources, closed
2026-10-06).
