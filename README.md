# Betelgeuz

Attach-and-deploy tooling for embedded Linux development, as a VS Code
extension: it binds an already-built artifact (CMake Tools stays the build
owner) to a verified target board over SSH and owns deploy, lifecycle, and
debug-endpoint management for that binding.

- The board needs only `sshd` and SFTP — no VS Code Server, no board-side agent.
- Betelgeuz never triggers a build; it consumes the artifact CMake Tools
  produced.
- One attach per workspace: a verified board identity (host-key pin plus
  hardware descriptor) bound to a deploy strategy — `linux.ssh-app` for big-core
  application workspaces, `linux.remoteproc` for small-core firmware
  workspaces. Several workspaces can share one physical board through a shared
  target profile.
- Host-centric debugging: `gdbserver` on the target over an SSH forward,
  debugger and symbols on the host (CodeLLDB).
- Structured error catalog with phase-labelled, actionable diagnostics.

## Layout

```text
src/            # the extension: VS Code surface + core modules
docs/
├── PLAN.md     # architecture, contracts, error model, phases, decisions
├── ERRORS.md   # generated from the error catalog — do not edit
└── dev/        # developer guides: conventions and policy
```

The core modules (profile resolution, identity, attach, transport, deploy
pipeline, strategies) never import VS Code APIs; the surface layer adds
commands, status UI, CMake Tools integration, and the DAP launch.

## Development

```text
npm install
npm run check
```

Press `F5` in VS Code to launch the Extension Development Host.

## Documentation

- [Plan](docs/PLAN.md) — goals, architecture, contracts, error model, phases,
  and the decision record.
- [Development guide](docs/dev/README.md) — documentation, naming, abstraction,
  and testing policy.
