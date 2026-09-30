/**
 * The hardware descriptor read from the target after host-key verification.
 *
 * Preferred source: a board-provided `/etc/betelgeuz/device.json`. On stock
 * vendor and community images the fixed probe falls back to device-tree and
 * machine identity files. Missing fields are `undefined` and rendered as
 * unknown. The descriptor is untrusted metadata until the host key has been
 * verified.
 */
import { BetelgeuzError } from "../errors";
import { cancellationError, throwIfAborted } from "../cancellation";
import {
  ExecRequest,
  type ExecEvent,
  type ExecHandle,
  type SshTransport,
} from "../transport";
import type { TargetProfile } from "./config";

export type HardwareDescriptor = {
  boardId?: string | null;
  boardRevision?: string | null;
  compatible?: Array<string> | null;
  deviceId?: string | null;
  model?: string | null;
  protocolVersion?: number | null;
  socId?: string | null;
};

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_DESCRIPTOR_FIELD_LENGTH = 512;
const MAX_DESCRIPTOR_PROBE_MS = 10_000;
const MAX_TERMINATE_WAIT_MS = 250;
const DESCRIPTOR_KEYS = new Set([
  "boardId",
  "boardRevision",
  "compatible",
  "deviceId",
  "model",
  "protocolVersion",
  "socId",
]);

/** Parse either the documented JSON descriptor or the fixed fallback format. */
export function parseHardwareDescriptor(input: string | Buffer): HardwareDescriptor {
  if (Buffer.byteLength(input) > MAX_DESCRIPTOR_BYTES) {
    throw descriptorError("hardware descriptor exceeds the size limit");
  }
  const text = input.toString().replace(/^\uFEFF/, "");
  if (text.trim() === "") {
    return {};
  }

  if (text.trimStart().startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(text.trim()) as unknown;
    } catch (error) {
      throw descriptorError("hardware descriptor is not valid JSON", error);
    }
    return descriptorFromObject(value);
  }

  const fields: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const separator = line.indexOf("\t");
    if (separator <= 0) {
      throw descriptorError("hardware descriptor fallback has an invalid line");
    }
    const key = line.slice(0, separator);
    if (DESCRIPTOR_KEYS.has(key)) {
      const values = line
        .slice(separator + 1)
        .split("\0")
        .map((value) => value.trim())
        .filter((value) => value !== "");
      if (key === "socId") {
        fields.socId = values[0];
        fields.compatible = values;
      } else {
        fields[key] = values[0];
      }
    }
  }
  return descriptorFromObject(fields);
}

/** Read the descriptor through a fixed, non-interpolated command. */
export async function readHardwareDescriptor(
  transport: SshTransport,
  signal?: AbortSignal
): Promise<HardwareDescriptor> {
  throwIfAborted(signal, "identity");
  const deadline = Date.now() + MAX_DESCRIPTOR_PROBE_MS;
  const execPromise = transport.exec(
    ExecRequest.fixed({ kind: "readHardwareDescriptor" })
  );
  const opened = await raceWithTimeout(
    execPromise,
    MAX_DESCRIPTOR_PROBE_MS,
    signal
  );
  if (opened.kind === "cancelled") {
    void execPromise
      .then((handle) => terminateWithin(handle))
      .catch(() => undefined);
    throw cancellationError("identity", signal?.reason);
  }
  if (opened.kind === "timeout") {
    void execPromise
      .then((handle) => terminateWithin(handle))
      .catch(() => undefined);
    throw descriptorTimeoutError();
  }
  const handle = opened.value;
  const chunks: Buffer[] = [];
  let exit: Extract<ExecEvent, { kind: "exit" }> | undefined;
  let totalBytes = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw await descriptorTimeout(handle);
    }
    const result = await raceWithTimeout(handle.nextEvent(), remaining, signal);
    if (result.kind === "cancelled") {
      const cause = await terminateWithin(handle);
      throw cancellationError("identity", cause ?? signal?.reason);
    }
    if (result.kind === "timeout") {
      throw await descriptorTimeout(handle);
    }
    const event = result.value;
    if (event === null) {
      break;
    }
    if (event.kind === "output" && event.stream === "stdout") {
      totalBytes += event.bytes.byteLength;
      if (totalBytes > MAX_DESCRIPTOR_BYTES) {
        const cause = await terminateWithin(handle);
        throw descriptorError("hardware descriptor exceeds the size limit", cause);
      }
      chunks.push(event.bytes);
    } else if (event.kind === "exit") {
      exit = event;
    }
  }
  if (exit === undefined) {
    throw new BetelgeuzError("ssh.lost", {
      detail: "descriptor channel closed before the remote command exited",
    });
  }
  if (exit.status !== 0) {
    throw descriptorError("hardware descriptor probe failed", exit.status);
  }
  return parseHardwareDescriptor(Buffer.concat(chunks));
}

