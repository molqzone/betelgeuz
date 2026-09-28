/**
 * Target session API shared by core services and deploy strategies.
 *
 * The core owns profile resolution, credential lookup, and reconnect policy.
 * This module verifies the pinned server key before returning a connected
 * session and provides exec and SFTP channels over that one session. The single
 * production implementation is `ssh2-transport`; the fake serves tests only.
 *
 * Why wrap the SSH library at all:
 *
 * - **Pin-first identity.** `inspectHostKey` → explicit user approval →
 *   `connect` with a mandatory pin is a Betelgeuz shape that no library's
 *   known-hosts helpers express.
 * - **Secret handling.** Redacted, wiped secret values are a plan requirement;
 *   the library takes raw strings and can make no such guarantee.
 * - **Library churn absorption.** ssh2's error shapes and channel APIs move;
 *   one boundary absorbs it.
 * - **Testability.** The fake transport lets core services run without
 *   hardware or an SSH server.
 *
 * Abstraction policy: one interface today. It grows, and may split, only when
 * a second implementation or real concurrency forces it — never into a
 * speculatively layered hierarchy. (`forward` returns with Phase 4 debug.)
 */
import type { Readable } from "node:stream";

import { BetelgeuzError } from "../errors";
import type { ErrorCode } from "../errors";
import { Secret } from "../secret";

/** SSH endpoint data after core-owned profile resolution. */
export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
}

/** SHA-256 fingerprint of an SSH server key, in OpenSSH display form. */
export class HostKeyFingerprint {
  private constructor(private readonly value: string) {}

  static parse(value: string): HostKeyFingerprint {
    const encoded = value.startsWith("SHA256:") ? value.slice("SHA256:".length) : "";
    const validBase64 = /^[A-Za-z0-9+/]+$/.test(encoded);
    if (encoded.length !== 43 || !validBase64) {
      throw new BetelgeuzError("config.invalid", {
        detail: "host-key pin must be a SHA256 fingerprint",
      });
    }
    return new HostKeyFingerprint(value);
  }

  asString(): string {
    return this.value;
  }
}

/** Authentication material resolved from a protected credential reference. */
export type Authentication =
  | { kind: "password"; password: Secret }
  | {
      kind: "privateKey";
      privateKey: Secret;
      passphrase?: Secret;
    };

/** A typed SSH jump-host hop. Arbitrary proxy commands are not accepted. */
export interface SshProxyHop {
  endpoint: SshEndpoint;
  authentication: Authentication;
  hostKeyPin: HostKeyFingerprint;
}

/** Inputs required to open one SSH session. A pin is mandatory; host-key
 * enrollment is performed separately before connecting. */
export interface SshConnectOptions {
  endpoint: SshEndpoint;
  authentication: Authentication;
  hostKeyPin: HostKeyFingerprint;
  proxyChain: Array<SshProxyHop>;
  keepaliveSeconds: number;
}

/** A structured launch: what to run and where, never how to spell it. The
 * transport renders this through a fixed encoder; free-form shell lines are
 * not constructible. Environment values are secrets by plan rule. */
export interface LaunchRequest {
  executable: string;
  argv: Array<string>;
  cwd?: string;
  environment: Record<string, Secret>;
  allocatePty: boolean;
}

export type TerminateSignal = "term" | "kill";

/** The fixed, zero-interpolation command templates the core uses. Values are
 * typed here and encoded by `ExecRequest.fixed`; callers never concatenate. */
export type FixedCommand =
  | { kind: "signalProcessGroup"; pgid: number; signal: TerminateSignal };

/** One exec command. Construct it through `launch` or `fixed`; the rendered
 * command string is not part of the public surface. */
export class ExecRequest {
  private constructor(
    readonly command: string,
    readonly allocatePty: boolean
  ) {}

