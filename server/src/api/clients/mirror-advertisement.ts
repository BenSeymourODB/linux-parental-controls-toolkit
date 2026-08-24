/**
 * Build the `timekpr-next` mirror advertisement returned in the enrol response
 * (#393, epic #389).
 *
 * Maps the server's `PCT_TIMEKPR_MIRROR` config + the mirror's current on-disk
 * state onto the wire {@link TimekprMirrorAdvertisement} the client consumes
 * (#394). Kept separate from the enrol service so the mapping is a pure,
 * independently-testable unit and the service stays disk-free — the route reads
 * the state (a couple of `fs` calls, managed mode only) and hands the built
 * advertisement in.
 *
 * License boundary: none touched — plain TypeScript reading config + a version
 * string; the `.deb` it points at was fetched at runtime into `/data` by #392,
 * never baked into the image (ADR 0011).
 */
import type { Settings } from "../../config.js";
import {
  readMirrorState,
  type MirrorState,
  type MirrorStateDeps,
} from "../../transport/timekpr-mirror/index.js";
import type { TimekprMirrorAdvertisement } from "./dtos.js";

/**
 * Stable LAN URL path root the managed mirror is served at (relative to the
 * client's `--server-url`). Owned here as part of the enrol contract; the web
 * serving module (`web/timekpr-mirror.ts`) imports it to register the routes, so
 * the advertised path and the served path can never drift apart.
 */
export const TIMEKPR_MIRROR_APT_PATH = "/apt/timekpr";

/**
 * Map a mirror config slice + its current on-disk state onto the advertisement.
 * Pure: `state` is `null` when nothing is cached yet (managed cold start), which
 * surfaces as `version`/`debFilename` `null` so the client falls back to the
 * distro/PPA path (#394) rather than waiting on the mirror.
 */
export function buildTimekprMirrorAdvertisement(
  mirror: Settings["timekprMirror"],
  state: MirrorState | null,
): TimekprMirrorAdvertisement {
  switch (mirror.mode) {
    case "disabled":
      return { mode: "disabled" };
    case "external":
      return { mode: "external", url: mirror.url };
    case "managed":
      return {
        mode: "managed",
        aptPath: TIMEKPR_MIRROR_APT_PATH,
        package: mirror.package,
        version: state?.version ?? null,
        debFilename: state?.filename ?? null,
      };
  }
}

/**
 * Resolve the advertisement for the enrol response: reads the current mirror
 * state from disk in `managed` mode (nothing to read in `disabled`/`external`)
 * and builds the advertisement from it. The `deps` seam keeps it unit-testable
 * without touching real disk.
 */
export function resolveTimekprMirrorAdvertisement(
  mirror: Settings["timekprMirror"],
  deps?: MirrorStateDeps,
): TimekprMirrorAdvertisement {
  const state =
    mirror.mode === "managed"
      ? readMirrorState({ dataDir: mirror.dataDir, package: mirror.package }, deps)
      : null;
  return buildTimekprMirrorAdvertisement(mirror, state);
}
