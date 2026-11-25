# Deployment-control provisioning

Repository settings do not copy with template files. Keep placeholder deployment
commands fail-closed until the following controls are provisioned and verified.
This guide does not enable automatic staging or change workflow triggers.

## Technical-admin authorization

1. Confirm the current `House-of-Helix-CMD/technical-admins` team and grant it
   repository write access. Verify `.github/CODEOWNERS` resolves to that team.
2. Inventory **all** deploy/rollback entry points and alternate reusable callers,
   triggers, reruns and owners. Start with `.github/workflows/deploy.yml`,
   `staging-deploy.yml`, `production-deploy.yml` and `rollback.yml`; include any
   additional provider-capable workflow found in the inventory.
3. Configure an **active GitHub Actions actor policy** allowing only that Team.
   Target the inventoried paths. Exclude ordinary PR checks. Add no user, role,
   app or bot exceptions. Membership changes must flow through the team.
4. Retain existing login guards until replacement enforcement is proven. Obtain
   an independent technical-admin settings review for each repository.
5. Test an allowed admin with fixed invalid input that fails before Environment
   binding or provider access. With consent, test a non-team contributor who
   already has write access. Check reruns, alternate callers and ordinary PR CI.
   If non-team tests are skipped, record that enforcement as unverified rather
   than treating an admin rejection test as its substitute.

See [GitHub workflow actor policies](https://docs.github.com/en/actions/how-tos/administer/control-workflow-execution).

## Branch, CI and source ownership

Preserve existing review protections and restrict workflow/release-record changes
to technical-admin code owners. Require independent approval and approval of the
latest push, dismiss stale reviews and resolve review threads. Observe successful
real CI job names before configuring required checks. Do not require predicted
names from workflow comments or waive a failing security check to continue rollout.

Shared workflow changes need their own reviewed immutable revision and successful
repository checks. Each consumer upgrades staging, production and rollback pins
together through a focused reviewed PR. Verify the actual reusable call behavior
with credential-free rejected input before allowing provider access.

## Environment credentials and resources

Use the existing secret names with distinct values in `staging` and `production`
GitHub Environments. Inventory secret **metadata**, owner, provider permission and
resource bindings; never paste token values in issues, logs or documents. Ask an
authorized organization owner for organization-secret metadata and selected-repo
visibility where it is inaccessible. Secret names and timestamps do not establish
distinct values or effective isolation.

Narrow tokens to their required resources and operations. Separate deployment,
database migration and infrastructure provisioning permissions. Verify provider
restrictions against the actual configured resources before claiming isolation.
For Cloudflare, inspect [Workers roles, bindings and Custom Domain limitations](https://developers.cloudflare.com/workers/authorization/workers/).
If isolation cannot be proved in the account, stop that stage and record the gap;
do not silently broaden permissions or move accounts.

Human Cloudflare Access login grants browser access only. Maintain separate
staging human and CI service-token policies; widening browser access does not
authorize GitHub deployment.

## Per-repository verification record

Record repository/default-branch SHA; deployment paths, triggers and owner;
policy ID, active state, allowed Team and exact path targets; before/after branch
rules and observed check names; environment/secret metadata and provider scopes;
reviewed shared/consumer revisions; independent human settings reviewer;
test run IDs/attempts/actors and provider-job skip results; skipped tests and
unresolved gaps. Record archived repositories and repositories with no GitHub
deployment path separately. An inactive placeholder is not a verified deployment.

Roll out Minimalism → Growth → Halo → remaining active repositories. A failed or
inconclusive acceptance check stops rollout at that repository. Keep existing
guards. No actual deployment is needed for authorization checks. End-to-end
deployment/rollback needs its own proof; automatic staging follows only after
hardening blockers are resolved and its own plan is reviewed.
