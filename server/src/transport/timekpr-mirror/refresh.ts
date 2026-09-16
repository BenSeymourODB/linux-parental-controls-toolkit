/**
 * Background fetch/refresh of the upstream `timekpr-next` `.deb` into the
 * managed mirror's data volume (#392, epic #389).
 *
 * Resolves the newest published version from the PPA's Launchpad API (or honours
 * a pinned version), downloads the arch-independent `.deb` into `config.dataDir`,
 * and records the version in a sentinel so an already-current mirror is a no-op.
 * This is the "fetched from upstream at runtime into `/data`" half of the mirror
 * (ADR 0011), the direct analogue of `adguard/acquire.ts` (#96).
 *
 * Every side-effecting boundary — network (`fetch`), filesystem, and the retry
 * clock (`sleep`) — is an injected seam, so the whole module is unit-testable
 * without touching the real network or disk.
 *
 * License boundary: the `.deb` is fetched at runtime and written to `/data`;
 * nothing here links, imports, or vendors GPL code, and no binary is baked into
 * the image (`CLAUDE.md` → "License boundaries" rules 1 & 5; ADR 0011). Index
 * generation, serving, and cryptographic verification are the signed-index
 * slice's job (#393); this MVP trusts HTTPS + a structural `.deb` check.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEB_AR_MAGIC,
  binaryFileUrlsSchema,
  binaryFileUrlsUrl,
  debFilename,
  parseLatestPublication,
  publishedBinariesSchema,
  publishedBinariesUrl,
  selectDebUrl,
  selectPinnedPublication,
  type PublishedBinary,
} from "./release.js";

/** Filename of the version sentinel written beside the mirrored `.deb`. */
export const VERSION_SENTINEL = ".pct-timekpr-mirror-version";

/** Default network-retry attempts per Launchpad request / download. */
const DEFAULT_RETRY_ATTEMPTS = 3;

/** Default base delay (ms) for the exponential retry backoff. */
const DEFAULT_RETRY_BASE_MS = 1000;

/**
 * The minimal `fetch` surface the refresh uses — reads JSON, text, and binary
 * bodies. Structural so the Node 22 global `fetch` satisfies it and a test can
 * pass a recording fake without a cast (mirrors `adguard/acquire.ts`).
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

/** Configuration the refresh needs (a slice of the `managed` mirror settings). */
export interface RefreshConfig {
  /** Data-volume directory the mirror's `.deb` + sentinel live under. */
  readonly dataDir: string;
  /** The upstream package/channel to mirror (`timekpr-next` / `timekpr-next-beta`). */
  readonly package: string;
  /** Optional pinned version; when unset the newest published version is tracked. */
  readonly version?: string;
}

/** Injectable seams so tests never hit the network or real disk. */
export interface RefreshDeps {
  /** `fetch` for the API lookups + download; defaults to the global `fetch`. */
  fetch?: DownloadFetch;
  /** Existence check; defaults to `node:fs` `existsSync`. */
  fileExists?: (path: string) => boolean;
  /** Read the recorded version sentinel, or `null` if absent/unreadable. */
  readSentinel?: (path: string) => string | null;
  /** Recursively create a directory (and parents). */
  makeDir?: (path: string) => void;
  /** Write the downloaded `.deb`. */
  writeDeb?: (path: string, contents: Buffer) => void;
  /** Record the acquired version. */
  writeSentinel?: (path: string, value: string) => void;
  /** Sleep between retry attempts; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Network-retry attempts per request; defaults to {@link DEFAULT_RETRY_ATTEMPTS}. */
  retryAttempts?: number;
  /** Base delay (ms) for the retry backoff; defaults to {@link DEFAULT_RETRY_BASE_MS}. */
  retryBaseMs?: number;
}

/** Outcome of a {@link refreshTimekprMirror} call. */
export interface RefreshResult {
  /** The version now present in the mirror. */
  readonly version: string;
  /** The `.deb` filename written into the data volume. */
  readonly filename: string;
  /** Absolute path to the (now-present) `.deb`. */
  readonly path: string;
  /** True when this call downloaded the `.deb`; false when it was already current. */
  readonly fetched: boolean;
}

/** Thrown when a Launchpad request or the download returns a non-2xx status. */
export class TimekprMirrorDownloadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    statusText: string,
  ) {
    super(`timekpr mirror download failed: ${status} ${statusText} for ${url}`.trimEnd());
    this.name = "TimekprMirrorDownloadError";
  }
}

/** Thrown when a downloaded body is not a Debian `.deb` (truncated / error page). */
export class TimekprMirrorInvalidPackageError extends Error {
  constructor(readonly url: string) {
    super(`downloaded body from ${url} is not a Debian package (bad ar header)`);
    this.name = "TimekprMirrorInvalidPackageError";
  }
}

