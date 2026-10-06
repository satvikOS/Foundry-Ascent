# ADR-0016: Staged IAM — bootstrap user, then GitHub OIDC; a boundary on every role

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §8 "Identity" (short-lived tokens, no shared accounts) and "Encryption" (keys and
  secrets outside source code), §15 "Configuration and secrets", §14 (compromised pipeline as a cost and
  data threat)

## Context and problem statement

Deployments run from GitHub Actions in a public repository. Something has to create the first IAM
resources (the permissions boundary, the CDK bootstrap stack, the GitHub OIDC provider) before keyless
federation exists. Long-lived access keys in CI are the most common cloud breach path, so they should exist
only for that bootstrap window, with the narrowest permissions that still work.

## Decision drivers

- No long-lived credentials in steady state; short sessions; deploys only from `main`/`production`.
- Least privilege for the pipeline itself; the heavy lifting goes through CDK's bootstrap roles.
- A compromised pipeline must not be able to escalate privileges or remove guardrails.
- Public logs: the account id must never be printed.

## Considered options

1. **Stage 0 IAM user with scoped policies → stage 1 GitHub OIDC role; permissions boundary on every role**
   (chosen).
2. Permanent IAM user access keys in GitHub secrets.
3. Manual console deploys.

## Decision outcome

Chosen option: **1** (details in `infra/iam/README.md`).

| Stage              | Principal                                        | Credentials                                                                                                                                   | Permissions                                                                         |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0 — bootstrap      | IAM user `Foundry-Ascent`                        | access key in GitHub secrets                                                                                                                  | `FoundryAscent-BootstrapOperator` (post-bootstrap: read-only, assume the CDK roles) |
| 1 — steady state   | role `FoundryAscent-GitHubDeploy`                | GitHub OIDC, 1 h sessions, trust exactly `repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:production` (aud `sts.amazonaws.com`) | assume the four CDK CLI bootstrap roles, read CloudFormation/Logs/Cost Explorer     |
| all platform roles | CDK-created roles, CloudFormation execution role | STS                                                                                                                                           | capped by `FoundryAscent-Boundary`                                                  |

- The account owner publishes the boundary (`infra/iam/apply-bootstrap-access.sh`) and bootstraps
  `CDKToolkit` (`infra/iam/cdk-bootstrap.sh`) in CloudShell with
  `--custom-permissions-boundary FoundryAscent-Boundary`; `cdk.json` sets
  `@aws-cdk/core:permissionsBoundary` so every role CDK creates carries it.
- **Amendment (2026-10, security review):** the stage-0 policy originally let the CI user create and change
  `cdk-*`/`FoundryAscent*` roles and publish `FoundryAscent*` policies (including the boundary), which is
  enough to grant itself administrator access. After the bootstrap the policy was reduced to read-only
  operations plus `sts:AssumeRole` on the four CDK CLI roles, with an explicit deny on IAM writes; the
  bootstrap workflow was removed, and the deploy role trusts only the `production` environment subject
  (no `ref:refs/heads/main`). Stage 0 is retired with the **Ops - retire stage-0 AWS access** workflow.
- The boundary denies creating users or roles without itself, editing or removing it, and creating access
  keys or console passwords.
- `deploy.yml` uses OIDC when `AWS_DEPLOY_ROLE_ARN` is set (a repository secret, so the account id stays masked; a variable is also accepted), otherwise the stage-0
  keys; switching is a variable change, not a code change. After the first OIDC deploy succeeds, the access
  key is deleted and the stage-0 policies detached.
- The Foundation stack creates the GitHub OIDC provider (`AWS::IAM::OIDCProvider`) unless context
  `githubOidcProviderArn` imports an existing one (one provider per URL per account). Before every
  `cdk deploy`, `deploy.yml` lists the account's providers and checks whether `FoundryAscent-Foundation`
  itself manages one; it imports only a provider that exists and is not managed by the stack, so
  CloudFormation is never asked to delete the provider every OIDC deploy depends on. The stage-1 role is
  not granted `iam:ListOpenIDConnectProviders`; under OIDC the workflow uses the provider's fixed ARN
  instead (it must exist: STS has just accepted a token through it).
- Every workflow masks the account id before any AWS call can print it; secrets reach only the steps
  that call AWS, never dependency installation.
- Status on 2026-10-05: stage 0. The boundary is published, `CDKToolkit` is bootstrapped and
  `FoundryAscent-Data` was deployed first, on its own (**Platform - deploy data stack**). The first full
  **Deploy** creates Foundation (provider and role) and App; then the variable switch completes stage 1.

### Consequences

- Good: steady state has no static AWS secret in GitHub; a stolen token expires within an hour and only
  works from `main` or the `production` environment.
- Good: even administrator-level CloudFormation execution cannot escape the boundary.
- Bad: two credential paths exist during the transition; the deploy workflow must support both.
- Bad: boundary changes are a deliberate, reviewed operation (CODEOWNERS on `infra/`).

### Confirmation

- `Ops - verify AWS access` simulates every action in `infra/iam/required-actions.json`.
- CDK tests assert the boundary on every role and the OIDC trust conditions (`foundation.test.ts`).
- The `production` environment restricts deployment branches to `main` (repository setting).

## Revisit trigger

- Stage 1 verified (first OIDC deploy green): retire the access key and close stage 0.
- Moving to an AWS Organization / IAM Identity Center, or adding environments (staging) with separate
  roles and trust conditions.
