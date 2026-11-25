# Contributing

**Governance is defined once, in [helix-engineering](https://github.com/House-of-Helix-CMD/helix-engineering) — the source of truth ([`GOVERNANCE.md`](GOVERNANCE.md)).** This file covers only what is specific to *this* repository.

## How work moves

The process — issue → branch → commit → pull request → review → merge — plus branch naming,
commit-message conventions, and review requirements are the org standard:

- [Engineering workflow](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/engineering-workflow.md)
- [Pull-request policy](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md)

What this repository adds on top of that standard:

- **Checks that must pass:** `lint`, `test`, `build`, `security-check` — see [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md). All must pass; don't merge a failing check with a note that it's unrelated.
- **AI review** runs against the diff using [`.claude/agents/security-reviewer.md`](.claude/agents/security-reviewer.md) — an additional signal, never a substitute for a human owner, and without approval authority.
- **Peer approval** follows Minimalism: one independent developer with write access approves feature changes; governance paths in `.github/CODEOWNERS` require `@House-of-Helix-CMD/technical-admins`. Authors cannot self-approve, and the latest reviewable push needs approval from someone other than its pusher. See [review provisioning](docs/REVIEW_OWNERSHIP.md).
- **New repository readiness** requires explicit team access, valid owner resolution and active branch protection. These settings are not copied by GitHub templates. Import the supplied Disabled ruleset, verify the actual check names, then activate it and test both feature and governance review routing.
- **Pull requests** use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md); its Risk and Business-approval answers feed the release-metadata record.

---

## Deployment

Contributors do not deploy. Deploys are triggered by a maintainer through the
`Deploy` workflow (`workflow_dispatch`) and follow:

```
staging-deploy → staging-health-check → [business approval] → production-deploy → production-health-check
```

The business-approval gate is a required reviewer on the `production` GitHub
Environment. It refers to a specific `commit_sha` recorded in the release
metadata, and that SHA never changes — see
[`docs/RELEASE_METADATA.md`](docs/RELEASE_METADATA.md).

If a production deploy goes wrong and the release is marked `rollback_safe`,
a maintainer runs the `rollback` workflow with the previous good SHA.

---

## Working on the workflows themselves

Changes to `.github/workflows/` ship in their own pull request, never bundled
with a feature change. If a change widens a `permissions:` block, say so in the
PR title.

## Local setup

<!-- CUSTOMIZE — fill in once the stack is chosen -->
_Prerequisites, install command, how to run tests, how to run the app locally._
