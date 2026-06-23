/**
 * AdGuard Home upstream-release coordinates (managed mode, #96).
 *
 * Pure helpers that map the host platform to an AdGuard Home release asset and
 * build the upstream download URLs. No I/O — the acquisition module (#96
 * `acquire.ts`) does the fetching against these.
 *
 * Asset naming follows AdGuard's GoReleaser convention
 * (`github.com/AdguardTeam/AdGuardHome/releases`): a per-platform archive
 * `AdGuardHome_<os>_<arch>.tar.gz` whose top-level directory holds the
 * `AdGuardHome` binary, alongside a single `checksums.txt` listing the SHA-256
 * of every asset.
 *
 * License boundary: none touched — these are plain URL/string helpers; the
 * binary they point at is fetched at runtime and run as a separate process
 * (`CLAUDE.md` → "License boundaries" rule 5; `docs/licensing-analysis.md`).
 */

/** The GitHub owner/repo AdGuard Home releases are published under. */
export const ADGUARD_REPO = "AdguardTeam/AdGuardHome";

/** Base for release-asset downloads (`…/download/<tag>/<asset>`). */
const RELEASE_DOWNLOAD_BASE = `https://github.com/${ADGUARD_REPO}/releases/download`;

/** GitHub API endpoint resolving the latest non-prerelease release. */
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${ADGUARD_REPO}/releases/latest`;

/** The path *inside* every Linux archive at which the binary lives. */
export const ARCHIVE_BINARY_SUFFIX = "AdGuardHome/AdGuardHome";

/** The bare binary filename written into the data volume. */
export const BINARY_FILENAME = "AdGuardHome";

/**
 * A resolved release asset for the running host: the archive filename and the
 * suffix of the in-archive entry to extract.
 */
export interface ReleaseAsset {
  /** AdGuard's `<os>_<arch>` token, e.g. `linux_amd64`. */
  readonly platform: string;
  /** The `.tar.gz` asset filename, e.g. `AdGuardHome_linux_amd64.tar.gz`. */
  readonly assetName: string;
}

/**
 * Map Node's `process.arch` to AdGuard's release-asset arch token.
 *
 * Covers the architectures AdGuard publishes Linux archives for; anything else
 * (e.g. a future `riscv64`) is unmapped and rejected by {@link resolveAsset} so
 * managed mode fails loudly rather than downloading a wrong-arch binary.
 */
const ARCH_TOKENS: Readonly<Record<string, string>> = {
  x64: "amd64",
  arm64: "arm64",
  ia32: "386",
  arm: "armv7",
};

/** Thrown when the host platform has no published AdGuard Home Linux archive. */
export class UnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform, arch: string) {
    super(
      `AdGuard Home managed mode has no release archive for ${platform}/${arch}; ` +
        `use PCT_ADGUARD_MODE=external instead`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Resolve the AdGuard Home release asset for the running host.
 *
 * Managed mode is a Linux-only, in-container concern (the dashboard image is
 * `node:22-slim`), so only `linux` is supported; the arch is mapped via
 * {@link ARCH_TOKENS}. Throws {@link UnsupportedPlatformError} otherwise.
 */
export function resolveAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseAsset {
  const archToken = ARCH_TOKENS[arch];
  if (platform !== "linux" || archToken === undefined) {
    throw new UnsupportedPlatformError(platform, arch);
  }
  const token = `linux_${archToken}`;
  return { platform: token, assetName: `AdGuardHome_${token}.tar.gz` };
}

/** The download URL for a release asset at a given version tag (e.g. `v0.107.65`). */
export function assetUrl(version: string, asset: ReleaseAsset): string {
  return `${RELEASE_DOWNLOAD_BASE}/${version}/${asset.assetName}`;
}

/** The download URL for a release's `checksums.txt` at a given version tag. */
export function checksumsUrl(version: string): string {
  return `${RELEASE_DOWNLOAD_BASE}/${version}/checksums.txt`;
}

/**
 * Find the SHA-256 hex digest for {@link assetName} in a `checksums.txt` body.
 *
 * GoReleaser emits `<hex>␠␠<filename>` lines; the filename may carry a `./`
 * prefix. Returns the lower-cased digest, or `null` when the asset is absent.
 */
export function findChecksum(checksumsBody: string, assetName: string): string | null {
  for (const line of checksumsBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^([0-9a-fA-F]{64})\s+\.?\/?(\S+)$/.exec(trimmed);
    const [, digest, name] = match ?? [];
    if (digest !== undefined && name === assetName) {
      return digest.toLowerCase();
    }
  }
  return null;
}
