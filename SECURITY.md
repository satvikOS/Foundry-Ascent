# Security policy

Foundry Ascent is a venture-coaching platform whose central promise is that each venture's information
stays private. We take reports about isolation, authentication and AI safety seriously.

## Reporting a vulnerability

- Use **GitHub private vulnerability reporting**: the repository's **Security** tab → **Report a
  vulnerability**. Do not open a public issue, pull request or discussion.
- Include: affected URL or component, steps to reproduce, impact, and any request ids from responses
  (`x-request-id` header or `requestId` in error bodies). Do not include real personal data.
- We acknowledge within **3 business days**, give a first assessment within **7 days**, and keep you
  informed until a fix is deployed. We credit reporters who want to be named.

Only the current `main` branch (the deployed production version) is supported.

### Scope

In scope: the deployed web application and API, this repository's code, infrastructure definitions and
workflows. Of particular interest:

- access to another venture's sessions, memory, documents, escalations or evidence (cross-venture leaks);
- authentication or session bypass, access-code brute force beyond the documented lockout;
- prompt injection that makes the coach disclose data outside the caller's authorization, bypass the
  validators, or impersonate a human EIR;
- privilege escalation in AWS (for example, escaping the `FoundryAscent-Boundary` permissions boundary);
- secrets or account identifiers exposed in the repository or workflow logs.

Out of scope: volumetric denial of service, findings that require a compromised user device, social
engineering of staff, missing best-practice headers without a demonstrated impact, and vulnerabilities in
third-party services (report those to the vendor).

### Safe harbour

Good-faith research that respects this policy is welcome: use only your own access, stop at the minimum
needed to demonstrate the issue, never access, modify or retain other people's data, do not degrade the
service, and give us reasonable time to fix before disclosure. We will not pursue action for such research.

## How data is handled

| Topic             | Practice                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data class        | **Synthetic only** in V1 ([ADR-0006](docs/architecture/adr/0006-synthetic-and-authorized-data-only.md)); real venture or student data requires University approval first                                                                                                               |
| Storage           | Aurora PostgreSQL and a private S3 bucket in `us-east-1`, encrypted at rest with AWS-managed keys; TLS in transit                                                                                                                                                                      |
| Isolation         | Service-layer authorization on every request plus PostgreSQL row level security under a non-bypassing role ([ADR-0004](docs/architecture/adr/0004-isolation-in-service-and-database.md))                                                                                               |
| AI processing     | Amazon Bedrock models in the same AWS account; only the authorized, minimal context for one turn is sent; Bedrock does not use it to train models                                                                                                                                      |
| Credentials       | Access codes stored only as scrypt hashes; sessions are signed, 12-hour, `HttpOnly`, `SameSite=Strict`, revocable                                                                                                                                                                      |
| Logs              | Structured metadata only (ids, counts, timings); never prompts, answers, documents or memory content; 30-day retention                                                                                                                                                                 |
| Audit             | Security, policy and admin events in an append-only, hash-chained audit log                                                                                                                                                                                                            |
| Memory control    | Founders approve, correct and delete memory; deletion erases every version's content                                                                                                                                                                                                   |
| Backups           | Aurora automated backups, 7-day retention, encrypted                                                                                                                                                                                                                                   |
| Secrets           | AWS Secrets Manager (database) and GitHub Actions secrets: the stage-0 deploy key (retired after OIDC) and `FA_OWNER_ACCESS_CODE` for the manual evals workflow; nothing secret in the repository (the owner code's prefix and scrypt hash in `infra/cdk/config` are public by design) |
| Public repository | Workflows mask the AWS account id; gitleaks scans every push and pull request (blocking) with an extra rule for access codes                                                                                                                                                           |

## Disclosure to users

Every session view and export carries the notice: _"You are working with Foundry Guide, an AI coach. It is
not a person, and no human EIR authored or approved these responses."_ High-risk topics (IP, legal,
investment, medical/regulatory, safety, conflict) receive educational framing and a human escalation path,
never professional advice.

Operational procedures for incidents are in [docs/runbooks/incident-response.md](docs/runbooks/incident-response.md).
