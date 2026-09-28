/**
 * `Secret` — the one wrapper for credential material (code discipline S3).
 *
 * Values are redacted in every stringification and never serialized. In
 * TypeScript this is encapsulation and review discipline rather than a
 * type-level guarantee (no Drop, no zeroize of the original string):
 * `wipe()` clears the reference, which is the strongest available here.
 */
export class Secret {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  /** Clears the held reference. Call on release. */
  wipe(): void {
    this.#value = "";
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }
}

export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}
