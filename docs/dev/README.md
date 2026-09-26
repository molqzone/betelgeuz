# Development guide

How this repository's documentation and naming work. The architecture and the
decision record live in [docs/PLAN.md](../PLAN.md); this guide covers how
everything else is kept coherent.

## Documentation map

| Where | Role | Rule |
| --- | --- | --- |
| `docs/PLAN.md` | architecture + decision record (the *why*) | updated when a decision or contract changes; section text is normative, §12 is the decision log with triggers |
| `docs/dev/*.md` | living developer guides (the *how*) | one audience, one task per document; short; changed in the same commit as the code |
| `docs/ERRORS.md` | generated from the error catalog | never hand-edited (`cargo xtask gen-errors`) |
| `docs/protocol.md`, `schemas/` | generated from the `protocol` crate | never hand-edited (`cargo xtask gen-schema`) |
| `README.md` | entry point | links outward; never duplicates content that lives elsewhere |
| crate/module rustdoc | contract summary at each boundary | every crate's `lib.rs` states what it owns and what it forbids; `TODO(Phase X)` markers tie code to plan phases |

## Rules

1. **Generated docs are derived, never edited.** If `docs/ERRORS.md`, the
   protocol doc, or a schema is wrong, fix the source in the `protocol` crate
   and regenerate.
2. **Decisions live in the plan; guides live in `docs/dev`.** A new open choice
   goes to plan §12 in the right block (blocking / spike / deferred with a
   trigger). A resolved choice is recorded in §12's resolved record and is not
   re-litigated in guides.
3. **Code and docs change in one commit.** The monorepo exists so contracts and
   their two sides (core, frontend) never drift; a contract change without its
   doc update is an incomplete change.
4. **Language: English**, for all repository docs, code comments, and commit
   messages.
5. **Comments explain *why*, not *what*.** Prose that belongs to a contract
   goes in the plan or a crate's rustdoc, not into scattered inline narration.
6. **New vocabulary gets a definition before first use.** The defined terms are
   attach, role, strategy, pipeline, commit point, pin, detection predicate;
   new terms are added to the plan's terminology section (see
   "Attach semantics") before they appear anywhere else.
7. **How-to docs answer "how do I add or extend X"** and appear as
   `docs/dev/<topic>.md` (for example `strategy-howto.md` when the first
   strategy implementation lands). Each ends with a worked reference to an
   existing example in the codebase.

## Testing

Phase 0 is exploratory: tests protect boundaries and contracts, not coverage.

- **Test** three kinds of thing: anti-drift assertions over generated artifacts
  and wire formats (catalog ↔ `docs/ERRORS.md`, config key shapes, serialized
  shapes), pure function boundaries (framing, encode/decode, version
  negotiation), and regressions for bugs actually caught.
- **Do not test** shapes that are still in flux (request params and the
  strategy contract get their contract tests when the contract freezes),
  tautologies the type system already guarantees, or what the code obviously
  does. Lint-level checks belong in lints, not in `#[test]`.
- **Business-flow tests are deliverables of the phase that implements the
  flow** (see plan §9), not accompaniments to skeleton code.

## Naming

- **Workspace crates are short single words** (`protocol`, `transport`,
  `strategy`, `cli`, `xtask`, `betelgeuz`), rust-analyzer style. They are
  internal (`publish = false`); if a crate is ever published for third-party
  frontends, it ships under a namespaced name (`betelgeuz-protocol`).
- **Product binaries keep full names**: `betelgeuz-core` (the headless core)
  and `betelgeuz` (the CLI harness).
- **Names are plain and descriptive.** Prefer what a thing is
  (`deploy pipeline`, `session manager`) over pattern vocabulary; suffixes like
  `Factory` or `Impl` are used only when they mean exactly that.
- **Command and setting names are user-facing API**: commands are generic verbs
  over the active attach, never backend-specific; settings live under the
  `betelgeuz.*` namespace with per-strategy keys under
  `betelgeuz.attach.<strategy>.*`.
