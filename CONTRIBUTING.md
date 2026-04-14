# Contributing to agent-passport-storage-sqlite

Thanks for showing up here. This is the SQLite persistence backend for the Agent Passport System — single trust domain storage, WAL mode, atomic transactions. Used by `agent-passport-system` when a persistent store is needed and a full database deployment is overkill.

## Quick start

**For a bug fix**, submit:
1. A failing test reproducing the bug
2. The minimal fix
3. No scope expansion

**For schema or migration changes**, open an issue first. This backend persists production data; schema changes need direction before code.

**For documentation or examples**, straight PR is fine.

**Submission mechanics:** fork the repo, create a feature branch from `main`, open a PR against `main`.

---

## What makes a PR mergeable

1. **Tests pass.** Including concurrency tests — WAL mode interactions are load-bearing.
2. **Schema migrations include up and down.** Irreversible migrations require explicit justification.
3. **Transactions are atomic.** Multi-statement operations must be wrapped in a transaction with clear rollback semantics. Silent partial writes are not acceptable.
4. **No untyped SQL.** Queries go through the prepared statement layer; dynamic string concatenation for SQL is declined.
5. **Format consistency.** Match existing module layout, error handling, naming conventions.

## Stability expectations

Follows semantic versioning. Schema changes affecting persisted data require a major version bump with a migration path. Internal API changes can land in patch releases.

## Out of scope

- **Alternative database backends.** If you want Postgres or Redis, that's a sibling repo, not this one.
- **Multi-tenant schema.** This backend is deliberately single trust domain. Multi-tenancy goes in a different layer.
- **Disabling constraints or foreign keys** for convenience.

---

## How review works

Every PR is evaluated against five questions, applied to every contributor equally:

1. **Identity.** Is the contributor identifiable, with a real GitHub presence?
2. **Format.** Does the change match existing patterns?
3. **Substance.** Do tests actually exercise the claimed behavior?
4. **Scope.** Does the PR stay scoped to its stated purpose?
5. **Reversibility.** Can the change be reverted cleanly?

Substantive declines include the reason.

---

## Practical details

- **Maintainer:** [@aeoess](https://github.com/aeoess) (Tymofii Pidlisnyi)
- **Review timing:** maintainer-bandwidth dependent. If a PR has had no response after 5 business days, ping it.
- **CLA / DCO:** no CLA is required. Contributions accepted on the understanding that the submitter has the right to contribute under the Apache 2.0 license.
- **Security issues:** open a private security advisory via GitHub rather than a public issue.
- **Code of Conduct:** Contributor Covenant 2.1 — see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

---

## Licensing

Apache License 2.0 (see [`LICENSE`](./LICENSE)). By contributing, you agree that your contributions will be licensed under the same license.
