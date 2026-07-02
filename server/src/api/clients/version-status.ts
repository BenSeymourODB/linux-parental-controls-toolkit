/**
 * Client version-drift classification (#352): the pure, I/O-free core that
 * decides how a client's reported agent version compares to the dashboard's own
 * release, for the badge the admin "Clients" page renders.
 *
 * Two axes feed the verdict, and they are deliberately kept separate:
 *
 *  - **`update_required` (the red state)** is authoritative and comes from the
 *    event-stream protocol handshake (ADR 0007 §5), governed by the configurable
 *    compatibility window (`PCT_PROTOCOL_COMPAT_WINDOW` → {@link negotiate}). If
 *    the server refused the client for speaking an out-of-window protocol, it
 *    *must* update regardless of what its version string says.
 *  - **version drift (green / amber / grey)** compares the reported
 *    `agentVersion` *string* against the server's own version string. This is
 *    the only signal available for a client that has never connected the event
 *    stream (exactly the case that motivated this issue), which reports only its
 *    enrol-time version and never reaches the protocol handshake.
 *
 * Isolated here — mirroring `events/protocol.ts`, `policy/budget-window.ts` — so
 * the comparison is unit-testable with zero I/O and the frontend never
 * reimplements it.
 *
 * License boundary: none touched — plain TypeScript.
 */

/** The per-client version verdict the Clients page badges on. */
export const clientVersionStatusValues = [
  /** Reported version equals or is newer than the server's. */
  "up_to_date",
  /** Reported version is older than the server's, but still protocol-compatible. */
  "outdated",
  /** The protocol handshake refused this client as too old (ADR 0007 §5). */
  "update_required",
  /** No reported version, no server version, or an unparseable version string. */
  "unknown",
] as const;

/** One of {@link clientVersionStatusValues}. */
export type ClientVersionStatus = (typeof clientVersionStatusValues)[number];

/** A version split into its numeric release identifiers and prerelease tag. */
interface ParsedVersion {
  /** Dot-separated numeric release identifiers, e.g. `[0, 1, 0]`. */
  release: number[];
  /**
   * Dot-separated prerelease identifiers (`["alpha", "5"]`) or `null` for a
   * final release. A prerelease sorts *before* the same release with no tag
   * (semver §11), matching Debian's `~` ordering.
   */
  prerelease: string[] | null;
}

/**
 * Parse a version string into {@link ParsedVersion}, or `null` when the release
 * component is not purely numeric-dotted (so callers report `unknown` rather
 * than guess an order).
 *
 * Handles the two forms this project emits: a semver tag (`0.1.0-alpha.5`, the
 * release-workflow / git-tag form) and a Debian package version (`0.1.0~alpha.5`,
 * the `dpkg --showformat '${Version}'` the client reports at enrol). A leading
 * `v` and either prerelease separator (`-` or `~`) are normalised away. The
 * Debian `epoch:` prefix and `-revision` suffix are out of scope — this project
 * versions its own artifacts as plain semver — so a `-<numeric>` Debian revision
 * would be read as a prerelease; documented rather than handled.
 */
function parseVersion(raw: string): ParsedVersion | null {
  const trimmed = raw.trim().replace(/^[vV]/, "");
  if (trimmed === "") return null;

  // The first `-` or `~` starts the prerelease tag; `~` is Debian's marker and
  // `-` is semver's, and both sort the tail before a final release.
  const sepIndex = trimmed.search(/[-~]/);
  const releasePart = sepIndex === -1 ? trimmed : trimmed.slice(0, sepIndex);
  const prereleasePart = sepIndex === -1 ? null : trimmed.slice(sepIndex + 1);

  // Require each release identifier to be a plain non-negative decimal integer.
  // `Number` alone would accept `3e2`/`0x0` and coerce `""`→0, admitting version
  // strings this project never emits; a strict per-identifier check matches the
  // "numeric-dotted" contract and returns `null` (→ `unknown`) for anything else.
  const releaseIds = releasePart.split(".");
  if (releaseIds.length === 0 || releaseIds.some((id) => !/^\d+$/.test(id))) {
    return null;
  }
  const release = releaseIds.map((id) => Number(id));

  const prerelease =
    prereleasePart === null || prereleasePart === "" ? null : prereleasePart.split(".");
  return { release, prerelease };
}

/** Compare two dot-separated numeric release id lists; missing fields are `0`. */
function compareRelease(a: number[], b: number[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/** Compare a single prerelease identifier pair per semver §11 (numeric < alnum). */
function comparePreId(a: string, b: string): -1 | 0 | 1 {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const an = Number(a);
    const bn = Number(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two prerelease tag lists per semver §11 (a longer tag wins on a tie). */
function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    // Both indices are within bounds of the shared prefix.
    const cmp = comparePreId(a[i] as string, b[i] as string);
    if (cmp !== 0) return cmp;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/**
 * Order two version strings: `-1` if `a` is older, `1` if newer, `0` if equal,
 * or `null` if either is unparseable (the caller then reports `unknown`).
 * Follows semver precedence, including "a prerelease sorts before its release".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;

  const releaseCmp = compareRelease(pa.release, pb.release);
  if (releaseCmp !== 0) return releaseCmp;

  // Same release: a version with a prerelease tag is older than one without.
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** Inputs to {@link classifyVersionStatus}. */
export interface VersionStatusInput {
  /** The client's reported agent version, or `null` if none reported. */
  clientVersion: string | null;
  /** The dashboard's own version, or `null` if the build didn't stamp one. */
  serverVersion: string | null;
  /** Whether the protocol handshake has flagged this client as too old. */
  updateRequired: boolean;
}

/**
 * Classify a client's version drift into the badge the Clients page renders.
 *
 * `update_required` (the protocol handshake's verdict, governed by the
 * configurable compatibility window) always wins — it is the authoritative
 * "must update". Otherwise the reported version string is compared to the
 * server's: equal-or-newer is `up_to_date`, older is `outdated`, and anything we
 * can't compare (missing or unparseable version) is `unknown` rather than a
 * misleading verdict.
 */
export function classifyVersionStatus(input: VersionStatusInput): ClientVersionStatus {
  if (input.updateRequired) return "update_required";
  if (input.clientVersion === null || input.serverVersion === null) return "unknown";

  const cmp = compareVersions(input.clientVersion, input.serverVersion);
  if (cmp === null) return "unknown";
  return cmp < 0 ? "outdated" : "up_to_date";
}
