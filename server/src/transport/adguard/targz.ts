/**
 * Minimal `.tar.gz` reader for the AdGuard Home managed-mode acquisition (#96).
 *
 * AdGuard's Linux release archives are gzip-compressed USTAR tarballs whose only
 * file of interest is the `AdGuardHome` binary. Rather than take a `tar`
 * dependency to pull one regular file out, this decompresses with `node:zlib`
 * and walks the 512-byte tar blocks itself — the format is simple and the reader
 * is fully unit-testable against a hand-built buffer (`CLAUDE.md` → "Do not
 * introduce a new dependency without … why an existing one doesn't suffice":
 * extracting a single entry is ~50 lines, not worth a dependency).
 *
 * License boundary: none touched — pure decompression/parsing over `node:zlib`
 * (the runtime's own module). No AdGuard code linked.
 */
import { gunzipSync } from "node:zlib";

/** tar blocks are a fixed 512 bytes. */
const BLOCK_SIZE = 512;
/** Offsets/lengths of the USTAR header fields this reader needs. */
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/** Thrown when no regular-file entry matching the requested suffix is found. */
export class TarEntryNotFoundError extends Error {
  constructor(suffix: string) {
    super(`no regular-file entry ending in ${JSON.stringify(suffix)} found in archive`);
    this.name = "TarEntryNotFoundError";
  }
}

/** Read a NUL-terminated ASCII field out of a tar header block. */
function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString("ascii", 0, end === -1 ? raw.length : end).trim();
}

/** Parse a tar octal numeric field (size is stored as zero-padded octal ASCII). */
function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length);
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** The full entry path, combining the USTAR `prefix` and `name` fields. */
function entryPath(block: Buffer): string {
  const name = readString(block, NAME_OFFSET, NAME_LENGTH);
  const prefix = readString(block, PREFIX_OFFSET, PREFIX_LENGTH);
  return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Extract the first **regular-file** entry whose path ends with {@link suffix}
 * from a gzip-compressed tarball.
 *
 * @throws TarEntryNotFoundError when no such entry exists.
 */
export function extractFileFromTarGz(archive: Buffer, suffix: string): Buffer {
  const tar = gunzipSync(archive);
  let offset = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    const path = entryPath(header);
    // Two consecutive all-zero blocks mark end-of-archive; an empty name is the
    // first of them, so stop walking.
    if (path === "") break;

    const size = readOctal(header, SIZE_OFFSET, SIZE_LENGTH);
    // typeflag '0' or NUL both denote a regular file (older archives use NUL).
    const typeflag = tar[offset - BLOCK_SIZE + TYPEFLAG_OFFSET];
    const isRegularFile = typeflag === 0x30 || typeflag === 0x00;

    if (isRegularFile && path.endsWith(suffix)) {
      return Buffer.from(tar.subarray(offset, offset + size));
    }

    // Advance past this entry's data, rounded up to the next block boundary.
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  throw new TarEntryNotFoundError(suffix);
}
