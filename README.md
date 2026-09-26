# Betelgeuz

Attach-and-deploy tooling for embedded Linux development: a headless local control core (`betelgeuz-core`, Rust) with editor adapters — a VS Code extension first, with Zed / Neovim / Vim and CLI frontends planned. Everything lives in one monorepo, following the rust-analyzer layout.

## Layout

```text
crates/
├── protocol/     # JSON-RPC wire contract, config & descriptor schemas
├── errors/       # common core errors and metadata shared with strategies
├── betelgeuz/    # headless core binary `betelgeuz-core`: stdio JSON-RPC server, attach identity, deploy pipeline
├── transport/    # SshTransport trait, the single russh implementation, test fake
├── strategy/     # deploy strategy contract, registry (detection predicates), shared pipeline
└── cli/          # standalone CLI harness, binary `betelgeuz`
editors/
└── code/         # VS Code extension (the first frontend adapter)
xtask/            # cargo xtask: gen-schema / gen-errors / gen-ts / package
docs/
├── PLAN.md       # architecture, contracts, error model, phases, decisions
└── dev/          # developer guides: documentation & naming conventions
```

## What it does

- Connects to target boards over SSH; the board needs only `sshd` and SFTP — no VS Code Server, no board-side agent.
- Consumes the artifact already built by CMake Tools and deploys it; Betelgeuz never triggers a build.
- One attach per workspace: a verified board identity (host-key pin plus hardware descriptor) bound to a deploy strategy. Strategies are peers in a registry — `linux.ssh-app` (application) and `linux.remoteproc` (small-core firmware) first — selected by role × board detection (a recognized K230 binds its loader strategy, a remoteproc board binds `linux.remoteproc`). Several workspaces can share one physical board through a shared target profile.
- Host-centric debugging: `gdbserver` on the target over an SSH forward, debugger and symbols on the host (CodeLLDB in the VS Code frontend).
- Structured error catalog with phase-labelled, actionable diagnostics.

## Development

Implementation starts at Phase 0 of the plan.

```text
cargo check --workspace     # core
cd editors/code && npm install && npm run compile
```

Open the repository root in VS Code and press `F5` to launch the Extension Development Host.

## Documentation

- [Plan](docs/PLAN.md) — goals, architecture, contracts, error model, phases, and the decision record.
