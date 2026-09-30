import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertRuntimeCompatible, inspectElf } from "../artifact/elf";

function minimalElf(machine: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt16LE(64, 54);
  return bytes;
}

describe("ELF artifact inspection", () => {
  it("reads bounded ELF metadata and checks the target runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-elf-"));
    const path = join(directory, "app");
    const bytes = minimalElf(183);
    await writeFile(path, bytes);

    const metadata = await inspectElf(path, bytes.length);
    expect(metadata).toMatchObject({
      elfClass: 2,
      endian: "little",
      machineName: "aarch64",
    });
    expect(() => assertRuntimeCompatible(metadata, {
      elfClass: 2,
      endian: "little",
      machine: "arm64",
    })).not.toThrow();
    try {
      assertRuntimeCompatible(metadata, { machine: "riscv64" });
      expect.fail("expected incompatible runtime");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "artifact.runtime-incompatible" });
    }
  });

  it("rejects non-ELF input before any target operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-elf-"));
    const path = join(directory, "app");
    await writeFile(path, "not an executable");

    await expect(inspectElf(path, 16)).rejects.toMatchObject({
      code: "artifact.runtime-incompatible",
    });
  });
});
