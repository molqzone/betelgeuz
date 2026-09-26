# Development guide

How this repository's documentation and naming work. The architecture and the
decision record live in [docs/PLAN.md](../PLAN.md); this guide covers how
everything else is kept coherent.

## Documentation map

| Where | Role | Rule |
| --- | --- | --- |
| `docs/PLAN.md` | architecture + decision record (the *why*) | updated when a decision or contract changes; section text is normative, §12 is the decision log with triggers |
| `docs/dev/*.md` | living developer guides (the *how*) | one audience, one task per document; short; changed in the same commit as the code |
| `docs/ERRORS.md` | generated from common core and strategy error definitions | never hand-edited (`cargo xtask gen-errors`) |
| `docs/protocol.md`, `schemas/protocol/`, `schemas/strategies/` | generated from protocol and strategy contracts | never hand-edited (`cargo xtask gen-schema`) |
| `editors/code/src/protocol.ts` | generated from protocol and strategy JSON Schemas | never hand-edited (`cargo xtask gen-ts`) |
| `README.md` | entry point | links outward; never duplicates content that lives elsewhere |
| crate/module rustdoc | contract summary at each boundary | every crate's `lib.rs` states what it owns and what it forbids; `TODO(Phase X)` markers tie code to plan phases |

## Rules

1. **Generated docs are derived, never edited.** If `docs/ERRORS.md` is wrong,
   fix the owning definition in `errors` or the strategy crate and regenerate.
   Protocol schemas and types come from `protocol`.
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
8. **The error catalog may lead its behavior.** Codes are the semantic record and may exist before
   any code path produces them; behavior is never written for a code that no code path can
   produce yet. This is the one documented exception to the rule of two: catalog entries are
   data, not indirection.

## Abstraction policy

An indirection may not exist before its second concrete use. Every change is checked
against these rules; they are enforced by review and by the checklist at the bottom.

1. **Rule of two.** A trait, registry, provider slot, or generic parameter requires two
   concrete implementations or two real consumers in the tree before it is introduced. A
   test fake is not an implementation. Until then, write the concrete code or accept small
   duplication.
2. **The plan reserves names, not code shapes.** The plan may name a concept (strategy,
   debug provider); the code creates the indirection when the second implementation lands,
   not when the first is written.
3. **No empty containers.** No registry/factory/manager holding things that do not exist
   yet, no `Arc<dyn _>` collections with fewer than two members, no enum variants that no
   code path produces.
4. **A crate exists to enforce dependency direction or produce a separate artifact.** If
   its contents would compile fine as a module, it is a module.
5. **Wire types need a consumer in the same change** — a core service or frontend adapter
   that actually uses them. Contract-only types land with the method that serves them.
6. **Duplication beats indirection at small scale.** Ten copied lines are cheaper than a
   wrong interface; extract on the second occurrence, never on the first forecast.
7. **Per-change checklist** (in the commit message or review): *What is the second
   implementation or consumer of each new indirection?* If there is none, revert it.

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
- Run `cargo xtask gen-errors --check`, `cargo xtask gen-schema --check`, and
  `cargo xtask gen-ts --check` to verify generated artifacts without rewriting
  them.

## Naming

- **Workspace crates are short single words** (`protocol`, `errors`, `transport`,
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
