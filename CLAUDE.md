# Repository Guide

Read the relevant sections of [the development guide](docs/dev/README.md) and
[the project plan](docs/PLAN.md) before changing architecture, generated
artifacts, service contracts, or test boundaries.

## Change Workflow

- Find the closest existing implementation and its tests before adding a new
  pattern or helper.
- Treat new public items, public exports, and npm dependencies as architectural
  changes. Check the rule of two in `docs/dev/README.md`.
- Keep contract changes synchronized across the typed interfaces, generated
  docs, and the plan. Generate artifacts with the documented `npm run gen:*`
  scripts; do not edit generated files by hand.
- Keep the core modules free of VS Code API imports; the surface layer owns
  everything editor-specific.
- Keep changes focused and update repository documentation in the same change
  when a contract or workflow changes.

## Validation

- Run `npm run check` for type checking and `npm test` for the unit suite.
- Run `npm run gen:errors` (and friends) after catalog or shape changes, then
  review the generated-file diffs; never accept output without checking what
  changed.
