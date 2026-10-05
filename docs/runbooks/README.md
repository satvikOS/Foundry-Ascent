# Runbooks

Operational procedures for Foundry Ascent V1. Each runbook states who may act, the exact steps, and how
to verify and reverse them. Decisions behind them are in the [ADRs](../architecture/adr/).

| Runbook                                                                     | Use it when                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [Deploy and rollback](deploy-and-rollback.md)                               | Shipping main, first-time setup, switching to OIDC, a failed deploy, rolling back                                               |
| [Kill switch and persona suspension](kill-switch-and-persona-suspension.md) | Stopping one persona, all AI, or the whole API — with or without the product UI                                                 |
| [Incident response](incident-response.md)                                   | Leak allegation, compromised code or credential, harmful response, vendor outage                                                |
| [Access codes](access-codes.md)                                             | Issuing, revoking and reviewing codes; rotating the owner code                                                                  |
| [Cost controls](cost-controls.md)                                           | Understanding the bill, caps and alarms; Aurora not pausing; a cap was hit                                                      |
| [Evals](evals.md)                                                           | Evaluating production: `evals` environment secret `FA_OWNER_ACCESS_CODE`, variable `FA_SITE_URL`, running and reading the gates |
| [Legacy AWS cleanup](legacy-aws-cleanup.md)                                 | Removing pre-existing billable resources from the account (one-time)                                                            |
| [Local development](local-development.md)                                   | Running and testing everything on one machine                                                                                   |
