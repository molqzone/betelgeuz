# Betelgeuz Plan

## 1. Project Goal

Develop Betelgeuz as a VS Code extension for attach-and-deploy embedded Linux development. Lichee RVNano is the sole Tier 1 board; other boards are future support targets. CMake Tools remains the workspace's build owner and produces the selected target artifact; Betelgeuz consumes that existing artifact through the active attach object and manages the target lifecycle. Separate workspaces can use the same flow with different deploy strategies, such as SSH application deployment for a Linux userspace workspace and Linux `remoteproc` for a small-core firmware workspace. The target-control logic lives in modules that never import VS Code APIs, so it stays unit-testable and reviewable; VS Code is the only supported frontend.

North star: Betelgeuz is not a build system, a remote IDE, a board manager, or an SSH frontend. It is a target-control layer inside the VS Code extension that binds an existing build artifact to a verified target through a selected deployment strategy, and owns deployment, target lifecycle, and debug endpoint management for that binding.

The extension must not require VS Code Server on the target board and must not use `Remote - SSH` as its execution model. It may follow the familiar remote-target workflow of remembered profiles, host-key verification, and reconnect behavior; that similarity applies only to connection management, not to running a remote VS Code extension host.

The Microsoft `Remote - SSH` extension is not a Betelgeuz runtime dependency. Its internal resolver and transport implementation do not provide a stable public library API, and reusing them would couple Betelgeuz to the Remote - SSH extension and its VS Code Server workflow. Betelgeuz owns its target profile, authentication settings, host-key pins, and connection policy.

## 2. Product Boundaries

### MVP includes

- Integration with the active CMake Tools workspace and its already-built target artifact.
- A TypeScript core module layer inside the extension: profile resolution, identity, attach, deploy pipeline, and strategies behind strict module boundaries, with no VS Code API imports in the core modules.
- SSH target profile resolution using a Betelgeuz-managed host, port, user, credential reference, and host-key pin.
- Secure hardware descriptor reading after SSH identity verification, with explicit handling for targets that have no stable board ID.
- SSH connection management with keepalive and automatic reconnect.
- SFTP upload of selected CMake targets.
- Atomic deployment through a temporary remote file and rename.
- Remote process commands: run, stop, restart, and fetch recent output.
- VS Code status bar state and command palette commands implemented by the frontend adapter.
- Workspace configuration referencing the SSH target profile, plus workspace-scoped target artifact and remote path settings.
- One active attach object per workspace, bound to a user-selected deploy strategy and verified target identity. Strategy compatibility is checked after binding when the strategy probes the target.
- A stable artifact contract between CMake Tools and all deployment strategies.
- A mockable transport layer so the core behavior can be tested without hardware.

The MVP scope is staged inside the first release: foreground application execution is the
Phase 1 baseline, while systemd service mode is the optional Phase 4 capability. Acceptance
criteria that mention a service are conditional on the target exposing a supported service
manager and a pre-provisioned unit; a board without one remains a supported foreground-only
target.

### Follow-on capability area

- Add the `linux.remoteproc` deploy strategy for small-core firmware workspaces whose target exposes the standard interface. It is introduced in Phase 3. Vendor small-core control mechanisms, including Rockchip mailbox control and the Canaan K230 loader, are future strategies behind the same contract.
- Keep strategy-specific configuration and target validation inside each strategy.
- Reuse the same build-artifact-to-attach workflow for application and firmware projects, each deploying its own artifact.
- Add a serial-console transport as a peer of the SSH transport, staged: **S1** attaches a serial console as a read-only log and descriptor source, driving login and prompt handling without mutations; **S2** adds deploy, structured exec, and lifecycle over the console shell, with file transfer through base64 staging or ZMODEM. Library choice: the `serialport` npm package (the mature cross-platform option with honest Windows support, pinned at implementation time) with a per-port reader bridged into the event layer — serial bandwidth does not warrant anything fancier. The console driver itself (login and prompt matching, echo suppression, timeouts) and explicit DTR/RTS control — opening a port must not reset the board — are ours to write and are the least robust part of the system by nature. Its arrival is the rule-of-two trigger to widen the transport interface (`SshTransport` → `TargetTransport`, endpoint and pin shapes as discriminated unions); serial attach identity is the documented downgrade described under target resolution.

### Deferred

- Multiple simultaneously connected boards with a full device picker.
- Incremental block-level transfer.
- Board-side agent software and any resident target-side daemon. A narrowly scoped target-side privilege helper is also deferred; the strategy keeps a privilege runner seam for it.
- Active board discovery in any form (scanning, announcement listeners, or a device picker).
- Chip-specific flashing and recovery workflows beyond the selected deployment strategy.
- Recovery mode and bootloader flashing.
- Cloud, telemetry, or remote build services.

## 3. Proposed Architecture

```text
VS Code extension host (TypeScript, single process)
  ├─ VS Code surface: Commands / Status UI / OutputChannel
  ├─ CMake Tools artifact integration (resolves the already-built artifact)
  ├─ Debug launcher (CodeLLDB DAP configuration and session)
  └─ Core modules (no VS Code API imports; strict boundaries)
      ├─ Configuration and SSH target profile resolver
      ├─ Target Identity Service
      ├─ Attach Manager
      ├─ Strategy registry (contract, config schema, target validation)
      ├─ SSH Session Manager (`ssh2`)
      │   ├─ Exec channels
      │   ├─ SFTP transfer
      │   └─ Port-forward channels
      ├─ Artifact and Deploy Controller
      ├─ Host-side Debug Provider Controller
      ├─ Application deploy strategy (`linux.ssh-app`)
      └─ Small-core deploy strategy (`linux.remoteproc`, added in Phase 3)

Local machine
  ├─ CMake Tools
  ├─ Cross compiler and build directory (owned by the workspace)
  └─ Already-built target artifact

Target board
  ├─ Network interface reachable by the configured SSH target
  ├─ SSH server
  ├─ SFTP subsystem
  ├─ Linux device-tree / SoC identification
  └─ Application or configured strategy runtime
```

The SSH transport should be owned by one session manager behind a core-owned `SshTransport` interface. Upload, command execution, and log streaming should use separate channels over one SSH session rather than sharing one interactive shell. The manager must expose connection state and reconnect events to the service layer and the UI. Betelgeuz ships exactly one production transport for the MVP: the Node `ssh2` implementation, which keeps one connection and opens separate exec, SFTP, and forwarding channels. There is no dependency on a local `ssh` executable and no runtime dependency on the Remote - SSH extension. The interface exists so tests can substitute a fake transport; it is not a user-selectable production plugin point. The interface grows with demand: it starts as one narrow interface holding only the methods the first implementation needs, and splits into more focused interfaces only when a second implementation or real concurrency forces it — never into a speculatively layered interface hierarchy. Authentication and proxy capabilities that `ssh2` cannot express, such as unsupported key providers or proxy modes, are explicit unsupported cases that fail with a clear diagnostic; they are never silently delegated to another client.

The serialized profile and workspace override records live in the typed config module. The profile resolver overlays non-empty workspace values on the selected user profile, validates the endpoint, and returns an opaque credential reference; a separate credential provider loads its secret material. It does not parse external SSH configuration, import external known-host databases, invoke an external SSH client, or depend on an SSH agent. The transport accepts resolved credentials and a required host-key pin, and must verify that pin before exposing a session. The cached attach identity contains the endpoint, verified host-key fingerprint, and descriptor. Secrets are one-use sensitive wrappers: redacted in debug output and wiped on release — in TypeScript this is encapsulation and review discipline rather than a type-level guarantee.

The MVP authentication paths are a private-key reference resolved by the core and a password or passphrase held by VS Code SecretStorage. Host keys are pinned or explicitly enrolled in Betelgeuz's own profile store; an unknown host key never becomes trusted implicitly. Proxy chaining, if required, is represented by a typed Betelgeuz profile and implemented by `ssh2`; unsupported proxy forms fail with the explicit `profile.unsupported-proxy` diagnostic. The core never reads or writes external SSH configuration, agent sockets, or known-host files.

The core modules expose typed async service interfaces; the request and result shapes are the single typed vocabulary (they were the wire contract before the pivot to a single process, and `src/protocol/` keeps them as plain interfaces). Cancellation is carried through every operation, and notifications — connection state, target state, progress, output, structured errors — arrive as typed events. The boundary is editor-free by discipline: the surface adds CMake Tools and VS Code UI integration, while the core modules stay importable from tests without VS Code.

The module boundary is strict. The VS Code surface does not open SSH connections, parse target descriptors, construct remote commands, implement deploy strategies, or manage debug endpoint cleanup. The core modules do not depend on VS Code APIs, a DAP client, or a particular build frontend. An artifact record contains a local path, target name, configuration, and optional symbols path; the deploy controller validates and deploys that record but never invokes a build command.

Debug is host-centric. Betelgeuz keeps the host-side debugger (LLDB through CodeLLDB in the initial VS Code frontend), debug adapter, symbols, launch configuration, breakpoint state, and user interaction on the development host. The target supplies only the smallest debug endpoint required by the selected provider, preferably started for the current session over SSH and removed when the session ends. This follows the Black Magic design principle of keeping debug intelligence and symbols on the host; it does not require a Black Magic probe or a target-side permanent service.

