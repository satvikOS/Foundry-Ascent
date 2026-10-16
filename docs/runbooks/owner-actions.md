# Runbook: owner actions

**Who:** the platform owner (GitHub repository admin and AWS account administrator) · **Related:**
[deploy and rollback](deploy-and-rollback.md), [cost controls](cost-controls.md), [evals](evals.md),
[ADR-0010](../architecture/adr/0010-realtime-webrtc-deferred.md), [ADR-0005](../architecture/adr/0005-separable-persona-layers.md)

Everything here needs a credential or an authority that no workflow, agent or platform role has: GitHub
repository settings, the AWS account administrator, Billing, model terms, and the University. Each item
says how to verify it. Tick them off in order of the table; none blocks a deploy.

| #   | Action                                                                                                     | Why it matters                                                      |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | [Subscribe to the alarms](#1-subscribe-to-the-alarms)                                                      | Seven alarms exist and reach nobody                                 |
| 2   | [Create an AWS Budget](#2-create-an-aws-budget)                                                            | The only spend alert for the whole account and for Transcribe       |
| 3   | [Remove the dead stage-0 credentials](#3-remove-the-dead-stage-0-credentials)                              | Two secrets hold a deleted key; a variable holds a placeholder      |
| 4   | [Create the `evals` environment](#4-create-the-evals-environment)                                          | Evals have never run against production                             |
| 5   | [Opt out of AWS AI content use](#5-opt-out-of-aws-ai-content-use)                                          | Transcribe and Polly may otherwise keep call content to improve AWS |
| 6   | [Get the University privacy review](#6-get-the-university-privacy-review-before-a-production-voice-launch) | Required before real students use calls                             |
| 7   | [Collect real EIR consent](#7-collect-consent-before-using-a-real-eirs-likeness-or-voice)                  | Required before any real EIR's likeness or voice                    |
| 8   | [Enable Anthropic models on Bedrock](#8-enable-anthropic-models-on-bedrock-only-if-claude-is-wanted)       | Only if Claude models are wanted                                    |

## 1. Subscribe to the alarms

The SNS topic `FoundryAscent-Alarms` has no subscriber by design (an email address does not belong in the
repository). In the AWS console (us-east-1): **SNS → Topics → FoundryAscent-Alarms → Create
subscription**, protocol **Email**, your address; then open the confirmation email and confirm. Or in
CloudShell:

```bash
TOPIC=$(aws cloudformation describe-stacks --region us-east-1 --stack-name FoundryAscent-App \
  --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" --output text)
aws sns subscribe --region us-east-1 --topic-arn "$TOPIC" --protocol email --notification-endpoint you@example.edu
```

**Verify:** `aws sns list-subscriptions-by-topic --region us-east-1 --topic-arn "$TOPIC"` shows a
`SubscriptionArn` (not `PendingConfirmation`). Deploys leave the subscription alone: the stack defines no
subscriptions. The alarms are listed in [cost controls](cost-controls.md#alarms).

## 2. Create an AWS Budget

Billing → **Budgets → Create budget → Cost budget**, monthly, with the amount you are prepared to spend.
Idle is about $45–47 a month: the database is kept awake at 0.5 ACU (about $44) so no founder waits 15–30 s
for it to resume ([latency](latency.md)). Setting `aurora.minCapacityAcu` to 0 in
`infra/cdk/config/production.json` brings idle back to $1–3, with that wait after 10 idle minutes. The daily
AI cap ($15 by default) allows up to about $450 a month of AI spend, so a budget of, for example, $75 with
email alerts at 80 % and 100 % of actual cost and 100 % of forecast cost catches growth early without
firing on the idle bill every month (at `minCapacityAcu: 0`, $50 with alerts at 50 %, 80 % and 100 % does
the same). Also turn on **Cost Anomaly Detection** (Billing → Cost Anomaly Detection → default service
monitor, daily email summary; free); expect one anomaly email for the step from $1–3 to about $46 in the
first month after the change.

Add a second cost budget scoped to **Service: Amazon Transcribe** (for example $10 a month, alert at 100 %
of actual cost). Transcribe streaming is the one AI cost the app can only meter as clients report it: an
open socket bills until the browser closes it ([cost controls](cost-controls.md#where-the-money-goes)). Budgets update a few
times a day, so this is a backstop, not a live limit; `speech.enabled: false` is the lever.

**Verify:** both budgets appear under Budgets with their alerts; the anomaly monitor lists the email.

## 3. Remove the dead stage-0 credentials

The stage-0 access key was deleted on 2026-10-06 ([ADR-0016](../architecture/adr/0016-staged-iam-github-oidc.md)),
but GitHub still holds its secrets, and the repository **variable** `AWS_DEPLOY_ROLE_ARN` holds a
placeholder (`arn:aws:iam::<your 12-digit AWS account ID>:role/…`). Deploys work because the secret of the
same name wins (`secrets.AWS_DEPLOY_ROLE_ARN || vars.AWS_DEPLOY_ROLE_ARN`), but if the secret were ever
removed the placeholder would fail with a confusing message.

In GitHub: **Settings → Secrets and variables → Actions**:

1. **Secrets** tab: delete `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Keep `AWS_DEPLOY_ROLE_ARN`.
2. **Variables** tab: delete `AWS_DEPLOY_ROLE_ARN` (the secret is the one in use, and it keeps the account
   id masked).

Or with the GitHub CLI: `gh secret delete AWS_ACCESS_KEY_ID`, `gh secret delete AWS_SECRET_ACCESS_KEY`,
`gh variable delete AWS_DEPLOY_ROLE_ARN`.

Optional, in IAM: the user `Foundry-Ascent` has no access key and only policies that cannot be used
without one; delete the user (IAM → Users → `Foundry-Ascent` → Delete) if nothing else needs it.

**Verify:** the next **Deploy** job summary shows _AWS access: GitHub OIDC (stage 1)_.

## 4. Create the `evals` environment

The evals workflow signs in to production with the owner code, so it only runs from a GitHub environment
the owner controls. Settings → **Environments → New environment** `evals` (deployment branches: `main`
only; add yourself as a required reviewer if every run should wait for you). Then:

- environment secret `FA_OWNER_ACCESS_CODE` = the owner access code from your password manager (on the
  `evals` environment page, not the repository's Secrets tab);
- repository variable `FA_SITE_URL` = `https://d38hejyf9iw77e.cloudfront.net` (Settings → Secrets and
  variables → Actions → Variables).

**Verify:** run **Evals - scenario benchmark and red team** with `suite = scenarios` and a small
`max_turns`; the job summary shows the gates. Details: [evals](evals.md).

## 5. Opt out of AWS AI content use

AWS AI services, Amazon Transcribe and Amazon Polly among them, "may use and store customer content for
service improvement" unless the account opts out (AWS Organizations, "AI services opt-out policies"). For
calls that is the founder's audio and the vEIR's spoken text. Opting out is free but needs AWS
Organizations: if the account is not in an organization, create one (it becomes the management account).

1. AWS Organizations console → **Policies → AI services opt-out policies → Enable**.
2. **Opt out from all services** (applies to all current and future supported AI services).

**Verify:** the policy is attached to the root, and the effective policy of the account shows
`optOut` for `default`. Do this before step 6: the privacy review will ask.

## 6. Get the University privacy review before a production voice launch

Calls are built and on, with synthetic data only (ADR-0006). Before real students use them, the
University's privacy review must accept:

- what is processed and where: microphone audio streamed from the browser to Amazon Transcribe in
  us-east-1 (no audio stored by the platform); the transcript stored like any chat turn; the vEIR's
  validated text spoken by Amazon Polly;
- that AWS AI content use is off (step 5);
- what founders are told before their first call, retention of call transcripts, and the typed
  alternative;
- the speech engine (`neural`; `generative` carries the residual risk in ADR-0010).

Until it is accepted, keep the cohort synthetic, or switch calls off with `callsEnabled: false`
([kill switch](kill-switch-and-persona-suspension.md)). Record the decision (date, reviewer, scope) with
the program's data-protection records.

## 7. Collect consent before using a real EIR's likeness or voice

Corin's and Ruth's vEIRs are built from fictional EIRs with synthetic consent records. A vEIR built from a
real EIR needs, before release: a signed consent from that EIR covering doctrine, style and cases, plus
`voice` for a persona-specific or cloned voice and `likeness` for a portrait or avatar, with the approved
uses, audience, term and named processors (ADR-0005; ADR-0010 for vendors). Record it in **EIR studio →
the persona → Consent**; the platform refuses a voice or portrait the consent does not cover, and revoking
consent suspends the persona. Keep the signed document outside the platform (evidence reference only).

**Verify:** the persona's consent lists each asset in use, and its release approval succeeds.

## 8. Enable Anthropic models on Bedrock (only if Claude is wanted)

Production runs Amazon Nova 2 Lite. Anthropic models on Bedrock need one-time account-level steps that
the platform roles cannot take:

1. As the account administrator, in the Bedrock console (us-east-1) open an Anthropic model in the model
   catalog and submit the **first-time use (use case) form** (or `aws bedrock put-use-case-for-model-access`).
   It is required once per account or organization; a pending agreement returns `AccessDeniedException`
   until AWS emails that it is set up.
2. Make the first invocation yourself (for example in the Bedrock playground): it starts the AWS
   Marketplace subscription, which needs `aws-marketplace:Subscribe` and a valid payment method. The
   platform roles have neither, by design.
3. Check: `aws bedrock get-foundation-model-availability --model-id <model id>` reports
   `agreementAvailability.status = AVAILABLE`.

Using Claude in the product is then a reviewed code and config change (model adapter, pricing table,
`infra/cdk/config/production.json` → `models`), as [ADR-0014](../architecture/adr/0014-bedrock-models-luna-nova-titan.md)
describes for model changes.
