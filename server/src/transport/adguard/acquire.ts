/**
 * First-run acquisition of the AdGuard Home binary for managed mode (#96).
 *
 * Downloads the upstream release archive into the data volume, verifies its
 * SHA-256 against the release `checksums.txt`, and extracts the `AdGuardHome`
 * binary — the "fetched from upstream at runtime" half of the managed-mode
 * license posture (`docs/server-deployment.md` → "License posture is identical
 * in both modes"; `docs/licensing-analysis.md`). The binary is **never** baked
 * into the dashboard image.
 *
 * Every side-effecting boundary (network, filesystem, clock) is an injected seam
 * so the whole module is unit-testable without touching the real network or
 * disk — the same posture as `setup/ansible-venv.ts`.
 *
 * License boundary: the artefact is fetched at runtime and later run as a
 * separate child process (`./supervisor.ts`); nothing here links or imports
 * AdGuard code (`CLAUDE.md` → "License boundaries" rule 5).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ARCHIVE_BINARY_SUFFIX,
  BINARY_FILENAME,
  LATEST_RELEASE_API_URL,
  assetUrl,
  checksumsUrl,
  findChecksum,
  resolveAsset,
  type ReleaseAsset,
} from "./release.js";
import { extractFileFromTarGz } from "./targz.js";

/** Filename of the version sentinel written beside the binary. */
const VERSION_SENTINEL = ".pct-adguard-version";

/** The `0755` mode the extracted binary is made executable with. */
const BINARY_MODE = 0o755;

/**
 * The minimal `fetch` surface acquisition uses — a superset of the REST client's
 * `FetchLike` (it also reads binary bodies and text). Structural so the Node 22
 * global `fetch` satisfies it and a test can pass a recording fake without a
 * cast.
 */
export type DownloadFetch = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** Configuration acquisition needs (a slice of {@link Settings}'s managed branch). */
export interface AcquireConfig {
  /** Data-volume directory the binary + sentinel live under (e.g. `/data/adguard`). */
  dataDir: string;
  /**
   * Pinned release tag (`PCT_ADGUARD_VERSION`, e.g. `v0.107.65`). When omitted,
   * the latest non-prerelease tag is resolved from the GitHub API on first
   * acquisition; an already-installed binary is then left in place (AdGuard
   * Home self-updates) rather than re-checked every boot.
   */
  version?: string;
}

/** Injectable seams so tests never hit the network or real disk. */
export interface AcquireDeps {
  /** `fetch` for downloads + the latest-release lookup; defaults to the global `fetch`. */
  fetch?: DownloadFetch;
  /** Existence check; defaults to `node:fs` `existsSync`. */
  fileExists?: (path: string) => boolean;
  /** Read the recorded version sentinel, or `null` if absent/unreadable. */
  readSentinel?: (path: string) => string | null;
  /** Recursively create a directory (and parents). */
  makeDir?: (path: string) => void;
  /** Write the extracted binary, then mark it executable. */
  writeBinary?: (path: string, contents: Buffer) => void;
  /** Record the acquired version. */
  writeSentinel?: (path: string, value: string) => void;
  /** Resolve the host's release asset; defaults to {@link resolveAsset}. */
  resolveAsset?: () => ReleaseAsset;
}

/** Outcome of an {@link acquireAdGuardHome} call. */
export interface AcquireResult {
  /** Absolute path to the (now-present) AdGuard Home binary. */
  readonly binaryPath: string;
  /** The release tag the binary corresponds to. */
  readonly version: string;
  /** True when this call downloaded the binary; false when it was already present. */
  readonly fetched: boolean;
}

/** Thrown when a downloaded archive's SHA-256 does not match `checksums.txt`. */
export class AdGuardChecksumError extends Error {
  constructor(
    readonly assetName: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `AdGuard Home archive ${assetName} failed checksum verification ` +
        `(expected ${expected}, got ${actual})`,
    );
    this.name = "AdGuardChecksumError";
  }
}

/** Thrown when a download or the latest-release lookup returns a non-2xx status. */
export class AdGuardDownloadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    statusText: string,
  ) {
    super(`AdGuard Home download failed: ${status} ${statusText} for ${url}`.trimEnd());
    this.name = "AdGuardDownloadError";
  }
}

