# Project instructions

Guidance for Claude Code working in this repository.

> **Governance is defined once, in [helix-engineering](https://github.com/House-of-Helix-CMD/helix-engineering) — the source of truth ([`GOVERNANCE.md`](GOVERNANCE.md)).** The lifecycle rules below are the inline guardrails an agent must not violate; the full workflow, review gates, and release process are canonical there ([engineering-workflow](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/engineering-workflow.md)) and in this repo's `docs/`.

Also read [AGENT-CONTRACT.md](AGENT-CONTRACT.md) before acting. It holds this repository's
production boundaries, review routing (see
[.claude/agents/README.md](.claude/agents/README.md#claude-routing)), and which controls are
enforced.

---

## Project

- **What this is:** `data-bank`, a Cloudflare Worker that serves a shared knowledge store
  and House of Helix Peptides operations (orders, inventory, payment requests) as an MCP
  server and REST API.
- **Stack:** TypeScript on Cloudflare Workers with D1 and R2. npm, Node 22+, Wrangler 4,
  Vitest 4, Biome 2.
- **Hosting:** Cloudflare Workers (`data-bank`). Staging is not set up yet.
- **Owner:** _not yet recorded; fill in._

## Commands

The PR checks (`lint.yml`, `test.yml`, `build.yml`, `security-check.yml`) run these
commands on the Node version in `.nvmrc`. The deploy and rollback workflows are still
template placeholders.

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Lint | `npm run lint` |
| Test | `npm test` |
| Build | `npm run typecheck` (Wrangler bundles at deploy; there is no separate build) |
| Security | `npm run secrets` (gitleaks) |
| All of the above | `npm run check` |
| Run locally | `npm run dev` (port 44119) |

Keep this table and the workflows in sync. If they drift, CI and local runs stop
agreeing and the AI review gate loses its reference point.

## Layout

- `src/`: the Worker. `index.ts` handles auth, CORS and routing. `mcp.ts` and `tools.ts`
  define MCP tools, and `rest.ts`/`routes.ts` the REST API. `auth.ts` holds API keys and
  roles. `payments.ts` and `stripe.ts` handle charge and refund approval.
- `test/*.test.ts`: fast tests on `node:sqlite`. `test/workers/` runs the real Worker in
  workerd.
- `migrations/`: D1 schema, applied in order.
- `wrangler.jsonc`: Worker, D1 and R2 bindings. Secrets are Wrangler secrets, never files.

---

## Lifecycle rules

These apply regardless of stack. Do not remove them.

1. **Work starts from an issue.** No branch without a tracking issue.
2. **Branch from the default branch.** Naming: `<type>/<issue-number>-<slug>`,
   e.g. `feat/142-token-refresh`. Types: `feat`, `fix`, `chore`, `docs`, `refactor`.
3. **Never commit directly to the default branch.** Every change lands via pull
   request.
4. **One PR, one concern.** If a PR needs two paragraphs to explain why it
   touches unrelated areas, split it.
5. **Do not edit `.github/workflows/` as a side effect** of a feature change.
   Workflow changes ship in their own PR so they are reviewed on their own terms.
6. **Do not weaken a `permissions:` block** to make a job pass. Escalating a
   workflow's token scope is a security change and needs its own PR and review.
7. **Never hardcode a secret.** Read from GitHub Actions secrets or the
   platform's secret store. If you need a new secret, say so in the PR body
   rather than inventing a value.
8. **Release metadata is append-only.** Records in `releases/` are written once
   and never edited. `commit_sha` identifies the record. See
   [`docs/RELEASE_METADATA.md`](docs/RELEASE_METADATA.md).

## Database migrations

Any change that adds, alters, or drops schema must:

- set `database_migration: true` in the release metadata record,
- state in the PR body whether the migration is backward compatible,
- state whether rollback is safe; if it is not, set `rollback_safe: false`.

A destructive migration makes a release non-rollback-safe. Say so explicitly
rather than leaving it implied.

## Review gates

A change reaches production only after all of these:

| Gate | Who or what |
| --- | --- |
| Automated checks | `lint`, `test`, `build`, `security-check` |
| AI review | `.claude/agents/security-reviewer.md` |
| Peer approval | one independent developer with write access; governance paths require `@House-of-Helix-CMD/technical-admins` (see `docs/REVIEW_OWNERSHIP.md`) |
| Staging verification | `staging-deploy` + `staging-health-check` |
| Business approval | required reviewer on the `production` Environment |
| Production health | `production-health-check` |

Full description: [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md).

Before calling a generated repository ready, complete
[`docs/REVIEW_OWNERSHIP.md`](docs/REVIEW_OWNERSHIP.md): grant the team explicit
repository access, verify CODEOWNERS resolution, import and activate the review
ruleset, and verify feature and governance routing with independent human review.
Template files do not provision repository permissions or rulesets.

## When asked to deploy

Do not run deploy workflows on your own initiative. Deploys are triggered by a
human via `workflow_dispatch`, and production additionally requires the
Environment reviewer to approve. If asked to "ship it," prepare the release
metadata record and report what is still missing.
