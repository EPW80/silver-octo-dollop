# Review ownership and repository readiness

Adopted for this template in issue #8 on 2026-11-03, following
`hoh-minimalism-product-page`.

## Approval model

One independent human with repository write access can approve feature work.
Feature paths have no catch-all owner. The following governance paths require
an approving member of `@House-of-Helix-CMD/technical-admins`:

- `/.github/`
- `/.helix/`
- `/releases/`
- `/CODEOWNERS`
- `/docs/schemas/`

The active `.github/CODEOWNERS` and `CODEOWNERS.example` must stay aligned. The
schema path protects release-validation policy. Authors cannot approve their own
PRs, and someone other than the latest pusher must approve the latest reviewable
push. New reviewable commits dismiss stale approvals. AI review is evidence, not
human approval.

## Provision every generated repository

GitHub templates copy the files. Team access and repository rulesets require
separate provisioning. A copied team name does not grant access, and individual
team members having access through another role or team is insufficient for
team ownership. See [GitHub code-owner requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

Complete this checklist before marking a new repository ready for normal feature
work. Record the repository, date, reviewer, rule URL and verification evidence
in its setup issue or repository-settings document.

1. Confirm the target organization and default branch. If copying outside
   House-of-Helix-CMD, replace the team on every ownership pattern and verify the
   real team is visible. Do not retain placeholder owners.
2. Grant technical-admins explicit repository access. House-of-Helix repositories
   use Admin for this team; owner resolution needs explicit write access or
   higher. Confirm the intended members accepted their invitations. Provisioning
   access is an administrator action, separate from editing these files.
3. Open `.github/CODEOWNERS` on the default branch. Require GitHub to report it
   valid and show technical-admins as owner of `.github/CODEOWNERS` and a workflow
   file. Fix invalid owners before enabling required owner review.
4. Import `.github/rulesets/protect-main.json` in Settings > Rulesets. The preset
   is Disabled and contains no repository identity, bypass actor or permission
   grant. Confirm it targets the default branch.
5. Run the actual PR workflow. Match its observed check names and GitHub Actions
   source with the preset. Adjust contexts for a stack that renames or removes
   gates; do not guess names, waive failures or substitute successful
   placeholders. The scaffold intentionally fails until real commands exist.
6. Activate Protect main with one approval, required owner review for owned
   paths, stale-review dismissal, latest-push approval, resolved conversations,
   required CI with up-to-date branches, no bypass actors, blocked force pushes
   and deletions, and squash merging.
7. Verify the checks block a failing PR and record two review-routing cases:
   a feature-only PR can use an independent developer with write access; a
   governance PR requires a different member of technical-admins. The author
   cannot self-approve, and a new reviewable push must invalidate stale approval.
8. Record the evidence and complete the setup issue only after team access,
   owner resolution and active rules are verified. Keep deployment provisioning
   separate; this checklist does not authorize a deployment or business release.

## Troubleshooting

- Invalid team owner: verify team visibility and its explicit repository grant,
  even when individual members are organization owners or already have access.
- Approval does not count: verify the reviewer belongs to the owning team, is
  not the PR author, and did not make the latest reviewable push. PRs use the
  CODEOWNERS file from their base branch; an ownership change needs an existing
  eligible reviewer before its new scope takes effect.
- Required status never reports: compare the configured context and source
  against the actual run. Repair the identity instead of bypassing the gate.
- New repo looks configured but merges without review: verify its own ruleset is
  Active. A rule on the template does not protect the generated repository.

The template repository itself was inspected on 2026-11-03: technical-admins
already had Admin access and Protect main already enforced the independent
review controls. This change updates inherited file policy and provisioning
materials; it grants no new repository access and deploys nothing.