Use one project workflow model: CMake Tools selects and builds a target outside Betelgeuz; the artifact integration resolves the resulting artifact; the workspace's active attach object binds that artifact to one strategy; and the strategy owns target-specific connection, deploy, lifecycle, validation, and diagnostics behavior. A strategy is a workflow bundle — artifact placement, activation, lifecycle verbs, inspection, and log source — coordinated by shared core services; it is not a separate subsystem and not one UI button.

For the MVP, a workspace has one active attach object. A strategy may internally address a specific endpoint or remote resource, but Betelgeuz does not need a global inventory of every capability in the chip. A Linux application workspace and a small-core firmware workspace can each attach to the same board through different strategies. Each workspace hands over its own artifact — the application executable or the small-core firmware image — through the same artifact handoff contract and the same shared deploy pipeline; what is shared is the mechanism, not the artifact.

The three layers stay separate: identity identifies what the target is, capability describes what the target exposes, and strategy describes how Betelgeuz operates it. Capabilities are not a modeled inventory; probe results feed the selected strategy's validation and nothing else.

The attach object is a workspace-scoped instance with a deliberate split between what is persisted and what is runtime. The persisted part is small: a target reference (`targetRef`, the profile or inline target fields), a strategy reference (`strategyRef`, the strategy ID), and the strategy configuration. The runtime part is owned by the core's attach manager: the verified identity cache, connection state with its optional `lastError`, target state, the running operation if any, and the operations the strategy exposes. The strategy ID selects one workflow implementation; for example, `linux.ssh-app` or `linux.remoteproc`. Strategy-specific details stay inside that implementation rather than becoming chip-wide settings or commands.

The attach connection state machine is deliberately small: `disconnected`, `connecting` (including host-key and descriptor verification), `attached`, and `reconnecting`. Each state carries an optional `lastError` (a catalog code) instead of a separate `failed` state, so the reason survives into every frontend; failure is a presentation decision, not a state. Only transport and identity events drive transitions. After any reconnect, the strategy's `inspect` is the source of truth before the UI reports target state. Attach configuration persists in workspace settings, identity pins with the shared target profile, and a created attach with its cached verified identity in frontend-persisted state (workspace state in VS Code); a window reload or core restart resets the connection to `disconnected` without forgetting which board was last verified, and opening a workspace does not auto-connect. `Connect` and attach-dependent commands such as `Deploy` connect on demand; an established connection that drops triggers bounded automatic reconnect without user action, while an explicit `Disconnect` stops all retries. Multiple workspaces attaching to the same physical board is a first-class scenario, not a conflict: each workspace holds its own attach object and connection to the shared board. Cross-attach coordination on one board is user-driven in the MVP; a global device inventory and cross-workspace operation locking remain deferred. A workspace here means one project folder, the unit of configuration and attach; a multi-root window simply hosts one attach object and strategy per folder.

Attach verifies only board identity: the resolved SSH endpoint, configured board identifier where available, and SSH host-key pin. Binding does not probe whether the selected strategy is supported by that target. After binding, each strategy validates the interfaces it needs before offering or executing its operations. If `linux.remoteproc` finds no usable instance, it reports that the selected strategy cannot operate on this target and offers to switch to the application strategy or select another board.

### Attach semantics

An **attach** is the verified binding between one workspace's deployment workflow and one physical board. It is a workspace-scoped instance that binds a user-selected deploy strategy, such as `linux.ssh-app` or `linux.remoteproc`, to a board whose identity has been verified against the target profile's pins. It answers exactly the question the generic commands need answered: where do `Deploy`, `Start`, `Stop`, and `Debug` act, and through which workflow. A strategy is the workflow implementation; the attach is its workspace-bound instance. The command layer routes every verb to the active attach's strategy and never addresses a board or chip resource directly. Strategy-target compatibility is evaluated after binding and before the relevant operation.

The attach lifecycle follows a create-on-verify model:

- An attach object is created only after the first successful identity handshake: SSH host-key verification and descriptor comparison against the target profile's pins. Before that, the workspace has configuration but no attach, and attach-dependent commands run the attach flow.
- Once created, the attach persists with its cached verified identity in frontend-persisted state (workspace state in VS Code). It survives SSH disconnects, core restarts, and window reloads; `Inspect Attach` can report the last verified board even when offline.
- The connection is a state of the attach, not the attach itself. Reconnect re-validates identity before the UI reports target state, and `inspect` remains the source of truth.
- Changing the target profile, or a pin mismatch on revalidation, invalidates the attach: the old binding is discarded and a new handshake creates a new attach. A pinned value is never silently updated from newly observed data.
- The MVP has one active attach per workspace. The same physical board used by an application workspace and a firmware workspace is two attach objects sharing one target profile and one set of pins; there is no global device registry. Sharing exists only at the profile layer: the attach object, SSH connection, deploy strategy, artifact, and retained previous version are all per workspace.

Terminology: "attach to process" is reserved for the debug sense of attaching a debugger to a running target process. `Debug Attached Target` means debugging the active attach's target, whether by launching the deployed artifact or by attaching to a process.

### Target resolution and hardware descriptor

The resolved hardware object is a target descriptor, not a global capability inventory. It identifies the board that can be attached to and provides enough metadata for the selected strategy to validate its target. Resolution is profile-based: loading a saved Betelgeuz profile and connecting is the whole operation. Betelgeuz never scans the network or listens for announcements; hostnames are resolved by the OS, so mDNS-style `.local` names work without any Betelgeuz feature. Resolution and verification have four stages:

1. **Target resolution**: load the workspace's Betelgeuz-managed SSH target profile. The profile supplies the hostname or address, port, username, credential reference, and expected host key.
2. **Secure endpoint identity**: connect with SSH and verify the configured or enrolled host key before trusting data returned by the board. A hostname, IP address, or broadcast payload is never sufficient identity.
3. **Hardware descriptor**: query a small, read-only descriptor from the target, preferably a board-provided `/etc/betelgeuz/device.json` with fields such as `deviceId`, `boardId`, `boardRevision`, `socId`, `compatible`, `model`, and `protocolVersion`. If that file is absent, use standard Linux sources such as device-tree model/compatible and a stable serial or machine identity where available, and mark missing fields as unknown. Device-tree `compatible` entries remain separate values so a configured SoC pin can match an individual entry. The probe has a 10-second deadline; on expiry Betelgeuz requests command termination and closes the SSH session. On stock vendor and community images the descriptor file is normally absent, so the common case is device-tree derived metadata combined with a pinned host key as the authoritative identity; a user who wants a stable `deviceId` can provision the descriptor file themselves following the documented how-to.
4. **Attach binding**: compare the descriptor and SSH identity with the resolved target profile, then create the active attach object for the user-selected strategy. The target profile may pin `deviceId`, `boardId`, `socId`, or host key; an unpinned field is informational and must not silently override a pinned field. If no stable `deviceId` is available, require a pinned host key and show that the target is identified by transport identity only. Binding does not inspect target interfaces or infer supported strategies. If no strategy has been configured, the picker offers the strategies implemented by the installed Betelgeuz version, grouped by role (for example, big-core application or small-core firmware); selecting one immediately creates the attach after identity verification. The selected strategy probes its own required interface when its operations are prepared or run and returns an actionable unsupported-target diagnostic if needed. Future strategies such as the K230 loader are not offered before they are implemented. Re-running `Select SSH Target` allows the user to choose a different strategy.

The descriptor is untrusted metadata until the SSH host key has been verified. It is used for board identity and diagnostics, not to infer strategy compatibility or every capability of the chip. After attach, the selected strategy performs its own target probe: `linux.ssh-app` checks application paths and process/service controls, while `linux.remoteproc` checks its configured small-core instance and controls.

## 4. Target Board Contract

Lichee RVNano running a supported vendor or community Linux image is the sole Tier 1 board. Other boards, including Orange Pi and RK3506 families, are future support targets and are not implied to work by the generic SSH design. Tier 1 imposes no board-side Betelgeuz software requirement beyond standard SSH and SFTP. A board-provided hardware descriptor and service unit templates are recommended enhancements with fallbacks; a narrowly scoped privilege helper is optional; a resident board-side agent is not required.

The initial board contract should be explicit and small:

- The board is reachable through the configured SSH target profile or, as a follow-on, a serial console. The profile contains a DNS name, fixed IP address, or another directly reachable endpoint managed by Betelgeuz; a serial profile names a port and baud rate.
- SSH listens on a configurable port, initially `22`.
- The configured user has SFTP access and permission to replace and execute the remote artifact.
- The board has a stable SSH host key.
- The board can run the configured stop and start commands.
- The configured attach target can be distinguished from other reachable devices using a stable board identifier where available and SSH host-key verification.
- The target can return a read-only hardware descriptor with a stable `deviceId` or an explicit indication that no stable ID is available.
- The target exposes the small POSIX/Linux surface needed by the selected strategy (`/proc`,
  `/sys` where applicable, `stat`, `readlink`, `test`, `kill`, and a shell or fixed launcher
  entry point). Capability probing must report a missing utility or filesystem interface as an
  explicit unsupported state; it must not assume a full distribution userland.