  static launch(launch: LaunchRequest): ExecRequest {
    rejectNul("executable", launch.executable);
    if (launch.cwd !== undefined) {
      rejectNul("cwd", launch.cwd);
    }
    for (const argument of launch.argv) {
      rejectNul("argument", argument);
    }
    for (const [name, secret] of Object.entries(launch.environment)) {
      validateEnvName(name);
      rejectNul("environment value", secret.expose());
    }

    let command = "";
    if (launch.cwd !== undefined) {
      command += `cd ${shellQuote(launch.cwd)} && `;
    }
    for (const [name, secret] of Object.entries(launch.environment)) {
      command += `${name}=${shellQuote(secret.expose())} `;
    }
    command += `exec ${shellQuote(launch.executable)}`;
    for (const argument of launch.argv) {
      command += ` ${shellQuote(argument)}`;
    }
    return new ExecRequest(command, launch.allocatePty);
  }

  static fixed(template: FixedCommand): ExecRequest {
    switch (template.kind) {
      case "signalProcessGroup": {
        const signal = template.signal === "term" ? "TERM" : "KILL";
        return new ExecRequest(
          `kill -${signal} -- -${template.pgid}`,
          false
        );
      }
    }
  }
}

function rejectNul(field: string, value: string): void {
  if (value.includes("\0")) {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must not contain NUL bytes`,
    });
  }
}

/** Environment names are emitted unquoted into assignment position, so they
 * must be shell identifiers rather than arbitrary strings. */
function validateEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new BetelgeuzError("config.invalid", {
      detail: "environment names must be shell identifiers",
    });
  }
}

/** POSIX single-quote encoding: everything except `'` is literal inside the
 * quotes; embedded quotes are closed, escaped, and reopened. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

export type OutputStream = "stdout" | "stderr";

export type ExecEvent =
  | { kind: "output"; stream: OutputStream; bytes: Buffer }
  | { kind: "exit"; status?: number; signal?: string };

/** Streaming result of one exec command. The stream stays open while the
 * remote command runs and ends after the exit event. `terminate` is a polite
 * signal only — escalation is the strategy's job via its process-group
 * handle. */
export class ExecHandle {
  private events: Array<ExecEvent> = [];
  private ended = false;
  private waiters: Array<(result: ExecEvent | null) => void> = [];
  private readonly terminateAction: () => void | Promise<void>;

  /** For implementations of `SshTransport`. */
  constructor(terminateAction: () => void | Promise<void>) {
    this.terminateAction = terminateAction;
  }

  /** For implementations of `SshTransport`: deliver events in order; `null`
   * marks the end of the stream, after the exit event. */
  push(event: ExecEvent | null): void {
    if (event === null) {
      this.ended = true;
    } else {
      this.events.push(event);
    }
    while (this.waiters.length > 0) {
      if (this.events.length > 0) {
        const waiter = this.waiters.shift();
        waiter?.(this.events.shift() as ExecEvent);
      } else if (this.ended) {
        const waiter = this.waiters.shift();
        waiter?.(null);
      } else {
        break;
      }
    }
  }

  async nextEvent(): Promise<ExecEvent | null> {
    if (this.events.length > 0) {
      return this.events.shift() as ExecEvent;
    }
    if (this.ended) {
      return null;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async terminate(): Promise<void> {
    await this.terminateAction();
  }
}

/** Connection-loss report. `detail` is a log adjunct and is never parsed; the
 * `cause` is a catalog code so the core maps losses without sniffing text. */
export interface SessionLoss {
  cause: ErrorCode;
  detail: string;
}

/** One connected session. `connect` is part of the same object so the core
 * holds exactly one transport per session. */
export interface SshTransport {
  /** Reads the server key only. The caller must obtain explicit user approval
   * before persisting the returned fingerprint as a new pin. */
  inspectHostKey(endpoint: SshEndpoint): Promise<HostKeyFingerprint>;

  /** Establishes the session only after the server key matches the pin. */
  connect(options: SshConnectOptions): Promise<void>;

  /** Connection-loss subscription; returns an unsubscribe function. */
  onSessionLoss(listener: (loss: SessionLoss) => void): () => void;

  /** Opens a dedicated exec channel on this session. */
  exec(request: ExecRequest): Promise<ExecHandle>;

  /** Uploads through SFTP from a host-side stream, without buffering the
   * entire artifact in memory. */
  upload(source: Readable, remotePath: string): Promise<void>;

  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  metadata(path: string): Promise<RemoteFileInfo | null>;

  close(): Promise<void>;
}

export interface RemoteFileInfo {
  size: number;
  mode: number;
  isFile: boolean;
}
