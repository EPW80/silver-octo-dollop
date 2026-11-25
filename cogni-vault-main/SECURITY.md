# Security Policy

**Org security policy, boundaries, and incident handling are defined once, in
[helix-engineering](https://github.com/House-of-Helix-CMD/helix-engineering) — the source of
truth ([SECURITY.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/SECURITY.md),
[security/incident-reporting.md](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/security/incident-reporting.md)).**
This file records only what is specific to *this* repository.

> **CUSTOMIZE:** replace the reporting contact, the supported-versions table, and
> the scope before this repository is used.

## Reporting a vulnerability

Do **not** open a public issue for a security vulnerability.

<!-- CUSTOMIZE — pick one and delete the other -->
- Use GitHub's private vulnerability reporting: **Security → Advisories → Report
  a vulnerability** on this repository. (Requires enabling private reporting in
  repository settings.)
- Or email: _security-contact@example.com_

For what to include in a report, response timelines, and how disclosure and credit
are handled, follow the org
[incident-reporting](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/security/incident-reporting.md)
process.

## Supported versions

<!-- CUSTOMIZE -->
| Version | Supported |
| --- | --- |
| _fill in_ | _yes / no_ |

## Scope

<!-- CUSTOMIZE -->
_Name the deployed hosts, domains, and repositories in scope, and anything
explicitly out of scope (third-party services, staging data, etc.)._

Do not test against production. Do not run denial-of-service tests, and do not
access data belonging to anyone other than yourself.

---

## Practices this repository enforces

Summarized here for reporters. The rules and the reasoning behind them live in
one place each, so they cannot drift out of sync:

- **Pipeline hardening** — least-privilege workflow permissions, no third-party
  GitHub Actions, `persist-credentials: false` on checkout, no `secrets: inherit`,
  and environment-scoped deploy credentials.
  → [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md)
- **Repository settings** — branch protection, required status checks, required
  code-owner review, and the `staging` / `production` Environments that carry the
  approval gate.
  → [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md#configuration-checklist)
- **Review gates** every change passes before production.
  → [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md)
- **Third-party action recommendations**, documented rather than installed.
  → [`docs/RECOMMENDED_ACTIONS.md`](docs/RECOMMENDED_ACTIONS.md)

Two rules worth stating outright, because a reporter may be checking for them:
no secret is ever committed to this repository, and widening a workflow's token
scope is treated as a security change requiring its own reviewed pull request.