- Each strategy verifies the specific target-side interface it needs. For Linux `remoteproc`, the selected instance is available under `/sys/class/remoteproc` and the configured account or a narrowly scoped helper can manage it.

After connection, the Target Identity Service reads the hardware descriptor once and stores it with the attach status. The selected strategy then queries only the target state it needs. The `remoteproc` strategy inspects its configured instance and firmware controls; the SSH application strategy checks its remote path and process controls. Board/SoC information is available for identity and diagnostics, but it is not used to gate attach creation or build a global capability inventory.

Endpoint resolution alone is not sufficient for identifying multiple boards. A stable `deviceId` is preferred; when it is unavailable, a pinned SSH host key plus the configured endpoint is the minimum attach identity. A serial-console connection presents no host key: its attach identity is a pinned `deviceId` where available, otherwise an explicit user confirmation of the port binding — an accepted, documented downgrade from the SSH transport's cryptographic guarantee.

### Linux userspace runtime contract

The SSH application strategy needs a target runtime contract in addition to an SSH connection.
The target probe records the kernel machine and endianness, ELF class and ABI expectations,
libc family/version when discoverable, dynamic loader path, writable filesystem status, and the
available process/service controls. An ELF artifact is accepted only when its machine, class,
endianness, ABI and interpreter are compatible with that probe; a raw binary must declare its
format and architecture in the workspace configuration. The probe may report unknown libc
details, but an explicitly incompatible interpreter or ABI is a hard failure. This avoids
mistaking a successful upload for a runnable program on a musl/glibc or 32/64-bit mismatch.
For dynamically linked ELF files, `DT_NEEDED` entries may be compared with the target's known
loader/library inventory when available; this check is best effort and must never execute the
untrusted artifact through `ldd`. A missing library discovered only at launch is reported as a
runtime failure with the loader diagnostic.

An application launch is a structured request consisting of an executable path, an argument
array, a working directory, an environment map, and an output/termination policy. The core
constructs a fixed launcher template and passes values as positional arguments or an equivalent
structured command representation. A free-form shell command is not part of the contract, so
spaces, shell metacharacters, and user-provided environment values cannot change the command
being executed. Because SSH exec ultimately receives a command string, the core must use a
fixed wrapper plus a formally tested encoding/quoting layer (or an uploaded transient launcher)
for those structured values; direct string concatenation is forbidden. The default working
directory is the deployed file's parent, the default environment is the target service/session
environment, stdin is closed, and stdout/stderr are captured as byte streams with an explicit
size-limited ring buffer. PTY allocation is disabled for lifecycle operations.

The target user must be able to create the working directory, replace the staged file, set its
configured mode, and execute it. Deployment fails before activation when the
destination filesystem is read-only, mounted `noexec`, lacks space, or cannot preserve the
requested mode. The commit operation stages and validates the file on the same filesystem as
the destination, flushes the file where the platform permits, atomically renames it, and then
re-applies the configured mode while preserving owner/group; changing ownership requires the
strategy's explicit privilege policy. Retained previous versions have a bounded count and size
budget so recovery cannot silently exhaust target storage.

Foreground lifetime is an explicit strategy policy. The core records the remote PID and process
group, observes channel closure, and reconciles the process on reconnect; it must not infer an
exit from a lost SSH channel alone. A target capability probe determines whether the configured
disconnect policy can terminate the process group reliably. If it cannot, the core reports the
runtime as potentially orphaned and requires service mode or an explicit cleanup action rather
than claiming that foreground execution is connection-scoped. Service mode is limited to a
pre-provisioned systemd unit in the first implementation, with its user/system scope, restart
policy, environment, and log source probed before the command is enabled.

## 5. Workspace Configuration

Use a namespaced configuration such as `betelgeuz`. Configuration has two layers with different owners: a **target profile** describing the physical board, and the **attach configuration** describing this workspace's use of that board.

A workspace's attach configuration is workspace-scoped:

```json
{
  "betelgeuz.target.profile": "my-board",
  "betelgeuz.attach.strategy": "linux.ssh-app",
  "betelgeuz.deploy.localTarget": "my_app",
  "betelgeuz.deploy.artifactPath": "build/my_app",
  "betelgeuz.deploy.remotePath": "/opt/my_app",
  "betelgeuz.deploy.executable": "/opt/my_app",
  "betelgeuz.deploy.args": [],
  "betelgeuz.deploy.cwd": "/opt",
  "betelgeuz.deploy.environment": {},
  "betelgeuz.deploy.fileMode": "0755",
  "betelgeuz.deploy.runMode": "foreground",
  "betelgeuz.deploy.serviceUnit": "my_app.service"
}
```

The target profile holds the SSH endpoint fields and the identity pins and is shared across workspaces. One physical board may serve several workspaces at once, for example an application workspace using `linux.ssh-app` and a small-core firmware workspace using `linux.remoteproc` where the realtime core is loaded through the firmware workspace. `betelgeuz.target.profile` names a Betelgeuz profile defined in user settings:

```json
{
  "betelgeuz.profiles": {
    "my-board": {
      "host": "192.168.7.1",
      "port": 22,
      "username": "root",
      "credentialRef": "board-key",
      "hostKey": "SHA256:...",
      "keepaliveSeconds": 30,
      "proxyChain": [],
      "deviceId": "",
      "boardId": "",
      "socId": ""
    }
  }
}
```

The core resolves the named profile first, then overlays non-empty inline target values; the SSH port defaults to `22`. An explicitly selected but missing profile is an error even when some inline values exist. Resolution validates the endpoint fields and returns credential references without loading secret material. A missing host-key pin enters an explicit enrollment flow; it never authorizes reading the target descriptor. Identity pins come only from the profile, inline settings, or that explicit user enrollment action, never from the hardware descriptor or any observed target value. Passwords, private-key passphrases, and credential material remain in VS Code SecretStorage or the frontend's equivalent protected store; only one-use password/passphrase values are sent to the core for an active connection. Host-specific paths such as a debugger executable are machine-scoped settings.

`keepaliveSeconds` defaults to `30`. `proxyChain` is an ordered list of typed SSH hops; each hop has its own endpoint, credential reference, and required pinned host key. Arbitrary proxy commands and unpinned proxy hops are rejected. Frontends supply one-use password/passphrase values keyed by credential reference so each hop can use distinct protected credentials.

The SSH application strategy supports two run modes. `foreground` starts the program in an SSH exec channel, streams its output, and ties the session to the current connection. `service` delegates persistence, restart policy, and status to a target service manager such as systemd, so the process can survive frontend or core shutdown and SSH loss. A service manager is a target-side facility, not VS Code Server. In `service` mode, `betelgeuz.deploy.serviceUnit` names a unit already provisioned by the target image or the user; Betelgeuz does not generate, install, or modify service unit files.

Strategy-specific attach configuration lives in the same settings namespace under `betelgeuz.attach.<strategy>.*`, so each workspace selects its own strategy and target. A firmware workspace could use:

```json
{
  "betelgeuz.attach.strategy": "linux.remoteproc",
  "betelgeuz.attach.linux.remoteproc.instance": "30070000.remoteproc",
  "betelgeuz.attach.linux.remoteproc.firmwarePath": "/lib/firmware/rtos_firmware.elf",
  "betelgeuz.deploy.localTarget": "rtos_firmware"
}
```

The `betelgeuz.deploy.localTarget` entry identifies the target selected in CMake Tools whose existing artifact is consumed; it does not configure or invoke a Betelgeuz build step. During the Phase 1 manual slice, `betelgeuz.deploy.artifactPath` supplies that existing file directly; CMake Tools handoff replaces this setting in Phase 2. `executable`, `args`, `cwd`, `environment`, and `fileMode` are structured launch/deploy settings; they are never concatenated into an arbitrary shell command. In service mode, the pre-provisioned unit owns the effective command and environment, while these settings are used for foreground mode only. The `betelgeuz.deploy.artifact` key for multi-artifact targets arrives in a later phase; the MVP deploys only targets with exactly one artifact. Each strategy validates only its own keys under `betelgeuz.attach.<strategy>.*`; keys belonging to another strategy are ignored.

Passwords, private keys, and private-key passphrases must not be stored in ordinary workspace settings. Use VS Code SecretStorage or the frontend's equivalent protected store for credential material and host-key enrollment data. The core receives only the credential it needs for the active session.

## 6. Artifact and Deploy Flow

### Artifact handoff

1. Read the active CMake target and configuration from CMake Tools or its generated metadata.
2. Resolve the path of an artifact that has already been produced by CMake Tools, using the CMake Tools API when available and the CMake File API codemodel as the fallback.
3. Verify that the artifact exists and normalize it into an `Artifact` record containing path, target name, configuration, size, and content hash.

