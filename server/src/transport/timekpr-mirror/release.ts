/**
 * Upstream (Launchpad PPA) release coordinates for the `timekpr-next` mirror
 * (#392, epic #389).
 *
 * Pure helpers that build the Launchpad `devel` API URLs and parse/validate the
 * responses that {@link ./refresh.ts refreshTimekprMirror} fetches against. No
 * I/O here — this is the direct analogue of `adguard/release.ts` (#96): the
 * fetch module does the network + filesystem work behind injected seams.
 *
 * The PPA is `~mjasnik/+archive/ubuntu/ppa`, matching
 * `client/install-baseline-tools.sh` (`TIMEKPR_PPA_LP_API`). `timekpr-next` is
 * an `Architecture: all` Python package, so there is exactly one arch-independent
 * `<pkg>_<version>_all.deb` per version.
 *
 * License boundary: none touched — plain URL/string helpers + zod parsing; the
 * `.deb` they point at is fetched at runtime into `/data` and never linked,
 * imported, or baked into the image (`CLAUDE.md` → "License boundaries" rules
 * 1 & 5; ADR 0011; `docs/licensing-analysis.md`).
 */
import { z } from "zod";

/** The Launchpad person/PPA the mirror tracks (matches the client installer). */
export const TIMEKPR_PPA_OWNER = "mjasnik";
export const TIMEKPR_PPA_NAME = "ppa";

/** Base of the Launchpad `devel` API archive resource for the PPA. */
const LP_ARCHIVE_URL =
  `https://api.launchpad.net/devel/~${TIMEKPR_PPA_OWNER}` + `/+archive/ubuntu/${TIMEKPR_PPA_NAME}`;

/**
 * The Debian `ar` archive global header every `.deb` begins with. The fetch
 * module rejects a download that does not start with these bytes (a truncated
 * body or an HTML error page served with a 200), a cheap structural integrity
 * check ahead of the cryptographic verification the signed apt index adds (#393).
 */
export const DEB_AR_MAGIC = "!<arch>\n";

/**
 * How many published-binary records to request per resolution. `order_by_date`
 * returns newest first, so a small window comfortably covers "the latest" and a
 * recent pin without paginating; a pin older than this fails loudly (asking the
 * operator to un-pin or update) rather than silently mis-resolving.
 */
const PUBLISHED_BINARIES_PAGE_SIZE = 75;

/** Thrown when the Launchpad response cannot be resolved to a usable release. */
export class TimekprMirrorResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimekprMirrorResolveError";
  }
}

/**
 * One `binary_package_publishing_history` entry from `getPublishedBinaries`.
 * Only the fields the resolver needs are modelled; Launchpad sends many more and
 * zod strips the rest.
 */
export const publishedBinarySchema = z.object({
  binary_package_name: z.string().min(1),
  binary_package_version: z.string().min(1),
  /** The entry's own resource URL; `binaryFileUrls` is derived from it. */
  self_link: z.url(),
});
export type PublishedBinary = z.infer<typeof publishedBinarySchema>;

/** The Lazr collection wrapper `getPublishedBinaries` returns. */
export const publishedBinariesSchema = z.object({
  entries: z.array(publishedBinarySchema),
});
export type PublishedBinaries = z.infer<typeof publishedBinariesSchema>;

/** `binaryFileUrls` returns a bare JSON array of librarian file URLs. */
export const binaryFileUrlsSchema = z.array(z.url());

/**
 * Build the `getPublishedBinaries` API URL for a package on the PPA.
 *
 * `status=Published` + `exact_match=true` scope the result to the live binary of
 * exactly this package; `order_by_date=true` returns the most recent publication
 * first so {@link parseLatestPublication} can take `entries[0]`.
 */
export function publishedBinariesUrl(packageName: string): string {
  const params = new URLSearchParams({
    "ws.op": "getPublishedBinaries",
    binary_name: packageName,
    status: "Published",
    exact_match: "true",
    order_by_date: "true",
    "ws.size": String(PUBLISHED_BINARIES_PAGE_SIZE),
  });
  return `${LP_ARCHIVE_URL}?${params.toString()}`;
}

/** Build the `binaryFileUrls` API URL for a publishing record's `self_link`. */
export function binaryFileUrlsUrl(selfLink: string): string {
  const separator = selfLink.includes("?") ? "&" : "?";
  return `${selfLink}${separator}ws.op=binaryFileUrls`;
}

/**
 * Resolve the newest published record from a validated collection.
 *
 * `order_by_date=true` means `entries[0]` is the most recently published, which
 * for a PPA is the newest version — the "latest" ADR 0011 tracks. Throws
 * {@link TimekprMirrorResolveError} when the collection is empty.
 */
export function parseLatestPublication(collection: PublishedBinaries): PublishedBinary {
  const [latest] = collection.entries;
  if (latest === undefined) {
    throw new TimekprMirrorResolveError(
      "Launchpad returned no published binaries for the configured timekpr package/channel",
    );
  }
  return latest;
}

/**
 * Select the publishing record matching a pinned version from a validated
 * collection. Throws {@link TimekprMirrorResolveError} when no entry on the page
 * matches (an unpublished or too-old pin).
 */
export function selectPinnedPublication(
  collection: PublishedBinaries,
  version: string,
): PublishedBinary {
  const match = collection.entries.find((entry) => entry.binary_package_version === version);
  if (match === undefined) {
    throw new TimekprMirrorResolveError(
      `pinned timekpr version ${version} is not among the published binaries; ` +
        `un-pin PCT_TIMEKPR_MIRROR_VERSION or set a currently-published version`,
    );
  }
  return match;
}

/**
 * The version token apt uses in a `.deb` filename: any Debian *epoch* (`N:`
 * prefix) is stripped, since the epoch is metadata that never appears in the
 * on-disk filename. `timekpr-next` carries no epoch today, but keying the
 * filename off the raw version would mis-match the librarian file the moment
 * upstream ever added one — so strip it defensively.
 */
function debFileVersion(version: string): string {
  const colon = version.indexOf(":");
  return colon === -1 ? version : version.slice(colon + 1);
}

/** The expected `.deb` filename for an `Architecture: all` package version. */
export function debFilename(packageName: string, version: string): string {
  return `${packageName}_${debFileVersion(version)}_all.deb`;
}

/**
 * Pick the binary `.deb` download URL for `<pkg>_<version>_all.deb` from a
 * validated `binaryFileUrls` array.
 *
 * Launchpad may list several files for a publication (e.g. multiple builds); the
 * arch-independent `_all.deb` for this exact version is selected by basename.
 * Throws {@link TimekprMirrorResolveError} when it is absent.
 */
export function selectDebUrl(
  urls: readonly string[],
  packageName: string,
  version: string,
): string {
  const wanted = debFilename(packageName, version);
  const match = urls.find((url) => basename(url) === wanted);
  if (match === undefined) {
    throw new TimekprMirrorResolveError(
      `Launchpad listed no ${wanted} among the published files for ${packageName} ${version}`,
    );
  }
  return match;
}

/** The last path segment of a URL, ignoring any query/fragment. */
function basename(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "";
}
