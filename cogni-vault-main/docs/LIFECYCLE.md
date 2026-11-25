# Delivery lifecycle

The path every change takes, and what enforces each step.

```
issue
  └─> feature branch
        └─> pull request
              └─> automated checks      lint · test · build · security-check
                    └─> AI/security review
                          └─> peer approval
                                └─> staging deploy + health check
                                      └─> business approval (where required)
                                            └─> production deploy
                                                  └─> production health check
                                                        └─> rollback (if supported)
```

A step "enforced by GitHub" cannot be skipped by editing a file in this
repository. A step enforced by convention can — those depend on review.

| Step | Enforced by | Configured where |
| --- | --- | --- |
| Issue first | Convention | `CONTRIBUTING.md`, issue forms |
| Feature branch | GitHub | Branch protection: no direct push |
| Pull request | GitHub | Branch protection: require PR |
| Automated checks | GitHub | Branch protection: required status checks |
| AI/security review | Convention | `.claude/agents/security-reviewer.md` |
| Peer approval | GitHub after per-repository provisioning | `.github/CODEOWNERS` and `Protect main`; see `REVIEW_OWNERSHIP.md` |
| Staging | Convention | `deploy.yml` ordering |
| Business approval | GitHub | Required reviewers on `production` Environment |
| Production | GitHub | Environment gate + SHA match check |
| Health check | GitHub | `deploy.yml` job dependency |
| Rollback | Human decision | `rollback.yml`, dispatched manually |

---

## 1. Issue

Work starts with an issue, using a form from `.github/ISSUE_TEMPLATE/`. The issue
number goes in the branch name, so the change is traceable from any commit back
to the reason it was made.

## 2. Feature branch

`<type>/<issue-number>-<slug>`, branched from the default branch. Direct commits
to the default branch are blocked by branch protection.

## 3. Pull request

The author fills in `.github/PULL_REQUEST_TEMPLATE.md`. Its risk section is not
ceremony — the answers become `database_migration`, `rollback_safe`, and
`business_approval_required` in the release metadata, and those values determine
whether an automated rollback is available later.

## 4. Automated checks

`pr-checks.yml` runs four reusable workflows in parallel:

| Check | Gate |
| --- | --- |
| `lint` | Style and static correctness |
| `test` | Behaviour |
| `build` | The project still builds |
| `security-check` | Dependency audit, static analysis |

All retained quality gates must pass. Configure their observed identities as
required checks during [review provisioning](#required-status-checks--provision-before-use);
workflow files alone do not enforce required-check settings.

These four checks run this repository's own `npm` scripts (`lint`, `test`,
`typecheck`, `npm audit` plus the gitleaks scan). The release workflows in
`deploy.yml` are different: their deploy steps are still `CUSTOMIZE`
placeholders that fail on purpose. See [`WORKFLOWS.md`](WORKFLOWS.md).

## 5. AI/security review

An AI pass reviews the diff using
[`.claude/agents/security-reviewer.md`](../.claude/agents/security-reviewer.md):
secrets, untrusted input, authorization, CI/CD and supply-chain changes.

It is a signal, not an approver. It has no merge authority and does not replace
the human reviewer — an AI review cannot be accountable for a decision, which is
what an approval is. Its value is catching mechanical mistakes before a human
spends attention on the PR.

## 6. Peer approval

One independent developer with repository write access approves feature work.
Governance paths in `.github/CODEOWNERS` require an approving member of
`@House-of-Helix-CMD/technical-admins`, matching Minimalism. There is no catch-all
owner. Authors cannot self-approve; the latest reviewable push requires approval
from someone other than its pusher.

The template ships the ownership file and a Disabled ruleset preset. GitHub does
not copy team access or active protection into generated repositories. Complete
[`REVIEW_OWNERSHIP.md`](REVIEW_OWNERSHIP.md) before treating a new repository as
ready: grant the team access, verify owner resolution, validate actual CI check
identities, activate protection, and test feature and governance routing.

## 7. Merge and release record

On merge, create the release metadata record for the merge commit SHA. From here
on, that SHA is the release's identity. See
[`RELEASE_METADATA.md`](RELEASE_METADATA.md).

## 8. Staging

A maintainer dispatches `deploy.yml` with the commit SHA and the approved SHA
from the release record. A `validate` job checks both are full SHAs and that they
match before anything deploys, so a bad input fails in seconds rather than after
a staging deploy or, worse, after someone has approved it.

It then runs `staging-deploy`, followed by `staging-health-check` against the URL
the deploy reported.

The health check is a real HTTP probe and works as shipped. It proves the process
is serving; it does not prove the release is correct. Verify the actual change on
staging before promoting.

## 9. Business approval

For releases where `business_approval_required` is `true`.

This gate is the **required reviewer rule on the `production` GitHub
Environment**, not a field in a file. GitHub pauses the run before any step of
`production-deploy` executes and waits for a named reviewer to approve in the UI.

