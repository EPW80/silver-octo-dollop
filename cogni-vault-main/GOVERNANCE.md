# Governance

Project Helix engineering governance is defined **once**, in
**[helix-engineering](https://github.com/House-of-Helix-CMD/helix-engineering)** — the source
of truth. It is not copied into this repository: edits happen there and apply everywhere, so
this repo never has to be updated when a policy changes.

This repository follows:

| Topic | Source of truth (helix-engineering) |
|---|---|
| Engineering workflow (issue → branch → PR → review → merge) | [standards/engineering-workflow.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/engineering-workflow.md) |
| Pull-request policy & review requirements | [policies/pull-request-policy.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md) |
| Repository access & least privilege | [policies/repository-access.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/repository-access.md) |
| Coding standards | [standards/coding-standards.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/coding-standards.md) |
| Release process | [standards/release-process.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/release-process.md) |
| Security policy & vulnerability reporting | [SECURITY.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/SECURITY.md) · [security/incident-reporting.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/security/incident-reporting.md) |
| Secrets handling | [security/secrets-handling.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/security/secrets-handling.md) |
| AI-assisted development | [policies/ai-assisted-development.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/ai-assisted-development.md) |
| How work flows (everyone) | [docs/HOW-WORK-FLOWS.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/docs/HOW-WORK-FLOWS.md) |

## What stays in this repository

Anything specific to *this* project, or to the template machinery shipped here:

- `README.md` — what the project is.
- `CLAUDE.md` — stack, commands, layout (plus the inline hard-rules an agent must not violate).
- `docs/CUSTOMIZATION.md` — the per-stack setup checklist.
- `docs/WORKFLOWS.md`, `docs/RELEASE_METADATA.md`, `docs/LIFECYCLE.md`, `docs/RECOMMENDED_ACTIONS.md`,
  `docs/schemas/` — they document the workflow files and release-metadata mechanism that live in
  *this* repo.

The Helix Control Plane (executive dashboard) is at **[helix.helixcmd.com](https://helix.helixcmd.com)**.