Betelgeuz does not invoke CMake configure or build commands, register a replacement Build command, parse CMake build failures, or mirror CMake Tools output. CMake Tools remains responsible for all build actions and build diagnostics. Betelgeuz does not check artifact freshness against sources either: Deploy consumes whatever the selected target's last build produced, and freshness is the build owner's concern. Artifact selection in the MVP follows an exactly-one rule: a target with one artifact deploys it directly, and a target that produces several, such as an ELF plus an `objcopy` binary, fails with `artifact.ambiguous` and lists the candidates rather than guessing. Multi-artifact selection through a `betelgeuz.deploy.artifact` suffix/pattern key arrives in a later phase. Deploying multiple files together is deferred.

For Linux userspace artifacts, host-side checks cover ELF class, machine, endianness, ABI and
interpreter metadata; the target probe supplies the runtime compatibility facts. Deployment
creates the destination directory when the workspace's `remotePath` names one that does not
exist yet, then checks destination writability, executable permission, filesystem space, and
same-filesystem staging before it reaches the commit point. Activation replaces the destination
atomically (`posix-rename`); a target whose SFTP server cannot do that is refused with
`deploy.activation-unsupported` rather than risking the deployed artifact through a non-atomic
replacement. A failed preflight leaves the active
artifact and running process untouched; an uncreatable destination directory reports
`deploy.preflight-failed` before anything is staged.

### Attach and deploy

1. Create or restore the workspace's configured attach object and validate target identity.
2. Ask the active strategy to validate the artifact and target state.
3. Run the strategy's deployment procedure with progress and cancellation support.
4. Let the strategy apply its target-specific atomicity, permissions, firmware selection, or staging rules.
5. Report the final target state through the common attach status model.

### Operation semantics

Each attach object runs at most one mutating operation (`Deploy`, `Start`, `Stop`, `Restart`) at a time. A second invocation while one is running fails immediately with a busy error; operations are not queued. `Deploy` never implicitly stops a running target. If the strategy cannot replace the artifact while the target is active, the operation fails with a clear diagnostic and offers an explicit stop-then-deploy confirmation; stopping target work always requires explicit user action.

Cancellation has a strategy-defined commit point. Before it, for example with a staged temporary upload or an unselected firmware image, cancellation leaves the target untouched and removes staging artifacts. After it, for example an atomic rename into place or a remoteproc firmware selection, cancellation is refused and the operation runs to completion or to a definitive failure. An interrupted `linux.remoteproc` sequence always reports whether the small core is left stopped and offers `Start`.

When a strategy declares previous-version retention and restore support, the shared operation coordinator applies its retention limits and exposes `Restore previous version`; the strategy implements the target-specific restore procedure. This is best-effort recovery, not a rollback guarantee. Strategies that cannot safely retain or restore an artifact report that the operation is unavailable.

### Deploy strategy contract

The core provides a shared operation coordinator for artifact handoff, identity checks, busy locking, progress, cancellation, and structured errors. A strategy declares which deployment stages it supports and implements target-specific validation, staging, commit/activation, lifecycle, inspection, and log operations. File-based strategies may use the common SFTP staging helper; atomic rename, previous-version retention, and restore are capabilities a strategy can provide, not assumptions imposed on every strategy. For example, `linux.ssh-app` uses same-filesystem staging and atomic rename, while `linux.remoteproc` selects firmware and starts the core after staging. Strategy operations follow a common contract such as `validate`, `inspect`, `deploy(artifact)`, `start`, `stop`, `restart`, and `getLogs` where applicable. `start` returns or records a strategy-specific runtime handle, while `inspect` remains the source of truth after reconnect. A strategy may declare unsupported operations for its attach. All strategies use the core-owned SSH session and transport; external transports or chip-specific flashing are outside the current scope. `linux.ssh-app` and `linux.remoteproc` are peers in this contract. Big-core and small-core labels are UX groupings for user selection, not a second architectural layer.

Strategies are registered capabilities, not hardcoded command branches. Each implemented strategy registers its ID, role, configuration schema, error-code namespace, privilege class, and validation entry points. The user selects a strategy from those implemented by the installed Betelgeuz version; binding depends only on successful SSH identity verification and does not require a strategy probe. The selected strategy probes its own interfaces before enabling or executing operations and reports incompatibility with a concrete remedy. This is operational validation, not board-wide discovery or automatic strategy selection. All strategies share the core's SSH session and transport machinery; a strategy never opens its own connection. In the MVP the registry is compile-time — adding a strategy means adding one module and its metadata to the core — while third-party dynamic strategy loading is deferred until there is demand.

The shared method names do not imply the same target semantics. In `linux.ssh-app`, `start` launches a Linux userspace process and `inspect` checks that process or its service. In `linux.remoteproc`, `start` writes the remoteproc control interface for a small core and `inspect` reads the remoteproc state and firmware metadata. Each strategy owns this distinction.

The common Betelgeuz workflow is `Deploy`, `Start`, `Stop`, and `Restart` against the active attach object. `Deploy` consumes the already-built artifact for the selected target and never starts an implicit build. The active strategy supplies the concrete meaning and implementation of deployment and lifecycle actions. The command layer does not need to know whether the selected CMake artifact is a Linux application or small-core firmware.

Debugging is an optional integration associated with the active attach, not an implied feature of every deployment strategy. A strategy may provide a host-side debug provider or identify a compatible external provider. If none is configured and available, Betelgeuz does not expose a Debug action. The core provider owns target-side endpoint startup, port forwarding, and teardown; the frontend launches the host-side debugger session against the prepared endpoint.

### Error model