interface ResolvedDeps {
  fetch: DownloadFetch;
  fileExists: (path: string) => boolean;
  readSentinel: (path: string) => string | null;
  makeDir: (path: string) => void;
  writeDeb: (path: string, contents: Buffer) => void;
  writeSentinel: (path: string, value: string) => void;
  sleep: (ms: number) => Promise<void>;
  retryAttempts: number;
  retryBaseMs: number;
}

function defaultReadSentinel(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function resolveDeps(deps: RefreshDeps): ResolvedDeps {
  return {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    fileExists: deps.fileExists ?? existsSync,
    readSentinel: deps.readSentinel ?? defaultReadSentinel,
    makeDir: deps.makeDir ?? ((path) => void mkdirSync(path, { recursive: true })),
    writeDeb: deps.writeDeb ?? ((path, contents) => writeFileSync(path, contents)),
    writeSentinel: deps.writeSentinel ?? ((path, value) => writeFileSync(path, `${value}\n`)),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    // Clamp to ≥ 1 so a single attempt always runs — otherwise `withRetry` would
    // never enter its loop and throw an `undefined` "last error".
    retryAttempts: Math.max(1, deps.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS),
    retryBaseMs: deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
  };
}

/**
 * Run `op` up to `attempts` times, waiting `baseMs * 2 ** (n-1)` between tries.
 * The last failure propagates so the caller (the scheduler) can log + back off.
 */
async function withRetry<T>(
  op: () => Promise<T>,
  attempts: number,
  baseMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(baseMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

/** GET a URL and return the response, throwing {@link TimekprMirrorDownloadError} on non-2xx. */
async function getOk(
  fetchImpl: DownloadFetch,
  url: string,
): Promise<Awaited<ReturnType<DownloadFetch>>> {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "linux-parental-controls-toolkit" },
  });
  if (!response.ok) {
    throw new TimekprMirrorDownloadError(url, response.status, response.statusText);
  }
  return response;
}

/** Resolve the publishing record to mirror (pinned version, or the newest). */
async function resolvePublication(
  d: ResolvedDeps,
  config: RefreshConfig,
): Promise<PublishedBinary> {
  const url = publishedBinariesUrl(config.package);
  const body = await withRetry(
    async () => (await getOk(d.fetch, url)).json(),
    d.retryAttempts,
    d.retryBaseMs,
    d.sleep,
  );
  const collection = publishedBinariesSchema.parse(body);
  return config.version === undefined
    ? parseLatestPublication(collection)
    : selectPinnedPublication(collection, config.version);
}

/** Resolve the `.deb` download URL for a publishing record. */
async function resolveDebUrl(
  d: ResolvedDeps,
  publication: PublishedBinary,
  config: RefreshConfig,
): Promise<string> {
  const url = binaryFileUrlsUrl(publication.self_link);
  const body = await withRetry(
    async () => (await getOk(d.fetch, url)).json(),
    d.retryAttempts,
    d.retryBaseMs,
    d.sleep,
  );
  const urls = binaryFileUrlsSchema.parse(body);
  return selectDebUrl(urls, config.package, publication.binary_package_version);
}

/** Download the `.deb`, verifying its Debian `ar` header. */
async function downloadDeb(d: ResolvedDeps, debUrl: string): Promise<Buffer> {
  const bytes = await withRetry(
    async () => Buffer.from(await (await getOk(d.fetch, debUrl)).arrayBuffer()),
    d.retryAttempts,
    d.retryBaseMs,
    d.sleep,
  );
  if (!bytes.subarray(0, DEB_AR_MAGIC.length).equals(Buffer.from(DEB_AR_MAGIC, "ascii"))) {
    throw new TimekprMirrorInvalidPackageError(debUrl);
  }
  return bytes;
}

/**
 * Ensure the mirror's `.deb` is current under `config.dataDir`.
 *
 * Idempotent: when the resolved version's `.deb` is already present and the
 * sentinel matches, no download happens (`fetched: false`). Otherwise the newest
 * (or pinned) version is downloaded, structurally verified, and written with an
 * updated sentinel. Throws on any resolution/download/verification failure so
 * the scheduler can log it and back off; it does not swallow errors itself.
 */
export async function refreshTimekprMirror(
  config: RefreshConfig,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const d = resolveDeps(deps);
  const sentinelPath = join(config.dataDir, VERSION_SENTINEL);

  const publication = await resolvePublication(d, config);
  const version = publication.binary_package_version;
  const filename = debFilename(config.package, version);
  const path = join(config.dataDir, filename);

  if (d.fileExists(path) && d.readSentinel(sentinelPath) === version) {
    return { version, filename, path, fetched: false };
  }

  const debUrl = await resolveDebUrl(d, publication, config);
  const bytes = await downloadDeb(d, debUrl);

  d.makeDir(config.dataDir);
  d.writeDeb(path, bytes);
  d.writeSentinel(sentinelPath, version);

  return { version, filename, path, fetched: true };
}
