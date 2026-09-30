/** Minimal, bounded ELF inspection used before an artifact reaches a target. */
import { open, type FileHandle } from "node:fs/promises";

import { BetelgeuzError } from "../errors";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const PT_INTERP = 3;
const MAX_HEADER_BYTES = 1024 * 1024;

export type ElfClass = 1 | 2;
export type ElfEndian = "big" | "little";

export type ElfMetadata = {
  abi: number;
  endian: ElfEndian;
  elfClass: ElfClass;
  interpreter?: string;
  machine: number;
  machineName: string;
};

export async function inspectElf(path: string, size: number): Promise<ElfMetadata> {
  if (size < 20) {
    throw incompatible("artifact is too small to be an ELF file");
  }
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const length = Math.min(size, MAX_HEADER_BYTES);
    const bytes = Buffer.alloc(length);
    const result = await file.read(bytes, 0, length, 0);
    return parseElf(bytes.subarray(0, result.bytesRead));
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      throw error;
    }
    throw new BetelgeuzError("artifact.missing", { cause: error });
  } finally {
    await file?.close();
  }
}

export function assertRuntimeCompatible(
  elf: ElfMetadata,
  runtime: {
    elfClass?: ElfClass;
    endian?: ElfEndian;
    interpreter?: string;
    machine?: string;
  }
): void {
  if (runtime.elfClass !== undefined && runtime.elfClass !== elf.elfClass) {
    throw incompatible(`ELF class ${elf.elfClass} is incompatible with target class ${runtime.elfClass}`);
  }
  if (runtime.endian !== undefined && runtime.endian !== elf.endian) {
    throw incompatible(`ELF endianness ${elf.endian} is incompatible with target ${runtime.endian}`);
  }
  if (runtime.machine !== undefined && normalizeMachine(runtime.machine) !== elf.machineName) {
    throw incompatible(`ELF machine ${elf.machineName} is incompatible with target ${runtime.machine}`);
  }
  if (
    elf.interpreter !== undefined &&
    runtime.interpreter !== undefined &&
    runtime.interpreter !== "" &&
    elf.interpreter !== runtime.interpreter
  ) {
    throw incompatible(
      `ELF interpreter ${elf.interpreter} is incompatible with target ${runtime.interpreter}`
    );
  }
}

export function normalizeMachine(value: string): string {
  const machine = value.trim().toLowerCase();
  if (machine === "aarch64" || machine === "arm64") {
    return "aarch64";
  }
  if (machine === "x86_64" || machine === "amd64") {
    return "x86_64";
  }
  if (machine === "riscv64") {
    return "riscv64";
  }
  if (machine === "armv7l" || machine === "armv6l" || machine === "arm") {
    return "arm";
  }
  if (machine === "i386" || machine === "i686" || machine === "x86") {
    return "x86";
  }
  return machine;
}

function parseElf(bytes: Buffer): ElfMetadata {
  if (!bytes.subarray(0, 4).equals(ELF_MAGIC)) {
    throw incompatible("artifact is not an ELF executable");
  }
  const classValue = bytes[4];
  const elfClass = classValue === 1 || classValue === 2 ? classValue : undefined;
  if (elfClass === undefined) {
    throw incompatible("artifact has an unsupported ELF class");
  }
  const data = bytes[5];
  const endian = data === 1 ? "little" : data === 2 ? "big" : undefined;
  if (endian === undefined) {
    throw incompatible("artifact has an unsupported ELF byte order");
  }
  const machine = readU16(bytes, 18, endian);
  if (machine === undefined) {
    throw incompatible("artifact has a truncated ELF header");
  }
  const machineName = machineNameFor(machine);
  if (machineName === undefined) {
    throw incompatible(`artifact uses unsupported ELF machine ${machine}`);
  }
  const abi = bytes[7];
  const metadata: ElfMetadata = {
    abi,
    endian,
    elfClass,
    machine,
    machineName,
  };
  const programHeaderOffset = readWord(bytes, elfClass === 2 ? 32 : 28, elfClass, endian);
  const programHeaderSize = readU16(bytes, elfClass === 2 ? 54 : 42, endian);
  const programHeaderCount = readU16(bytes, elfClass === 2 ? 56 : 44, endian);
  if (programHeaderSize === undefined || programHeaderCount === undefined ||
      programHeaderOffset === undefined) {
    throw incompatible("artifact has a truncated ELF program header");
  }
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderSize;
    if (offset + programHeaderSize > bytes.length || programHeaderSize < (elfClass === 2 ? 56 : 32)) {
      break;
    }
    const type = readU32(bytes, offset, endian);
    if (type !== PT_INTERP) {
      continue;
    }
    const fileOffset = readWord(bytes, offset + (elfClass === 2 ? 8 : 4), elfClass, endian);
    const fileSize = readWord(bytes, offset + (elfClass === 2 ? 32 : 16), elfClass, endian);
    if (fileOffset === undefined || fileSize === undefined || fileOffset + fileSize > bytes.length) {
      break;
    }
    const end = bytes.indexOf(0, fileOffset);
    const text = bytes.subarray(fileOffset, end < 0 ? fileOffset + fileSize : end).toString("utf8");
    metadata.interpreter = text;
    break;
  }
  return metadata;
}

function readU16(bytes: Buffer, offset: number, endian: ElfEndian): number | undefined {
  if (offset < 0 || offset + 2 > bytes.length) {
    return undefined;
  }
  return endian === "little" ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
}

function readU32(bytes: Buffer, offset: number, endian: ElfEndian): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) {
    return undefined;
  }
  return endian === "little" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function readWord(
  bytes: Buffer,
  offset: number,
  elfClass: ElfClass,
  endian: ElfEndian
): number | undefined {
  if (elfClass === 1) {
    return readU32(bytes, offset, endian);
  }
  if (offset < 0 || offset + 8 > bytes.length) {
    return undefined;
  }
  const value = endian === "little" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value);
}

function machineNameFor(machine: number): string | undefined {
  switch (machine) {
    case 3:
      return "x86";
    case 40:
      return "arm";
    case 62:
      return "x86_64";
    case 183:
      return "aarch64";
    case 243:
      return "riscv64";
    default:
      return undefined;
  }
}

function incompatible(detail: string): BetelgeuzError {
  return new BetelgeuzError("artifact.runtime-incompatible", { detail });
}