Strategies and services fail with structured errors, never with free-form user-facing text. An error carries a stable machine code, the failed phase, a retriability flag, an optional target state at the abort point (for example the small core's `remoteproc` state), and the underlying cause for the log. The frontend maps the code to a uniform message and one concrete remediation action, so error quality does not depend on which code path happened to fail.

Three rules keep the model from drifting:

- Common core errors are defined in one catalog module; each strategy owns definitions for its namespaced errors. Every definition carries its phase, retriability, and a stable remediation action ID. `docs/ERRORS.md` is generated from the common and strategy catalogs, and the UI maps codes and action IDs to presentation.
- Each contract method declares the set of codes it can return as its error type, and contract tests assert them. Common codes (`ssh.*`, `deploy.*`, `identity.*`, `artifact.*`) are shared by all strategies; strategy-specific codes are namespaced per strategy (`rproc.*` for `linux.remoteproc`, with similar namespaces for future small-core strategies) and pass through with strategy-provided remediation.
- Unexpected failures collapse to `internal.unexpected` with the failed phase carried along. Notifications never show raw stack traces; the full cause goes to the OutputChannel under a correlation id.

The table below shows human-readable action descriptions. The error
`remediation` field carries a stable action ID that the UI layer maps to its
own commands and wording. UI-only failures, such as a missing DAP
extension, remain local to the surface and do not enter the catalog.

The initial catalog:

| code | phase | meaning | user-facing action | retriable |
| --- | --- | --- | --- | --- |
| `protocol.mismatch` | config | frontend and core speak incompatible protocol versions | upgrade one side | no |
| `profile.unresolved` | profile | target profile not found or incomplete | check the Betelgeuz profile settings | no |
| `profile.unsupported-proxy` | profile | profile uses a proxy form the transport cannot express | fix the profile's proxy settings | no |
| `config.invalid` | config | invalid `betelgeuz.*` setting value | open settings at the offending key | no |
| `ssh.unreachable` | connect | timeout, refused, or unresolvable endpoint | check network and SSH service | yes |
| `ssh.auth-failed` | connect | authentication failed | check user and key credentials | no |
| `ssh.handshake-failed` | connect | key exchange or key format failure before auth | check client/server algorithm configuration | no |
| `ssh.hostkey-mismatch` | identity | presented host key does not match the pin | compare fingerprints and review the pin | no |
| `ssh.lost` | connect | connection dropped during an operation | automatic reconnect, then retry | yes |
| `identity.descriptor-mismatch` | identity | descriptor does not match the pinned identity | review pins or choose another board | no |
| `identity.descriptor-timeout` | identity | reading the descriptor from the target timed out | retry | yes |
| `identity.descriptor-unreadable` | identity | the target returned a descriptor that could not be read | inspect the log for the parse detail | no |
| `identity.instance-changed` | identity | strategy instance identity changed since binding | re-run `Select SSH Target` | no |
| `strategy.unsupported-target` | validate | selected strategy cannot find a required target interface | select a strategy supported by the target | no |
| `artifact.missing` | artifact | no existing artifact for the selected CMake target | build with CMake Tools (never implicitly) | no |
| `artifact.arch-mismatch` | artifact | host-side format/architecture validation failed | check toolchain and core selection | no |
| `artifact.runtime-incompatible` | artifact | ELF ABI, dynamic loader, or target runtime is incompatible | check the target sysroot/libc and rebuild for the target | no |
| `artifact.runtime-probe-failed` | artifact | reading the target runtime information for deployment failed | retry | yes |
| `artifact.ambiguous` | artifact | target produces multiple artifacts; the single-artifact rule applies in the MVP | deploy a single-artifact target (selection arrives in a later phase) | no |
| `deploy.busy` | deploy / lifecycle | another mutating operation is running | retry after it finishes | yes |
| `deploy.cancelled` | deploy | cancelled before the commit point; target unchanged | informational | no |
| `operation.cancelled` | any | a user-cancelled operation stopped before completion | informational | no |
| `deploy.upload-failed` | deploy | staging upload failed; nothing activated | retry | yes |
| `deploy.commit-failed` | deploy | activation failed; carries target state | `Restore` the previous version or retry | depends on state |
| `deploy.activation-unsupported` | deploy | the target's SFTP server cannot replace a file atomically | use a target SFTP server that supports `posix-rename` | no |
| `deploy.preflight-failed` | deploy | destination is read-only, `noexec`, out of space, or cannot apply requested permissions | fix target storage, mount, or permissions | no |
| `privilege.denied` | deploy / lifecycle | templated command needs root or sudo | check account privilege mode and sudo whitelist | no |
| `rproc.instance-missing` | lifecycle | no standard `remoteproc` interface for the core | re-classify the workspace as big-core or choose another board | no |
| `rproc.stop-failed` | lifecycle | stop failed; deployed firmware untouched | retry | yes |
| `rproc.crashed` | lifecycle | core crashed; carries kernel log tail | `Restore` the previous version | no |
| `rproc.state-timeout` | lifecycle | state wait timed out; carries last observed state | inspect trace output | yes |
| `debug.gdbserver-missing` | debug | `gdbserver` absent on the target | install `gdbserver` (or copy a transient static one) | no |
| `runtime.service-manager-missing` | lifecycle | configured service mode has no supported systemd unit or manager | use foreground mode or provision the unit | no |
| `runtime.orphan-risk` | lifecycle | foreground disconnect policy cannot prove process termination | use service mode or run explicit cleanup | no |
| `internal.unexpected` | any | unexpected failure; carries phase and cause | show log | no |

Error presentation follows Remote-SSH semantics that users already know: failures are labelled by phase (resolve profile, connect, authenticate, verify identity, deploy, lifecycle, debug — mirroring Remote-SSH's resolve/connect/authenticate/start-server labels); retriable failures show bounded reconnect attempts and stop on explicit disconnect; every surfaced error offers a path to the log with the raw transport output; host-key prompts show the fingerprint and are never auto-accepted. The classic SSH failure patterns users recognize from Remote-SSH output — permission denied, connection refused or timed out, host key verification failed, too many authentication failures — map onto the `ssh.*` codes above; because the transport is `ssh2`, that mapping lives at the transport boundary over library error events instead of parsing `ssh(1)` output.

Phase 0 delivers common core error definitions, strategy-owned namespaced error definitions, the generated `docs/ERRORS.md` catalog, the frontend remediation action map, per-method error sets in the strategy trait signatures, transport error mapping, and catalog/docs synchronization checks.

### Debug provider contract

The common debug contract should expose operations such as `prepare`, `launchEndpoint`, `connect`, `disconnect`, and `cleanup`. The contract returns a local debugger configuration and a runtime handle; it does not require the core to understand GDB packets or chip-specific register maps.

- **`linux.ssh-app`**: use the host-side debugger through the frontend's DAP integration — LLDB via CodeLLDB in the initial VS Code frontend. Start `gdbserver` only for the debug session, bind it to the target loopback interface where supported, and reach it through an SSH port forward. The target carries the application and `gdbserver`; the executable, symbols, breakpoints, and debugger logic remain on the host. Support both launching a deployed application and attaching to a selected PID (debug attach to process) when permissions allow it.
- **`linux.remoteproc`**: `remoteproc` start/stop and state reporting do not imply debug support. Expose Debug only when the target and board profile provide a software debug endpoint such as a firmware GDB stub, RPMsg/OpenAMP debug service, vendor debug server, or another compatible provider. The host still owns GDB, symbols, and the DAP session.
- **External probe**: allow a JTAG, SWD, OpenOCD, or vendor provider when the board profile supplies one. This remains an alternative provider and is not required for SSH application debugging.

The debugger data path uses GDB Remote Serial Protocol (RSP), while Betelgeuz's provider control remains separate. A provider may use a small RPC or command channel to start and stop an endpoint, but Betelgeuz must not implement a new remote debug protocol when an existing `gdbserver` or compatible RSP endpoint is available. Debug endpoints must not listen on a public target interface by default; prefer SSH stdio or loopback plus SSH forwarding.

Debug lifecycle:

1. Resolve the existing CMake artifact and its local debug symbols.
2. Prepare the selected provider and verify target permissions and architecture, including target-side prerequisites such as `gdbserver`. Stock images often omit `gdbserver`; the provider reports a clear remediation, and copying a transient static `gdbserver` for the session and removing it afterwards is acceptable because nothing is installed or left resident.
3. Start the temporary target endpoint or external debug server.
4. Have the core create the SSH forward or local transport and manage its cleanup, while the frontend launches the host-side DAP/GDB session.
5. On debugger exit, explicit stop, SSH loss, or frontend/core shutdown, close the local session, remove forwarding, and terminate the temporary target endpoint.
6. Do not stop a systemd application or `remoteproc` firmware merely because the debug endpoint ended unless the selected provider explicitly owns that target lifecycle.

### The application strategy: `linux.ssh-app`

This section is the application strategy's specification, standing as a peer of the small-core strategy below.

No VS Code Server is needed to run a target process. The core opens SSH exec channels for commands and keeps a channel open only when it is streaming a foreground process.

- **Foreground mode** streams stdout and stderr to the Betelgeuz OutputChannel and reports the exit code or terminating signal. The start command is a fixed template that `exec`s the program directly, so it stays the command of the exec channel: the server has already put that command in its own session and process group, its exit status is the run's outcome, and the run ends when the channel closes. Launches never detach (`setsid`, `nohup`, backgrounding) — a detached program becomes a grandchild the channel can neither report nor signal. `Stop` signals that group — `SIGTERM`, a configurable grace period (five seconds by default), then `SIGKILL` — and the reported outcome names the terminating signal; broad process-name matching is never used. A lost SSH channel triggers reconciliation and the configured disconnect policy; the core does not assume that the process received `SIGHUP` or already exited. If the target cannot prove cleanup, it reports `runtime.orphan-risk` and requires service mode or explicit cleanup. Exit reporting distinguishes a normal exit code, a crash signal, and a user-requested stop.
- **Service mode** starts, stops, restarts, and inspects the application through a target service manager. Logs come from the service manager or a configured log source. Service mode is a conditional capability requiring a supported service manager on the target image, systemd in the first implementation; images without one, such as busybox-based builds, use foreground mode.
- **Fetch recent output** follows the VS Code scrollback model: output history lives host-side, in the core's per-session ring buffer (the last lines of the current and previous foreground session, lost on core restart), while in service mode it tails the service manager's log source. Persistent remote log files and journal integration remain a Phase 7 (Optimization) item.
- After an SSH disconnect, the strategy reconnects and queries process or service state before updating the UI. It must not infer that a process stopped merely because its SSH channel closed.
- A running Linux application process is execution state, not proof of application health. Optional health probes, heartbeats, or service health may provide stronger evidence.

The first SSH application implementation should prefer foreground mode and systemd service mode. A custom detached launcher is a later option and must persist an unambiguous process identity, such as a PID file tied to the deployed artifact, before it can support stop or status operations. Do not use broad process-name matching such as `pkill -f` as the default control path.

### The small-core strategy: `linux.remoteproc`

Small-core firmware workspaces are served by a deploy strategy behind the common contract. `linux.remoteproc` is the first such strategy: the small-core deploy method the shared pipeline runs when the workspace's role is small-core firmware and the board exposes the standard Linux `remoteproc` interface — a different deploy, not a separate subsystem. SoC vendors also expose proprietary small-core control mechanisms, such as mailbox-based control in the Rockchip family or vendor loaders like the Canaan K230's; each of those is a future strategy behind the same contract, never something the remoteproc strategy emulates. A board whose small-core control is such a vendor mechanism is not labelled unsupported as a board: it remains fully usable as a big-core target, and small-core support arrives when its strategy is added. A small-core workspace bound to a board with no supported small-core strategy yet produces a diagnostic offering the concrete remedy of re-classifying the workspace as big-core or selecting another board. The `linux.remoteproc` strategy inspects the configured instance's name, state, current firmware, and supported controls, and is not the process runner for ordinary Linux applications. The instance setting addresses the configured core by its `name`, which is stable per device tree, and accepts `remoteprocN` only as a convenience that is resolved to a name at attach time and re-validated on every reconnect; a changed or ambiguous name is an identity failure, never a silent re-target. The strategy maps the shared pipeline stages as follows:

1. Use CMake Tools to produce the selected firmware artifact with its configured toolchain.
2. Validate the artifact host-side before touching the target: format and architecture checks against the configured core, such as ELF header parsing or a declared raw binary, so a wrong image fails before the core is ever stopped.
3. Inspect the configured `remoteproc` instance and confirm its resolved identity, current state, and selected firmware.
4. Upload to a staging file inside the firmware search path, on the same filesystem as the firmware location, while the core keeps running; this stage is fully reversible.
5. Stop the core if it is running, following the profile's policy and requiring explicit confirmation when stopping may interrupt active work.
6. Move the staged file into the configured firmware location — the commit point — then select it through the `firmware` attribute.
7. Start the core and wait for the state transition with a configurable timeout and a short poll interval. `running` is success, `crashed` is failure, and a timeout reports the last observed state without guessing.
8. Surface trace/output and errors when the kernel exposes them.

Failure handling reports the core's actual state at every abort point and offers the concrete next action: an interrupted upload leaves the core running and removes the staging file; a failed stop aborts without touching the deployed firmware; a failed move or firmware selection leaves the core stopped and offers `Start` with the retained previous firmware or a retry. For this strategy, `Restore previous version` re-selects the retained firmware and starts the core. Linux `remoteproc` has no universal firmware rollback mechanism, and a board whose profile defines a real rollback path may extend it. A core in `crashed` state surfaces the kernel log tail where permissions allow and the `recovery` attribute's configured behavior before any retry.

The strategy's privileged operations are a fixed, templated command list — firmware placement, remoteproc stop/start/state, trace reads — that never interpolates user input. The MVP supports two privilege modes: a root SSH account, or a normal account with the narrowly scoped `NOPASSWD` sudo whitelist that Betelgeuz documents and publishes. A target-side helper of the `betelgeuz-rprocctl` kind is deferred to a follow-on and, unlike an agent, would be a one-shot command-line tool rather than a resident component; the strategy issues commands through a thin privilege runner so a helper implementation can be added later without changing strategy logic. It must not claim that firmware is running based only on a successful file copy; the remoteproc state transition is the completion signal.

Runtime observation for this strategy reports the kernel remoteproc state and any trace or debug output exposed by the kernel and driver. A `running` state confirms that Linux started the small core, not that the small-core firmware's application-level work is correct. Firmware health requires firmware-provided evidence such as a heartbeat or a separately configured health probe.

## 7. VS Code User Experience

### Commands

The global command palette exposes generic workspace and active-attach operations:

- `Betelgeuz: Select SSH Target`
- `Betelgeuz: Connect`
- `Betelgeuz: Deploy`
- `Betelgeuz: Start Attached Target`
- `Betelgeuz: Stop Attached Target`
- `Betelgeuz: Restart Attached Target`
- `Betelgeuz: View Target Logs` (only when the active strategy exposes logs)
- `Betelgeuz: Debug Attached Target` (only when a compatible debug integration is available)
- `Betelgeuz: Disconnect`
- `Betelgeuz: Inspect Attach`

The target-selection command resolves the workspace's Betelgeuz SSH profile and then performs the secure identity and descriptor handshake. If the workspace has no strategy, it offers the strategies implemented in this Betelgeuz version, grouped by role; the choice is user-driven and does not depend on target-interface detection. It then creates the attach after identity verification. The selected strategy checks its own target requirements and reports incompatibility while preserving the attach. It never scans the network; the saved profile is the only source of a target. Deploy and lifecycle commands act on the workspace's active attach object and route through its selected strategy; they never name a specific chip resource or strategy. Deploy uses the selected target's existing CMake artifact and does not rebuild. The Betelgeuz view shows the selected strategy, run mode, connection state, and available logs/status. Attach-dependent operations are disabled when strategy validation fails. Debug is shown only when a compatible debug integration is configured. Strategy-specific commands such as “Start Real-Time Core” or “Start remoteproc0” are not registered.

### Status bar

Show a compact state such as `Betelgeuz: Disconnected`, `Betelgeuz: Connecting`, `Betelgeuz: Attached`, or `Betelgeuz: Reconnecting`. An error renders as `Disconnected` with its reason taken from `lastError` and surfaced through the notification and OutputChannel. The attach view should show the configured endpoint, selected strategy, connection status, and strategy-provided operations. It should not enumerate unrelated chip resources.

### Output

Use a dedicated `Betelgeuz` OutputChannel for attach state, SSH, build artifact resolution, deployment, foreground stdout/stderr, service logs, process lifecycle, debug session setup, and strategy logs. User-facing errors should identify the failed phase and offer an actionable remediation, such as checking the SSH profile, SSH service, host key, permissions, artifact path, firmware path, debugger executable, symbols, or selected strategy interface.

## 8. Implementation Phases

### Phase 0: Core and protocol decisions

- Define the core-module boundary and the typed service interfaces (the former wire-contract shapes).
- Follow the documentation and naming conventions in `docs/dev/README.md`: living guides under `docs/dev`, generated docs via `cargo xtask`, and defined vocabulary before first use.
- Define the editor adapter boundary; keep CMake Tools and VS Code UI integration in the VS Code adapter.
- Define the `SshTransport` interface and profile-resolution boundary.
- Adopt `ssh2` as the single MVP transport implementation; there is no external SSH client, configuration parser, agent integration, or fallback transport.
- Define the Betelgeuz-owned target profile schema, credential references, host-key enrollment, and supported typed proxy chain.
- Verify private-key loading and passphrase handling through the frontend's protected credential store on each supported host platform.
- Define package commands, configuration schema, common core error definitions, and strategy-owned error catalogs (`docs/ERRORS.md` is generated from both owners).
- Define the attach-object and strategy contract, configuration schema, and normalized artifact record.
- Define the SSH target profile, hardware descriptor, and attach identity schemas.
- Define the Linux userspace runtime probe and compatibility record: machine, ELF ABI/class,
  endianness, libc/interpreter, writable/noexec filesystem checks, process-group behavior, and
  supported service-manager scope.
- Define the Tier 1 capability matrix for Lichee RVNano's supported Linux images (BusyBox versus
  full userland, glibc versus musl, systemd versus foreground-only, and supported architectures)
  and the exact probe files/commands for each row. Other board families are outside Tier 1.
- Define VSIX packaging and integrity checks for the native core binaries, including executable
  permissions on Linux, missing-core recovery, and upgrade compatibility.
- Define how CMake Tools target selection and artifact paths map into the common workflow.
- Create a fake SSH transport for tests.

### Phase 0.5: Extension bootstrap

- Scaffold the VS Code extension and wire commands, status UI, and the OutputChannel to the core modules.
- Service calls carry cancellation and structured errors end to end; the catalog-to-presentation mapping lives in the UI layer.
- Keep the core modules callable from unit tests without VS Code: the fake transport and direct service calls are the harness. No product CLI is planned — see the resolved record.

### Phase 1: SSH profile MVP

- Resolve a workspace-selected Betelgeuz SSH profile in the profile module and perform reachability checks.
- Load only Betelgeuz-managed credentials and host-key pins.
- Read and validate the target hardware descriptor after SSH host-key verification.
- Bind the descriptor to the workspace attach object using configured identity pins.
- Implement SSH connect, keepalive, disconnect, and reconnect.
- Implement SFTP upload and atomic rename.
- Implement the `linux.ssh-app` strategy for deploy, foreground run with streamed output/exit status, stop, restart, status inspection, and configured logs.
- Implement structured foreground launch (`executable`, `args`, `cwd`, and environment), target
  runtime compatibility checks, permission/mode handling, and bounded host-side output buffering.
- Extend the status bar and OutputChannel with strategy operations and streamed target output.
- Offer the implemented `linux.ssh-app` strategy for the first attach flow. Attach creation verifies
  board identity only; the strategy validates its own runtime interfaces before its operations.

First working slice acceptance: from the VS Code adapter, `Connect` → host-key verification → descriptor read → SFTP upload to a scratch path → structured exec → streamed stdout → `Stop`, against the Tier 1 board. The slice consumes a manually supplied artifact record; CMake handoff (Phase 2), reconciliation depth (Phase 3), service mode (Phase 4), `linux.remoteproc` (Phase 5), and debug (Phase 6) are explicitly out of scope.

Implementation status: the current Phase 1 slice provides the manual artifact path, same-session
SFTP staging and atomic rename, configured mode application, structured foreground launch, bounded
host-side output history, streamed output, exit status, stop escalation, restart, status, and logs
commands. The current deploy path performs bounded ELF machine/class/endianness/interpreter
checks and a fixed target preflight for writable, free-space, and `noexec` state before staging;
reconnect reconciliation and systemd service mode remain outstanding within the later Phase 3/4
acceptance gates.

### Phase 2: CMake artifact integration

- Resolve the active CMake target and already-built artifact path through the CMake Tools API, then hand the normalized artifact record to the deploy controller. The record shape keeps build-system neutrality; only CMake Tools is in scope. Resolution is API-first with the File API codemodel as fallback.
- Add the standalone `Deploy` command; Deploy must not trigger a build.
- Support a workspace-level deployment profile for different binaries or boards.
- Add cancellation and clear failure reporting for artifact resolution and deploy.

### Phase 3: Reconnect and state reconciliation

- Reconnect with bounded backoff after a drop; an explicit `Disconnect` stops all retries.
- On reconnect, re-verify identity before reporting anything, then re-query target state through `inspect` and restore the UI; a dead channel is never evidence about the target.
- Keep the host-side output ring buffer serving `fetch recent output` after the process has ended or the connection dropped.
- Acceptance: a mid-session drop during and after a deploy reconnects, re-validates identity, restores accurate state, and reports the foreground process outcome without a window reload.

### Phase 4: Service mode (systemd)

- Add optional systemd service-managed run mode when the target service manager and pre-provisioned unit pass capability checks; expose a clear fallback to foreground mode otherwise.
- Service logs come from the service manager; service-managed applications remain controllable after the core disconnects.

### Phase 5: Small-core strategy (`linux.remoteproc`)

- Add the small-core role and `linux.remoteproc` strategy to the strategy picker and common contract.
- Bind the user-selected strategy immediately after SSH identity verification. Probe for the
  `remoteproc` interface after binding and report an actionable incompatibility without discarding
  the attach.
- Bind the workspace's selected CMake artifact to its configured attach strategy.
- Implement the `linux.remoteproc` deploy strategy: firmware upload, selection, stop/start, state reporting, and failure recovery.
- Publish the least-privilege target setup for firmware management: the root-SSH mode and the documented `NOPASSWD` sudo whitelist, with all privileged commands as fixed templates.

### Phase 6: Debug integrations

- Define the host-centric debug-provider contract and its temporary endpoint lifecycle.
- For Linux application workspaces, launch `gdbserver` over SSH on the target loopback interface, forward its port, and connect the host-side debugger (LLDB via CodeLLDB) through the frontend's DAP integration.
- Keep the executable, debug symbols, breakpoint state, and debugger control on the host; the target only runs the temporary `gdbserver` endpoint and the application being debugged.
- Support both launching a deployed application and attaching to a selected Linux process when target permissions allow it.
- For firmware workspaces, support a compatible software RSP provider such as a firmware GDB stub, RPMsg/OpenAMP debug service, or vendor debug server. Add JTAG/OpenOCD or another external probe provider where the board profile supplies one.
- Do not expose Debug for a `remoteproc` attach unless a compatible provider is available; `remoteproc` lifecycle support alone is insufficient.
- Map the CMake executable and local debug symbols into the selected host-side debugger configuration.
- Clean up target endpoints, port forwards, and provider-owned resources when a debug session ends, disconnects, or the frontend or core shuts down.

The debug controller owns target-endpoint and forward lifecycle; the VS Code surface owns only the DAP launch and session presentation. A window shutdown must reach the controller so temporary target resources are cleaned up.

### Phase 7: Optimization

- Add remote log file or journal integration.
- Add hash-based skip-upload and optional compressed transfer.
- Add multi-artifact selection: `betelgeuz.deploy.artifact` suffix/pattern matching for targets that emit several artifacts, such as an ELF plus an `objcopy` binary.
- Add recovery diagnostics for network disconnects and failed remote starts.

## 9. Testing Strategy

### Unit tests

- Service request validation, cancellation, and structured error mapping.
- SSH profile resolution, credential loading, host-key enrollment, typed proxy validation, and endpoint validation.
- Reconnect backoff, retry limits, and cancellation timing.
- Hardware descriptor parsing, missing-field handling, identity pin matching, and host-key mismatch.
- SSH state transitions.
- Upload path normalization and temporary-file cleanup.
- Atomic rename behavior on success and failure.
- Command construction with spaces and special characters.
- Configuration validation and SecretStorage access.
- Attach state transitions and strategy operation contract.
- Attach creation succeeds after SSH identity verification even when a selected strategy's
  required target interface is absent; the strategy reports `strategy.unsupported-target` and
  disables its operations.
- Existing artifact resolution for executable, library, and firmware CMake targets, including a clear ambiguity error for multi-artifact targets.
- Linux userspace runtime compatibility: ELF class/machine/ABI/interpreter, libc mismatch,
  structured argv/environment/cwd handling, permission and noexec checks, and retention limits.
- Strategy-specific runtime parsing and lifecycle state, including Linux `remoteproc` sysfs handling.
- Privilege/error handling and attach identity validation.
- Foreground process exit, service state, log retrieval, and state reconciliation after reconnect.
- Debug-provider selection, host-side launch configuration, target endpoint startup, RSP forwarding, and cleanup.

### Integration tests

- Extension integration: commands reach the service modules and surface attach state and errors end to end.
- Fake SSH/SFTP server for upload, permission, and command execution.
- Fake CMake Tools adapter for artifact resolution.
- CMake Tools API unavailable or absent: the File API fallback and the clear `artifact.missing`
  path must work without invoking a build.
- Simulated board disconnect during upload and during command execution.
- Host-key mismatch and authentication failure.
- Strategy contract tests for supported, unsupported, busy, and failed states.
- Firmware deployment interrupted before or after remoteproc stop, upload, selection, and start.
- Deploy without a valid existing artifact must fail clearly and must not invoke any CMake build command.
- Foreground process stdout/stderr and exit status are reported; after disconnect, process state is re-queried before the UI reports it.
- `Stop` terminates the process group: `SIGTERM` first, `SIGKILL` after the grace period, and the reported outcome names the terminating signal. Fetch recent output serves the ring buffer after the process has ended or the connection dropped.
- Service-managed applications remain controllable after the core disconnects, when the configured service manager is available.
- A foreground launch with spaces, shell metacharacters, and environment values reaches the exact
  structured argv/environment requested; no shell injection or argument splitting occurs.
- An incompatible ELF interpreter/ABI, read-only or `noexec` destination, insufficient space, or
  unprovable foreground disconnect cleanup fails before activation with the documented error.
- remoteproc `running` is presented as execution state, not as proof of firmware health.
- Linux application debug tests cover host-side debugger/DAP setup, temporary `gdbserver`, port-forward loss, debugger exit, and attach disconnect.
- `remoteproc` Debug is available only with a compatible software RSP, vendor server, or external probe; endpoint teardown is verified.

### Hardware acceptance tests

- Lichee RVNano running each Tier 1 supported Linux image, reached through a configured SSH profile over Ethernet or Wi-Fi.
- A Tier 1 board with a stable descriptor ID and a board profile relying on its pinned SSH host key.
- Descriptor mismatch must prevent attach.
- Large artifact upload and cancellation.
- Application crash, non-zero exit, and restart.
- Firmware update and restart through Linux `remoteproc` on a Tier 1 Lichee RVNano image that exposes the interface; verify rollback only when the profile defines a rollback mechanism.
- A Linux application workspace and a small-core firmware workspace deploy their own distinct artifacts — the application executable and the firmware image — through the same artifact handoff contract and shared deploy pipeline.
- Generic lifecycle commands must route to the workspace's active strategy; no Linux `remoteproc`-specific command should be registered.
- A selected `remoteproc` strategy must report a clear error when its configured instance is absent, busy, or partially exposed on the Tier 1 board.
- Selecting a strategy creates the identity-verified attach even when the target lacks that
  strategy's interface; strategy operations then report the specific incompatibility.
- A Linux application debug session works through `gdbserver` and local GDB when configured.
- A firmware debug action appears only when a compatible software RSP, vendor debug server, or external JTAG/OpenOCD provider is configured.

## 10. Security and Reliability Requirements

- Validate the SSH host key; never silently disable host-key checking.
- Use only Betelgeuz-managed connection profiles, credentials, and host-key pins; do not read or write external SSH configuration, agent sockets, or known-host databases.
- Never log passwords, private key material, or secret values.
- Treat configured launch environment values as secrets by default: do not echo them in command
  diagnostics, structured errors, or the OutputChannel.
- Treat board-provided metadata as untrusted input.
- Remote commands are structured invocations — executable, argument list, working directory, environment — never free-form shell lines assembled from input; the only shell forms are fixed templates with zero interpolation.
- Reject free-form remote launch commands; use the fixed launcher and tested argument/environment
  encoding described in the Linux userspace runtime contract.
- Use bounded reconnect backoff and stop retrying after explicit disconnect.
- Clean up temporary artifacts after interrupted uploads.
- Keep staging files on the destination filesystem, verify writable/`noexec`/space conditions,
  and enforce bounded retention of previous versions.
- Never activate a newly uploaded artifact until the strategy confirms upload completion and validation.
- Never treat a reachable IP as the configured attach target until identity checks pass.
- Never trust a hardware descriptor before SSH host-key verification.
- Do not replace a configured identity pin with a newly observed value without explicit user action.
- Do not use broad process-name matching as the default stop or status mechanism; track the foreground channel, service unit, or an explicit strategy-owned process identity.
- Do not overwrite the active firmware before the staged image is present and validated.
- Require an explicit recovery path when a firmware update can leave a real-time core stopped.
- Keep debug endpoints on the target loopback interface or SSH stdio/forwarding; do not expose GDB ports publicly by default.
- Terminate temporary debug endpoints and remove port forwards after debugger exit, disconnect, or frontend or core shutdown.

## 11. Initial Acceptance Criteria

The MVP is complete when a developer can:

1. The extension activates and connects to a supported board without installing VS Code Server on the board.
2. Select or configure an SSH target profile and connect to a supported board.
3. Complete SSH identity verification and see the target descriptor, including known board/SoC fields or explicit unknown values.
4. Open a local CMake project and hand an already-built artifact record from CMake Tools to the deploy pipeline.
5. Run `Deploy` and see that existing artifact deployed by the active strategy without an implicit rebuild.
6. Start, stop, and restart the active target through the selected strategy.
7. See remote stdout and stderr in the VS Code output panel.
8. Recover from a temporary SSH failure without restarting VS Code: after a drop the core reconnects with bounded backoff, re-verifies identity, re-queries target state through `inspect`, and restores the UI — never inferring state from the dead connection.
9. See foreground output and exit status, or inspect service status/logs after reconnecting.
   Service status/logs are required only when the selected target has passed the systemd capability probe.
10. Receive clear errors for an unresolved SSH profile, authentication failure, host-key mismatch, descriptor mismatch, upload failure, and remote process failure.
11. A future editor adapter can perform the same attach and deploy operations through the documented core protocol without reimplementing SSH.

The attach milestone is complete when CMake Tools has produced an artifact, Betelgeuz can resolve that existing artifact, and the workspace's active strategy can deploy it and report lifecycle state through the common workflow. The Linux `remoteproc` milestone is complete when a firmware workspace can use its existing CMake Tools artifact, deploy through its selected attach object, control remoteproc lifecycle, and observe the resulting state and errors.

## 12. Decisions

Work items — schemas, configuration key lists, error catalogs — are Phase 0 deliverables tracked in Phase 0, not open choices. This section holds only choices, in four blocks: the blocking gate that must be empty before coding starts, the resolved record, Phase 0 spikes whose experiment output makes the choice, and deferred choices each carrying the trigger that forces a revisit.

### Blocking before Phase 0/1

(Empty.) The gate is clear: every choice that could change the Phase 0/1 architecture is resolved and recorded below.

### Resolved record

- Host platforms: **Windows and Linux** development hosts. The extension is pure TypeScript with no per-platform binaries; the platform surface lives in the `ssh2` and (follow-on) `serialport` libraries.
- Core and transport: a TypeScript core module layer with exactly one transport for the MVP, `ssh2`; the serial-console transport is a planned follow-on peer (`serialport`, see the follow-on capability area), not a second SSH client. There is no external SSH client, configuration parser, agent integration, or fallback transport; unsupported authentication or proxy capabilities fail with explicit diagnostics. Remote - SSH extension internals are not a supported dependency. Betelgeuz owns target profiles, credentials, host-key pins, and proxy configuration.
- Run modes: `foreground` plus `service` mode against a unit provisioned on the target. A PID-file launcher and board-side helpers remain deferred, and a custom detached launcher must persist an unambiguous process identity before it can support stop or status operations.
- Configuration model: two layers — a shareable user-level `betelgeuz.profiles` entry holding the direct SSH endpoint, credential reference, and identity pins, and workspace-scoped `betelgeuz.attach.*` / `betelgeuz.deploy.*` keys. The key list is owned by the config module (`src/protocol/config`); implemented strategy keys use the full strategy ID as their prefix. The first small-core strategy uses `betelgeuz.attach.linux.remoteproc.instance` and `betelgeuz.attach.linux.remoteproc.firmwarePath`.
- Artifact and firmware validation: host-side format and architecture checks (ELF header parsing or a declared raw binary), with the instance identified by its `name` and the target profile pins; ELF metadata and declared format/size checks only — a board-provided manifest is deferred.
- Artifact selection: no staleness detection — Deploy consumes the build owner's output as-is. The MVP applies the exactly-one rule per target and fails multi-artifact targets with `artifact.ambiguous`; multi-artifact selection through `betelgeuz.deploy.artifact` is scheduled for Phase 7 (Optimization).
- Privilege model: a root SSH account or the documented `NOPASSWD` sudo whitelist Betelgeuz publishes; privileged commands are fixed templates with no interpolated user input. A target-side helper remains deferred behind a privilege runner seam.
- Support tier: Lichee RVNano is the sole Tier 1 board; all other board families are future support targets.
- Strategy model: deploy strategies are peers in a compile-time registry with declarative metadata (ID, role, config schema, error-code namespace, privilege class, and validation entry points). The user selects among implemented strategies; attach creation depends on SSH identity verification only, and target compatibility is checked afterward by the selected strategy. All strategies share the core's SSH session.
- Linux userspace runtime: the MVP accepts structured foreground launches with an executable,
  argv, cwd, environment, and closed stdin; it performs ELF/ABI/interpreter and target mount/
  permission preflight before activation. Systemd service mode is optional and requires a
  pre-provisioned unit that passes capability checks. Free-form shell commands are not part of
  the public contract.
- Debug adapter: the VS Code frontend binds CodeLLDB (`vadimcn.vscode-lldb`) as its DAP integration and maps the core's debugger-agnostic configuration to a `lldb` launch configuration (`target create` plus `gdb-remote` over the core's port forward). CodeLLDB covers all three RSP flows — application `gdbserver`, firmware GDB stubs, and OpenOCD-based probes — and satisfies the selection criteria: permissive licensing, maintained releases, and source-path mapping (via `target.source-map` where needed). The core stays debugger-neutral; the Debug action appears only when the DAP integration is installed, and a board whose stub proves LLDB-incompatible would add a GDB-based adapter at the frontend layer with no core changes.

