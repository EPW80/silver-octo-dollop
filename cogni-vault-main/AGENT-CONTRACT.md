# Repository Agent Contract

The shared contract for every automated coding or review agent working in this repository
(`data-bank`, the House of Helix data bank Worker). Tool-specific entry files
([CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md)) load this document; they do not keep a second
copy of these rules.

Company policy lives in
[helix-engineering](https://github.com/House-of-Helix-CMD/helix-engineering). This contract
links to it and adds only what is specific to this repository, as required by the
[agent harness standard](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/agent-harness.md).

## Purpose and prohibited scope

A Cloudflare Worker that serves a shared knowledge store and House of Helix Peptides
operations (orders, inventory, restocks, payment requests, ledger) as an MCP server at
`/mcp` and a REST API at `/v1`. D1 is the source of truth, R2 holds large bodies, and Stripe
is called only when an admin approves a pending charge or refund. See [README](README.md).

Not allowed in this repository:

- Production secrets, live Stripe keys, real bot tokens, or card numbers, in any file,
  fixture, commit message, or PR text.
- Real customer data in tests or fixtures. Use synthetic `*.test` addresses.
- Bot tokens that start with `dbk_dev_` or `dbk_test_` for anything other than local
  placeholders. [.gitleaks.toml](.gitleaks.toml) allowlists those prefixes.
- MCP servers, plugins, or external skills added to the repository without technical-admin
  approval
  ([AI-assisted development](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/ai-assisted-development.md#not-allowed-without-technical-admin-approval)).

## Required context

Before any work, including analysis or review, read:

1. [README](README.md): architecture, roles, auth, the payment approval flow, and limits.
2. The source file being changed and its tests under [test/](test/).
3. Company
   [non-negotiables](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/README.md#non-negotiables),
   [coding standards](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/coding-standards.md),
   and the
   [AI-assisted development policy](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/ai-assisted-development.md).

## Commands

The command table lives in [CLAUDE.md](CLAUDE.md#commands). Run `npm run check` before
opening or updating a pull request.

`npm run format` rewrites files and has not been run over the existing code. Do not run it
as part of an unrelated change.

## Repository and production boundaries

- Work starts from an issue and a branch cut from `main`, and lands through a pull request
  ([engineering workflow](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/engineering-workflow.md),
  [pull request policy](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md#every-pr-must)).
  Classify the issue first under
  [change decision boundaries](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/standards/change-decision-boundaries.md#classify-the-issue-first).
- Apply the
  [pull request prohibitions](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md#prohibited)
  and the [secrets rules](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/security/secrets-handling.md#rules).
  The runtime secret store for this project is Wrangler secrets (`API_KEYS`,
  `STRIPE_SECRET_KEY`).
- Agents never run commands that touch the remote Cloudflare account: `npm run deploy`,
  `npm run db:migrate:remote`, `wrangler deploy`, `wrangler secret put`, or
  `wrangler d1|r2 ... --remote` and create commands.
- Agents never call the live Stripe API. Stripe is mocked in tests.
- `.dev.vars` is local-only and gitignored. Never commit it, print it, or put production
  values in it.
- A change that alters deployment, migration, rollback, access, or another operating
  process also needs a companion `helix-engineering` documentation PR
  ([operational documentation](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md#operational-documentation)).
- Apply [how work is measured](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/README.md#how-we-measure-work).

## Shared agent boundaries

Every tool-specific entry point and agent definition links here and keeps only behavior
specific to its role.

- Agent output does not count as approval; apply
  [AI review supplements human review](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/ai-assisted-development.md#ai-review-supplements-human-review).
- Do not push to a protected branch, merge a pull request, or deploy production; apply the
  [AI restriction](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/ai-assisted-development.md#never-allowed).
  Other remote mutations require an explicit human request.
- Diagnose failures and report blockers. Never weaken or disable a test, check, scanner,
  logging control, permission, role check, or branch protection to make work pass. This
  includes `git commit --no-verify` and widening the gitleaks allowlist.
- Never weaken the application's own controls: role checks in `src/auth.ts`, the
  admin-only `approve_transaction` and restock approval, idempotency keys on Stripe calls,
  and the append-only audit log.
- Never reproduce a secret value. If exposure is suspected, follow the
  [exposure procedure](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/security/secrets-handling.md#if-a-secret-is-exposed).
- Escalate decisions reserved for a human, business approver, or technical admin to the
  authority named in the approval section below.

## Human approval boundaries

Ordinary approval is defined in
[Every PR must](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md#every-pr-must);
extra review categories in
[Additional review requirements](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/pull-request-policy.md#additional-review-requirements).
In this repository those categories most often apply to:

| Paths | Category in the PR policy |
|---|---|
| `src/auth.ts`, API key or role handling | Authentication, authorization |
| `src/payments.ts`, `src/stripe.ts`, `src/orders.ts`, `src/ledger.ts`, customer email handling | Payment, billing, PII |
| `wrangler.jsonc`, `.githooks/`, `.gitleaks.toml`, `scripts/secrets.sh`, `package.json` scripts | Infrastructure, CI/CD, deployment config, secrets |
| MCP tools (`src/mcp.ts`, `src/tools.ts`), REST routes (`src/rest.ts`, `src/routes.ts`), `migrations/` | Public API contracts |

The path list is a guide. The category is decided by what the change means, not by which
file it touches.

## Project-specific routing

Multiple rows may apply.

| Work signal | Required responsibility |
|---|---|
| Any proposed change or pull-request diff | Correctness review |
| A design, RFC, or ADR before implementation | Architecture review |
| A new or changed package in `package.json`, or a new third-party service | Dependency review; security review when it runs in the Worker |
| Auth, API keys, roles, secrets, Stripe, payments, refunds, customer PII, `wrangler.jsonc`, hooks, or the secrets scan | Security review |
| An MCP tool, REST route, response shape, or D1 migration | Contract-compatibility review (Grok bots and scripts consume these) |
| New or changed behavior, or a reported test gap | Test review |
| A branch conflict | Conflict-resolution review |
| README or other documentation | Documentation validation |
| A release or deploy | Release-evidence review |

Correctness review is the default when no specialist row matches. Claude's mapping to agents
is in [.claude/agents/README.md](.claude/agents/README.md#claude-routing). Other tools apply
the responsibility directly and never claim that an unavailable agent ran.

## Behavioral and mechanical controls

The distinction is defined in
[prompts are not enforcement](https://github.com/House-of-Helix-CMD/helix-engineering/blob/main/policies/ai-assisted-development.md#prompts-are-not-enforcement).
For this repository:

| Control | Enforcement |
|---|---|
| This contract, `CLAUDE.md`, `AGENTS.md`, `.claude/agents/` | Behavioral instructions |
| `npm run check` (tsc, Biome, Vitest, gitleaks) | Run manually. |
| `.github/workflows/pr-checks.yml` (lint, test, build, security-check) | CI on every pull request and push to `main`. Together the four jobs run what `npm run check` runs, plus `npm audit`. They block a merge only once a ruleset requires them. |
| `.githooks/pre-commit` secrets scan | Local and opt-in per clone (`git config core.hooksPath .githooks`). Bypassable with `--no-verify`. |
| Role checks and admin-only approval in the Worker | Enforced at runtime by the application |
| `.github/CODEOWNERS` | Routes governance paths to `@House-of-Helix-CMD/technical-admins`. Approval is enforced only if a ruleset requires Code Owner review. |
| `.github/rulesets/protect-main.json`, branch protection, repository permissions | The ruleset is a disabled preset. Live configuration is managed outside this repository, and this contract does not assert it. |
| Specialist or AI review | Manual. Nothing in this repository wires it to pull requests. |

Passing an automated check does not authorize a merge, remote change, or production action.
