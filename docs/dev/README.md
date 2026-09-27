# Development guide

How this repository's documentation and naming work. The architecture and the
decision record live in [docs/PLAN.md](../PLAN.md); this guide covers how
everything else is kept coherent.

## Documentation map

| Where | Role | Rule |
| --- | --- | --- |
| `docs/PLAN.md` | architecture + decision record (the *why*) | updated when a decision or contract changes; section text is normative, §12 is the decision log with triggers |
| `docs/dev/*.md` | living developer guides (the *how*) | one audience, one task per document; short; changed in the same commit as the code |
| `docs/ERRORS.md` | generated from common core and strategy error definitions | never hand-edited (`npm run gen:errors`) |
| `src/protocol/` | typed request/result vocabulary (the former wire contract) | hand-maintained; shapes pinned by snapshot tests |
| `README.md` | entry point | links outward; never duplicates content that lives elsewhere |
| module doc comments | contract summary at each boundary | every module states what it owns and what it forbids; `TODO(Phase X)` markers tie code to plan phases |

## Rules

1. **Generated docs are derived, never edited.** If `docs/ERRORS.md` is wrong,
   fix the owning definition in the error catalog or the strategy module and regenerate.
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
   goes in the plan or a module's doc comment, not into scattered inline narration.
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
   yet, no polymorphic registries with fewer than two implementations, no union
   variants that no code path produces.
4. **A boundary exists to enforce dependency direction.** Core modules never import
   VS Code APIs or surface-layer code; anything that does not need that separation is
   just another module.
5. **Data may lead, indirection may not.** Wire types, config keys, and catalog entries are
   contract data: they may land before the code that serves them, following the plan's
   method table. Traits, registries, generic slots, and provider indirections land with
   their second implementation.
6. **Duplication beats indirection at small scale.** Ten copied lines are cheaper than a
   wrong interface; extract on the second occurrence, never on the first forecast.
7. **Per-change checklist** (in the commit message or review): *What is the second
   implementation or consumer of each new indirection?* If there is none, revert it.

## Code discipline

TigerStyle adapted for a VS Code extension: the value is not the rules but the
referees — every rule here is mechanically checked or owned by a named
mechanism. **A rule without a referee is not a rule.**

| Rule | Failure it prevents | Referee |
| --- | --- | --- |
| **Surface Law**: command handlers are three lines of shape — parse input, call the service, render the result; no business logic | UI handlers growing into a second implementation of the core | boundary test (`src/boundaries.test.ts`): `vscode` imports only in the surface allowlist |
| **S1. Every acquire has one owner and one release path**: registrations, timers, and session handles live in their owner's `DisposableStore` | ghost commands and leaked sessions after reload | review checklist; lint when a rule exists |
| **S2. No module-level mutable state** | hidden globals and cross-window interference | boundary test (no `export let` / `export var`) |
| **S3. Secrets live only inside the wrapper**: never in logs, JSON, or error messages | credentials leaking into the OutputChannel | redacted `toString` + a log-leak test |
| **T1. No floating promises**: every promise is awaited or explicitly `void`ed with a reason | `catch(() => {})` silent swallowing | `@typescript-eslint/no-floating-promises` / `no-misused-promises` |
| **T2. Explicit state machines with asserted transitions**: the attach states walk a whitelist table; illegal transitions hit `invariant` | state sliding into impossible combinations | transition table + tests |
| **T3. Async results carry an epoch**: UI updates across `await` carry the generation they were issued in; stale writes are dropped | “user hit disconnect, the reconnect callback still repaints” | pattern + tests |
| **E1. `activate()` only registers**: activation stays under a small budget; work happens on command | sluggish startup | activation timing test |
| **E2. Everything is bounded**: buffers, backoff, waits, retries — named constants | unbounded growth in a long-lived host | review: bare `while` or unbounded collection is suspect |
| **A1. `invariant()` for programmer errors, the catalog for environment failures** | mixing recoverable failures with bugs | the one-line test: *user/target/network can cause it → catalog; only a bug can cause it → invariant* |
| **A2. Assert at trust boundaries**: after parsing, before side effects, after state transitions | corrupt assumptions crossing into effects | `invariant` calls at the named spots |
| **A3. No guessing defenses**: `x ?? fallback` over an invariant is silent degradation by another name | masks bugs as behavior | review |

## Testing

Run `npm run check` for type checking, `npm test` for the unit suite (vitest),
and the `npm run gen:*` scripts to refresh generated artifacts — review their
diffs before accepting them.

Phase 0 is exploratory: tests protect boundaries and contracts, not coverage.

- **Test** three kinds of thing: anti-drift assertions over generated artifacts
  and serialized shapes (catalog ↔ `docs/ERRORS.md`, config key shapes, request
  and result shapes), pure function boundaries (encode/decode, validation), and
  regressions for bugs actually caught.
- **Do not test** shapes that are still in flux (request params and the
  strategy contract get their contract tests when the contract freezes),
  tautologies the type system already guarantees, or what the code obviously
  does. Lint-level checks belong in lints, not in tests.
- **Business-flow tests are deliverables of the phase that implements the
  flow** (see plan §9), not accompaniments to skeleton code.
- **Serialized shapes are pinned with snapshots**, not hand-picked field
  assertions: a partial assertion stays green when a field is added, renamed,
  or dropped. The runner's update mode (`npm test -- -u`) rewrites the
  snapshots, turning every shape change into a reviewable diff of the test
  itself.
- **The integration-test boundary** (`test/` plus a support harness) is created
  with the first slow test — a real SSH server in Phase 1 — not before.
- Run `npm run gen:errors -- --check` to verify generated artifacts without
  rewriting them.

## Naming

- **Modules are short single words** (`protocol`, `errors`, `transport`,
  `strategy`, `service`, `profile`); nothing here is published as a package,
  so no external name collisions matter.
- **Product names keep full form**: the extension is `betelgeuz`.
- **Names are plain and descriptive.** Prefer what a thing is
  (`deploy pipeline`, `session manager`) over pattern vocabulary; suffixes like
  `Factory` or `Impl` are used only when they mean exactly that.
- **Command and setting names are user-facing API**: commands are generic verbs
  over the active attach, never backend-specific; settings live under the
  `betelgeuz.*` namespace with per-strategy keys under
  `betelgeuz.attach.<strategy>.*`.
