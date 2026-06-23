/**
 * Tests for the minimal `.tar.gz` reader (#96): extract one regular-file entry
 * by suffix from a hand-built gzip+tar buffer. Exercises the multi-entry walk,
 * the block-rounding of entry data, and the not-found path — no real archive
 * needed.
 */
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  extractFileFromTarGz,
  TarEntryNotFoundError,
} from "../../../src/transport/adguard/targz.js";

const BLOCK = 512;

/** Build a single USTAR header + padded data blocks for one regular file. */
function tarEntry(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, "ascii");
  // size field at offset 124: 11 octal digits + NUL.
  header.write(contents.length.toString(8).padStart(11, "0"), 124, "ascii");
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii");
  const dataBlocks = Math.ceil(contents.length / BLOCK) * BLOCK;
  const data = Buffer.alloc(dataBlocks);
  contents.copy(data);
  return Buffer.concat([header, data]);
}

/** Assemble entries into a gzip-compressed tarball ending in two zero blocks. */
function buildTarGz(entries: { name: string; contents: Buffer }[]): Buffer {
  const blocks = entries.map((e) => tarEntry(e.name, e.contents));
  const trailer = Buffer.alloc(BLOCK * 2);
  return gzipSync(Buffer.concat([...blocks, trailer]));
}

describe("extractFileFromTarGz", () => {
  it("extracts a file matching the suffix", () => {
    const body = Buffer.from("#!/bin/sh\necho adguard\n");
    const archive = buildTarGz([
      { name: "AdGuardHome/LICENSE.txt", contents: Buffer.from("license") },
      { name: "AdGuardHome/AdGuardHome", contents: body },
    ]);
    const extracted = extractFileFromTarGz(archive, "AdGuardHome/AdGuardHome");
    expect(extracted.equals(body)).toBe(true);
  });

  it("handles a multi-block entry preceding the target", () => {
    const big = Buffer.alloc(BLOCK + 100, 0x41); // spans two blocks
    const body = Buffer.from("binary-bytes");
    const archive = buildTarGz([
      { name: "AdGuardHome/CHANGELOG.md", contents: big },
      { name: "AdGuardHome/AdGuardHome", contents: body },
    ]);
    expect(extractFileFromTarGz(archive, "AdGuardHome/AdGuardHome").equals(body)).toBe(true);
  });

  it("throws when no entry matches the suffix", () => {
    const archive = buildTarGz([{ name: "AdGuardHome/README.md", contents: Buffer.from("x") }]);
    expect(() => extractFileFromTarGz(archive, "AdGuardHome/AdGuardHome")).toThrow(
      TarEntryNotFoundError,
    );
  });
});
