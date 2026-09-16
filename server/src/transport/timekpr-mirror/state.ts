/**
 * Read the current on-disk state of the managed `timekpr-next` mirror (#393,
 * epic #389).
 *
 * The complement of {@link ./refresh.ts refreshTimekprMirror}: refresh *writes*
 * the newest `.deb` + version sentinel into the mirror's data volume; this
 * *reads* back what is currently cached, so the serving layer
 * (`web/timekpr-mirror.ts`) and the enrol advertisement (`api/clients`) can tell
 * a client which package/version the dashboard is offering. The version sentinel
 * #392 writes is the single source of truth for "what is cached"; the `.deb`
 * filename is derived from it via the shared {@link debFilename}, so the two
 * halves never disagree on the name.
 *
 * Pure read with injected filesystem seams (mirrors `refresh.ts`), so it is
 * unit-testable without touching real disk.
 *
 * License boundary: none touched — reads a version string and stats a file;
 * nothing links, imports, or vendors GPL code, and the `.deb` it points at was
 * fetched at runtime into `/data` by #392, never baked into the image
 * (`CLAUDE.md` → "License boundaries" rules 1 & 5; ADR 0011).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readVersionSentinel, VERSION_SENTINEL } from "./refresh.js";
import { debFilename } from "./release.js";

/** The slice of the managed mirror config the state read needs. */
export interface MirrorStateConfig {
  /** Data-volume directory the mirror's `.deb` + sentinel live under. */
  readonly dataDir: string;
  /** The upstream package/channel mirrored (`timekpr-next` / `timekpr-next-beta`). */
  readonly package: string;
}

/** The `.deb` the mirror currently has cached and can serve. */
export interface MirrorState {
  /** The cached upstream version (from the sentinel). */
  readonly version: string;
  /** The `.deb` filename derived from the package + version. */
  readonly filename: string;
  /** Absolute path to the cached `.deb`. */
  readonly path: string;
}

/** Injectable filesystem seams so tests never touch real disk. */
export interface MirrorStateDeps {
  /** Read the recorded version sentinel, or `null` if absent/unreadable. */
  readSentinel?: (path: string) => string | null;
  /** Existence check for the `.deb`; defaults to `node:fs` `existsSync`. */
  fileExists?: (path: string) => boolean;
}

/**
 * Return the `.deb` the managed mirror currently has cached, or `null` when
 * nothing is cached yet (no sentinel, or the sentinel names a `.deb` that is not
 * on disk). A `null` return is the normal cold-start state before the refresh
 * job's first successful fetch — the caller degrades gracefully (a 404 from the
 * serving routes; `version`/`filename` reported as `null` in the enrol
 * advertisement, so the client falls back to the distro/PPA path).
 */
export function readMirrorState(
  config: MirrorStateConfig,
  deps: MirrorStateDeps = {},
): MirrorState | null {
  const readSentinel = deps.readSentinel ?? readVersionSentinel;
  const fileExists = deps.fileExists ?? existsSync;

  const version = readSentinel(join(config.dataDir, VERSION_SENTINEL));
  if (version === null || version === "") {
    return null;
  }

  const filename = debFilename(config.package, version);
  const path = join(config.dataDir, filename);
  if (!fileExists(path)) {
    return null;
  }

  return { version, filename, path };
}