/** Verify every identity pin that the profile actually configured. */
export function assertDescriptorMatches(
  descriptor: HardwareDescriptor,
  profile: Pick<TargetProfile, "deviceId" | "boardId" | "socId">
): void {
  for (const field of ["deviceId", "boardId", "socId"] as const) {
    const expected = nonEmpty(profile[field]);
    if (expected === undefined) {
      continue;
    }
    const observed = nonEmpty(descriptor[field]);
    const compatibleMatch =
      field === "socId" && descriptor.compatible?.some((value) => value === expected);
    if (observed !== expected && !compatibleMatch) {
      throw pinMismatchError(
        `${field} pin does not match the observed hardware descriptor`
      );
    }
  }
}

function descriptorFromObject(value: unknown): HardwareDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw descriptorError("hardware descriptor must be an object");
  }
  const object = value as Record<string, unknown>;
  const result: HardwareDescriptor = {};
  for (const key of DESCRIPTOR_KEYS) {
    const raw = object[key];
    if (raw === undefined || raw === null || raw === "") {
      continue;
    }
    if (key === "compatible") {
      if (!Array.isArray(raw)) {
        throw descriptorError("compatible must be an array of strings when present");
      }
      result.compatible = [...new Set(raw.map((value) => descriptorString(key, value)))];
      continue;
    }
    if (key === "protocolVersion") {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        throw descriptorError("protocolVersion must be a non-negative integer");
      }
      result.protocolVersion = raw;
      continue;
    }
    const normalized = descriptorString(key, raw);
    if (normalized !== "") {
      const descriptorKey = key as Exclude<
        keyof HardwareDescriptor,
        "protocolVersion" | "compatible"
      >;
      result[descriptorKey] = normalized;
    }
  }
  return result;
}

function descriptorString(key: string, value: unknown): string {
  if (typeof value !== "string") {
    throw descriptorError(`${key} must be a string when present`);
  }
  const normalized = value.trim();
  if (
    normalized.length > MAX_DESCRIPTOR_FIELD_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
  ) {
    throw descriptorError(`${key} contains invalid characters or is too long`);
  }
  return normalized;
}

type WaitResult<T> =
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "value"; value: T };

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<WaitResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const races: Array<Promise<WaitResult<T>>> = [
    promise.then((value) => ({ kind: "value" as const, value })),
    new Promise<WaitResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ];
  if (signal !== undefined) {
    races.push(
      new Promise<WaitResult<T>>((resolve) => {
        abortListener = () => resolve({ kind: "cancelled" });
        if (signal.aborted) {
          abortListener();
        } else {
          signal.addEventListener("abort", abortListener, { once: true });
        }
      })
    );
  }
  return Promise.race(races).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  });
}

async function descriptorTimeout(handle: ExecHandle): Promise<BetelgeuzError> {
  const cause = await terminateWithin(handle);
  return descriptorTimeoutError(cause);
}

function descriptorTimeoutError(cause?: unknown): BetelgeuzError {
  return new BetelgeuzError("identity.descriptor-timeout", {
    detail: `hardware descriptor probe exceeded ${MAX_DESCRIPTOR_PROBE_MS} ms`,
    cause,
  });
}

async function terminateWithin(handle: ExecHandle): Promise<unknown> {
  try {
    const result = await raceWithTimeout(handle.terminate(), MAX_TERMINATE_WAIT_MS);
    return result.kind === "timeout" || result.kind === "cancelled"
      ? new Error("termination request did not complete in time")
      : undefined;
  } catch (error) {
    return error;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value !== undefined && value !== null && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** Unreadable means the target's data could not become a descriptor; only a
 * pin comparison is a mismatch. */
function descriptorError(detail: string, cause?: unknown): BetelgeuzError {
  return new BetelgeuzError("identity.descriptor-unreadable", { detail, cause });
}

function pinMismatchError(detail: string): BetelgeuzError {
  return new BetelgeuzError("identity.descriptor-mismatch", { detail });
}
