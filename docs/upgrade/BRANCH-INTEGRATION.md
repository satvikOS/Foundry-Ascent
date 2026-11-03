# Branch consolidation, 2026-11-03

The owner explicitly requested merging all branches to `main` and deleting merged branches. The integration preserves the current product requirements and the five curriculum PDFs uploaded in main commit `d2c440b`.

## Historical feature branches

These heads contain earlier work consolidated into main with new commit identities. They also retain superseded implementation alternatives. They are joined as historical parents while preserving the newer, tested runtime tree. Their complete commits remain reachable from main after branch deletion.

| Branch group                                        | Existing consolidation and resolution                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `face-full-app`, `face-full-infra`, `face-full-lab` | `44b46e8` incorporates the FULL face work. The lab branch matches all 77 touched files at that integration commit; the app differs only in the combined config, and infrastructure only in the combined snapshot. Later face fixes and the current local renderer/LITE corrections are retained. |
| archived accessibility labels                       | All ten touched files exactly match main. Equivalent patch is `5b40121`.                                                                                                                                                                                                                         |
| archived continuation alternatives                  | Main `cd19de7` and subsequent orchestration work contain the narrower audited continuation behavior. The older broader interception alternative is superseded.                                                                                                                                   |
| archived presence alternatives                      | Main `d5b0d80` contains the pure-banter identity behavior. Thirteen of fourteen files at the narrow branch tip match main; the sentence gate has later combined fixes. Broader earlier alternatives are superseded.                                                                              |
| archived commitment alternatives                    | Main `b0c448e` / `79e480f` contain the neutral commitment and help-first behavior. Current coaching and evidence policy takes precedence.                                                                                                                                                        |
| archived openers                                    | Main `fb438d7` contains the audited opener behavior; five of six files match the archived tip, and call handling has later improvements. The new distinct-topic regression remains.                                                                                                              |
| archived crisis alternatives                        | Main `b77d2fe` contains the reviewed optional safety screen. The earlier broader classifier is superseded.                                                                                                                                                                                       |
| archived avatar seam                                | The original presentation seam evolved into the integrated FULL/LITE lifecycle in `44b46e8` and later commits. The current provider-neutral capability boundary remains.                                                                                                                         |

## Dependency branches

The eight open dependency-update branches are merged as source changes. Lock conflicts are resolved from the combined package manifests using pnpm; no incompatible older runtime behavior is reintroduced. Combined quality, database, browser, infrastructure and security checks run before the main merge.

## Cleanup rule

Delete a branch only after its exact head is an ancestor of the merged main revision. Clean linked worktrees may be detached at their existing commits so their files remain available. No uncommitted work or worktree files are deleted.

## Status

Historical ancestry and dependency integration are in progress. Final merge, deployment and deletion results will be recorded after execution.

## Lint resource recovery

The combined SDK/type packages made a whole-monorepo typed-lint process exceed Node’s default ~4 GB heap. An isolated API pass completed in 4.22 s with ~1.27 GiB maximum resident memory, exposing three deprecated SDK callback-field references in a runtime-shaped test fixture. The fixture keeps its full structural Context shape without calling deprecated callbacks. The lint command now applies the unchanged strict root configuration separately to the root and every pnpm workspace, failing on any child error. No rules, warnings or real workspace source are excluded, and no heap-limit increase is required. Linked worktree copies retain their intended exclusion.