The approval refers to the exact `commit_sha` in the release record. That SHA
cannot drift — `production-deploy.yml` compares `commit-sha` against
`approved-sha` and fails if they differ, so an approval can never be applied to
code that was not reviewed.

The run only reaches this gate after a verified staging deploy, so no one is asked
to approve something untested.

## 10. Production

`production-deploy` checks out the exact approved SHA and deploys. Deploy the
artifact verified on staging where the platform allows it; rebuilding means
production runs a build nobody tested.

If the release includes a migration, it is applied here, and the record's
`database_migration` and `rollback_safe` values must already reflect that.

### Payment migration

Apply `0001_init.sql`, `0002_business.sql`, `0003_indexes.sql`, and
`0004_payment_execution.sql` in order. For an existing installation, pause payment
writes and order status changes, let in-flight approvals finish, and record a D1
restore point before the upgrade. Set `database_migration: true` and
`rollback_safe: false` on a release that introduces `0004`.

Before reopening payment writes, review historical charge and refund requests against
Stripe using the request ID in provider metadata. Reconcile captured charges first,
then the associated refunds. The admin approval operation accepts a verified
`provider_ref` and retrieves that object without creating a new payment. Review
orders already marked `paid` for verified net settlement and record discrepancies
for business review. Approvals of migrated requests with a provider reference use
provider lookups. Before rejecting and replacing a legacy pending request, confirm
that it moved no money and that any associated Stripe object can no longer settle.
Keep writes paused if a legacy attempt could have moved money and its outcome
remains unresolved.

Probe `/health?deep=1` after migration and deployment. Once the new payment states
are in use, recover by deploying a forward fix while preserving execution claims,
idempotency keys, and the audit log.

## 11. Production health check

`production-health-check` probes the deployment. Its failure is the trigger for a
rollback decision — it is intentionally the last automated step, and it does not
roll back on its own.

## 12. Rollback

Not chained into `deploy.yml`. A maintainer dispatches `rollback.yml` with the
last known-good SHA.

Automatic rollback on a failed health check sounds attractive and is often wrong:
the health check cannot distinguish "this release is broken" from "a dependency is
briefly down," and rolling back during a migration can compound the damage.
Deciding to roll back needs a human who can see the blast radius.

`rollback.yml` refuses to run when the release's `rollback_safe` is `false`. That
case — usually a destructive migration — requires human-planned recovery, not a
redeploy.

If the platform cannot roll back at all, delete `rollback.yml` and say so in the
README. A workflow that pretends to roll back is worse than none, because people
plan around it.

---

## Configuration checklist

The lifecycle depends on repository settings as much as on these files. None of
the GitHub-enforced steps work until these are set:

**Settings → Actions → General**
- [ ] Workflow permissions: **Read repository contents permission**
- [ ] Do not allow Actions to create or approve pull requests

**Settings → Branches → default branch**
- [ ] Require a pull request before merging
- [ ] Grant technical-admins explicit access and verify valid owner resolution
- [ ] Require one independent approval and Code Owner review for owned paths
- [ ] Dismiss stale approvals on new commits
- [ ] Require approval of the latest reviewable push by someone other than its pusher
- [ ] Require resolved conversations and keep the bypass list empty
- [ ] Import the Disabled ruleset preset; verify observed CI check names before
      activating required status checks
- [ ] Require branches to be up to date before merging
- [ ] Block force pushes and deletions

**Settings → Environments**
- [ ] `staging` — staging deploy secrets, no reviewers
- [ ] `production` — production deploy secrets, **required reviewers set**
- [ ] Restrict `production` deploys to the default branch

### Required status checks — provision before use

The preset `.github/rulesets/protect-main.json` starts Disabled and supplies the
standard caller check contexts: `lint / Lint`, `test / Test`, `build / Build`, and
`security-check / Security check`. Its source is GitHub Actions, not Any source.

Run the generated repository's actual workflow and compare its reported names
with the preset before activation. Stack customization can rename or remove a
job. An incorrect required context can leave a PR waiting for a check that never
reports. Do not guess names or count a green placeholder as verification.

1. Grant the technical-admins team explicit repository access and verify the
   ownership file resolves correctly.
2. Import the Disabled preset and confirm it targets the default branch.
3. Open a real setup PR and observe its check identities. Adjust the preset to
   match the retained, implemented gates. Scaffold checks intentionally remain
   failing until real commands are supplied.
4. Activate protection with no bypass actors.
5. Verify required CI blocks a failing PR and that an independent technical-admin
   approval satisfies governance review. Record the evidence.

See [`REVIEW_OWNERSHIP.md`](REVIEW_OWNERSHIP.md) for the full readiness checklist.

**Settings → Code security**
- [ ] Secret scanning + push protection
- [ ] Dependency alerts
- [ ] Private vulnerability reporting (referenced by `SECURITY.md`)
- [ ] CodeQL, if it supports the chosen language