- VS Code is the only frontend. The editor-neutral core and the Zed/Neovim adapter plans are retracted (maintainer readability decides the substrate); the core modules keep VS Code APIs out of their imports for testability, not for portability. A product CLI is not part of the vision: the service layer is callable from tests, and a CLI would only wrap `ssh`/`scp` for cases scripts already cover.

### Phase 0 spikes (the experiment produces the choice)

- CMake Tools artifact resolution: which CMake Tools API gives the most reliable artifact path for the selected target, and where the File API codemodel fallback is needed. The workflow already mandates API-first with File API fallback; the spike validates the mapping and produces a tested fallback matrix.
- Core credential storage on Windows and Linux: how the standalone core holds private-key passphrases and passwords handed over from the frontend's SecretStorage — in-memory per session versus OS keyring integration — and how long credentials may persist.

### Deferred (each with its trigger)

- Active board discovery — network scanning, announcement listeners (UDP/mDNS), a device picker, and its candidate metadata format. Trigger: onboarding friction where users cannot keep track of board addresses. If ever built, it is a frontend convenience that fills in a profile; core resolution and the identity handshake are unchanged.
- A USB-network discovery path for gadget links (RNDIS, CDC-ECM, or NCM). Trigger: a real board whose only practical link is USB-network. Windows has deprecated RNDIS drivers, so a Windows-host implementation carries disproportionate cost.
- Cross-workspace coordination on one physical board, such as a per-board advisory lock keyed by `deviceId` or host key. Trigger: hardware acceptance shows one attach's operation interfering with another's runtime, for example a firmware core restart breaking an application workspace.
- Per-board rollback guarantees for firmware updates, given that Linux `remoteproc` has no universal firmware rollback mechanism. Trigger: the first board profile that defines a rollback mechanism. Betelgeuz provides best-effort restore-previous-firmware in all cases until then.
- More than one attach object per workspace. Trigger: a real multi-board parallel workflow after the one-attach MVP.
- Which target-side software RSP providers exist per board profile (firmware GDB stub, RPMsg/OpenAMP debug service, vendor server, or OpenOCD-capable probe), and their compatibility with LLDB's RSP client. Trigger: onboarding each board profile to debug. Deployment support alone does not imply debugging support.
- Team sharing of target profiles: whether a workspace-committed profile definition (without secrets) may merge with or override user-level `betelgeuz.profiles` entries. Trigger: multiple developers committing to one repository. The MVP keeps profiles user-level only.
- A custom detached process launcher and a narrowly scoped target-side privilege helper. Trigger: a target that needs process survival beyond foreground/service modes, or a non-root image that cannot use the published sudo whitelist. Both remain behind their seams: process identity recording and the privilege runner.
- Additional small-core deploy strategies for vendor control mechanisms, such as mailbox-based control in the Rockchip family or vendor loaders like the Canaan K230's. Trigger: a board profile that needs small-core control through one of them. Each is a new strategy behind the common contract with its own configuration keys, error-code namespace, and target validation; the remoteproc strategy never emulates them. Until implemented, these boards are not Tier 1 and those strategies are not offered.
- Dynamic strategy loading: third-party strategies as loadable modules or WASM components. Trigger: strategy demand beyond the core's own implementations. The registry metadata is the seam; the MVP registry is compile-time.
- Serial debug: GDB's native serial RSP would share the console line with shell traffic; the line-exclusivity handoff design is deferred. Trigger: debug demand on serial-only boards.
- Multi-file deploy: deploying an application together with shared libraries or configuration files as one operation. Trigger: a real application workspace that needs several files deployed together. A manifest-style deploy contract would be designed then.
- Publishing protocol JSON Schema artifacts. Trigger: a third-party frontend or the published `betelgeuz-protocol` facade consumes them. Until then the schemas are build artifacts, not repository content.
