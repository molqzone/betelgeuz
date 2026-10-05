# Small-core firmware target setup (`linux.remoteproc`)

How to prepare a target board so Betelgeuz can deploy firmware to its small
core through Linux `remoteproc`, with the least privilege that works. This is
the target-side half of the `linux.remoteproc` strategy; the workspace side is
two settings — `betelgeuz.attach.linux.remoteproc.instance` and
`betelgeuz.attach.linux.remoteproc.firmwarePath` (see
[the plan](../PLAN.md) §5).

## What the target needs

- A Linux kernel with `CONFIG_REMOTEPROC` and the SoC's remoteproc driver, so
  `/sys/class/remoteproc/` holds the core you want to load.
- The firmware image staged where the kernel's firmware loader searches —
  `/lib/firmware` unless the target configures the loader's search path — and
  writable by the account Betelgeuz connects as.
- An SSH account with SFTP access (the contract every Betelgeuz target
  already meets) **and** write access to the remoteproc controls of the
  configured instance.

Nothing else is required: no board-side agent, no resident daemon, and no
Betelgeuz software on the target.

Two facts confirmed on a Tier 1 board (SG2002 image, kernel 5.10):

- The `firmware` attribute takes a **name**, not a path: the kernel resolves
  it through the firmware loader's search paths, and a slashed value is
  rejected (`Direct firmware load for ... failed with error -2`). So the
  staged file must live inside a searched directory — `/lib/firmware` — and
  Betelgeuz selects the staged file's name.
- The `firmware` attribute refuses writes while the core is running
  (`Device or resource busy`), which is why a deploy stops the core before
  selecting — and why a running core needs the explicit confirmation.

## Choose the instance

The instance setting addresses the configured core by its stable `name` — the
one under `/sys/class/remoteproc/remoteprocN/name`, stable per device tree
(for example `30070000.remoteproc`). The convenience form `remoteprocN` also
works and is resolved to that name at attach time; a core that later resolves
to a different name is reported as an identity change, never silently
re-targeted. Find the name on the board with:

```sh
for d in /sys/class/remoteproc/remoteproc*; do
  printf '%s %s %s\n' "$d" "$(cat "$d/name")" "$(cat "$d/state")"
done
```

## Two privilege modes

The strategy writes exactly two kinds of sysfs attribute for the configured
instance — `state` (`start`/`stop`) and `firmware` (the image path) — plus the
firmware file itself. There are two supported ways to permit that.

### Root SSH account

The simplest mode: the profile's user is `root`. Every control write is issued
directly; no `sudo` is involved.

### Unprivileged account with the `NOPASSWD` sudo whitelist

When the account is not root, grant exactly the control writes it needs and
nothing else. The whitelist below is the complete list of privileged
operations the strategy issues, each as one fixed command with a fixed path —
no shells, no wildcards, no interpolated user input:

```sudoers
# Betelgeuz linux.remoteproc: write the small-core controls for the instance.
%betelgeuz ALL=(root) NOPASSWD: /usr/bin/tee /sys/class/remoteproc/remoteproc0/state
%betelgeuz ALL=(root) NOPASSWD: /usr/bin/tee /sys/class/remoteproc/remoteproc0/firmware
```

Adjust the instance directory to the core the workspace configures. The
strategy discovers the mode at connect time: it writes directly when the
account may, and otherwise asks (with `sudo -n -l`) whether the account may
run the whitelisted write itself — so the probe needs no whitelist entry of
its own. When neither is available, operations fail with `privilege.denied`
rather than half-applying a firmware load.

The whitelist does not cover placing the firmware file: the upload travels
over SFTP as the connecting account, so the firmware directory itself must be
writable by that account. Either connect as root, or give the account the
directory — e.g. `chown debian:debian /lib/firmware` on a single-user board.
The `%betelgeuz` group is a real group the setup creates:
`groupadd betelgeuz && usermod -aG betelgeuz debian` — sudo resolves the
membership itself, but a fresh login is what `id` shows.

If the target has no `sudo`, the root-account mode is the supported option.

## Verify by hand

With the settings in place, the flow a deploy performs is:

```sh
# 1. stage the image next to the firmware location (Betelgeuz picks the name)
scp rtos.elf board:/lib/firmware/rtos.elf.betelgeuz-<uuid>.tmp

# 2. stop the core if it is running
sudo -n tee /sys/class/remoteproc/remoteproc0/state   # input: stop

# 3. move the staged image into place (atomic, same filesystem)
mv /lib/firmware/rtos.elf.betelgeuz-<uuid>.tmp /lib/firmware/rtos.elf

# 4. select it — by NAME; the kernel resolves it through its search paths
sudo -n tee /sys/class/remoteproc/remoteproc0/firmware  # input: rtos.elf

# 5. start the core
sudo -n tee /sys/class/remoteproc/remoteproc0/state   # input: start

# 6. read the state until it settles
cat /sys/class/remoteproc/remoteproc0/state
```

A `running` state means Linux started the small core — not that the firmware's
application-level work is correct. Firmware health needs firmware-provided
evidence such as a heartbeat.

## Failure and recovery

- An interrupted upload leaves the core running and removes the staged file.
- A failed stop aborts with the deployed firmware untouched.
- A failed move or selection leaves the core stopped and offers `Start` with
  the retained previous firmware or a retry.
- Betelgeuz retains up to three previous images next to the configured
  firmware path (`<firmwarePath>.betelgeuz-prev-1..3`), trimmed to a 64 MiB
  total. `Restore previous version` re-selects the newest retained image and
  starts the core; Linux `remoteproc` has no universal rollback mechanism, so
  this is best-effort recovery, not a guarantee.

## Related

- [Strategy how-to](strategy-howto.md) — how the strategy layer is built and
  how to add another one.
- [The plan](../PLAN.md) §6 — the small-core strategy's pipeline and failure
  handling, and §10 — the privilege model.