function defaultReadSentinel(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function defaultWriteBinary(path: string, contents: Buffer): void {
  writeFileSync(path, contents);
  chmodSync(path, BINARY_MODE);
}

interface ResolvedDeps {
  fetch: DownloadFetch;
  fileExists: (path: string) => boolean;
  readSentinel: (path: string) => string | null;
  makeDir: (path: string) => void;
  writeBinary: (path: string, contents: Buffer) => void;
  writeSentinel: (path: string, value: string) => void;
  resolveAsset: () => ReleaseAsset;
}

function resolveDeps(deps: AcquireDeps): ResolvedDeps {
  return {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    fileExists: deps.fileExists ?? existsSync,
    readSentinel: deps.readSentinel ?? defaultReadSentinel,
    makeDir: deps.makeDir ?? ((path) => void mkdirSync(path, { recursive: true })),
    writeBinary: deps.writeBinary ?? defaultWriteBinary,
    writeSentinel: deps.writeSentinel ?? ((path, value) => writeFileSync(path, `${value}\n`)),
    resolveAsset: deps.resolveAsset ?? (() => resolveAsset()),
  };
}

/** GET a URL and return the response, throwing {@link AdGuardDownloadError} on non-2xx. */
async function getOk(
  fetchImpl: DownloadFetch,
  url: string,
): Promise<Awaited<ReturnType<DownloadFetch>>> {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "linux-parental-controls-toolkit" },
  });
  if (!response.ok) {
    throw new AdGuardDownloadError(url, response.status, response.statusText);
  }
  return response;
}

/** Resolve the latest non-prerelease tag from the GitHub releases API. */
async function resolveLatestVersion(fetchImpl: DownloadFetch): Promise<string> {
  const response = await getOk(fetchImpl, LATEST_RELEASE_API_URL);
  const body = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("tag_name" in body) ||
    typeof body.tag_name !== "string" ||
    body.tag_name === ""
  ) {
    throw new Error("AdGuard Home latest-release lookup returned no tag_name");
  }
  return body.tag_name;
}

/**
 * Ensure the AdGuard Home binary is present under `config.dataDir`, downloading
 * and verifying it on first run.
 *
 * Idempotent: when the binary already exists, a pinned `version` is honoured
 * (re-acquired only on a sentinel mismatch) and an unpinned install is left in
 * place. Throws on any download/checksum/extraction failure so the caller (the
 * supervisor's `bootstrap`) can record `failed` with the reason — it does not
 * swallow errors itself.
 */
export async function acquireAdGuardHome(
  config: AcquireConfig,
  deps: AcquireDeps = {},
): Promise<AcquireResult> {
  const d = resolveDeps(deps);
  const binaryPath = join(config.dataDir, BINARY_FILENAME);
  const sentinelPath = join(config.dataDir, VERSION_SENTINEL);

  if (d.fileExists(binaryPath)) {
    // Pinned: re-acquire only when the recorded version drifts from the pin.
    if (config.version === undefined || d.readSentinel(sentinelPath) === config.version) {
      const version = config.version ?? d.readSentinel(sentinelPath) ?? "unknown";
      return { binaryPath, version, fetched: false };
    }
  }

  const asset = d.resolveAsset();
  const version = config.version ?? (await resolveLatestVersion(d.fetch));

  const archiveResponse = await getOk(d.fetch, assetUrl(version, asset));
  const archive = Buffer.from(await archiveResponse.arrayBuffer());

  const checksumsResponse = await getOk(d.fetch, checksumsUrl(version));
  const expected = findChecksum(await checksumsResponse.text(), asset.assetName);
  if (expected === null) {
    throw new Error(`checksums.txt for ${version} has no entry for ${asset.assetName}`);
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new AdGuardChecksumError(asset.assetName, expected, actual);
  }

  const binary = extractFileFromTarGz(archive, ARCHIVE_BINARY_SUFFIX);
  d.makeDir(config.dataDir);
  d.writeBinary(binaryPath, binary);
  d.writeSentinel(sentinelPath, version);

  return { binaryPath, version, fetched: true };
}
