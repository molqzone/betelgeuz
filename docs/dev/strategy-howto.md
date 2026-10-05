# Adding a deploy strategy

How the strategy layer is put together and what a new strategy has to provide.
Read [the plan](../PLAN.md) §6 first — this guide is the mechanics of it.

## The shape

A strategy is a workflow bundle: artifact placement, activation, lifecycle
verbs, inspection, and log source, coordinated by shared core services. The
command layer routes every verb to the workspace's active strategy and never
addresses a board or chip resource directly.

- **Contract** — `src/strategy.ts` declares the `DeployStrategy` interface
  every strategy implements: `validate`, `assertIdentity`, `deploy`, `start`,
  `stop`, `restart`, `inspect`, `logs`, `restorePrevious`, `release`, `reset`,
  `resetForcibly`.
- **Registry** — the same file holds the compile-time registry: one entry per
  implemented strategy with its metadata (ID, role, label, detail, the
  operations its attach exposes, and whether a deploy stops a running target).
  The surface's strategy picker is generated from it, so adding an entry is
  what makes a strategy selectable.
- **Shared coordinator** — `src/operation.ts` holds what every strategy
  reuses: the busy lock a mutating operation holds (`deploy.busy` instead of
  queueing), the bounded runner for fixed commands, the probe field parser,
  the abort-aware delay, and the cancellation check.
- **Owned by the strategy** — its configuration parsing, its target probes,
  its error codes (`RPROC_ERRORS` in `src/strategies/remoteproc.ts` is the
  worked example: the definitions, the type, and the factory that injects
  them into `BetelgeuzError` so the common catalog never learns the
  namespace), and its commit-point rules.

The abstraction policy applies: the interface exists because two strategies
exist. Fields of the registry metadata and members of the contract are added
when a strategy needs them, not in anticipation of one.

## Worked example

`src/strategies/remoteproc.ts` is the reference implementation. What to copy
from it, in order:

1. **Module doc comment** — what the workflow owns, what it forbids (no own
   connection, no free-form command), and that its error catalog lives here.
2. **Error catalog + factory** — `RPROC_ERRORS` satisfies `Record<string,
   ErrorDef>`, a `RemoteprocErrorCode` type, and a `rprocError()` factory that
   passes the definition into the constructor. `src/errors.ts` then lists the
   strategy's codes in its `ErrorCode` union with a type-only import, and
   `scripts/gen-errors.ts` passes the catalog to `renderErrorCatalog`.
3. **Configuration parsing** — `parseRemoteprocConfiguration(value: unknown)`
   validates the untrusted settings record and reports `config.invalid`
   naming the field. Every operation carries its configuration and parses it,
   so no operation depends on another having run first.
4. **Instance resolution and identity** — the strategy-owned identity is
   cached at bind time and re-asserted after a reconnect; a changed name is
   `identity.instance-changed`, never a silent re-target.
5. **The deploy pipeline** — validate host-side before touching the target,
   stage reversibly, take the explicit confirmation a stop needs, stop,
   retain, commit (the point past which cancellation is refused), select,
   start, and wait for the state the target reports — with the failure of
   each stage mapped to the code that describes it.
6. **Tests** — `src/tests/remoteproc.test.ts` drives every path through the
   fake transport: the happy path, the missing interface, the busy lock, the
   interrupted upload, the failed stop, the crash, the timeout, the privilege
   fallback, and the re-target detection.

## Checklist for a new strategy

- [ ] One module under `src/strategies/`, no `vscode` import, no module-level
      mutable state (the boundary test enforces both).
- [ ] Implements `DeployStrategy`; `npm run check` proves it.
- [ ] Registry entry with metadata the surface can render.
- [ ] Owns its configuration parsing and its error codes, with `docs/ERRORS.md`
      regenerated (`npm run gen:errors`) and reviewed.
- [ ] Its settings keys live under `betelgeuz.attach.<strategy-id>.*`
      (`strategyKey()` builds them) and are declared in `package.json`.
- [ ] Tests cover the pipeline, the busy lock, cancellation around the commit
      point, and every error code the strategy can produce.
- [ ] A target-setup guide when the strategy needs target-side preparation —
      `remoteproc-setup.md` is the worked example.
- [ ] `docs/PLAN.md` updated when the contract or the phases change.
