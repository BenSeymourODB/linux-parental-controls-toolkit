/** Server-hosted upstream `timekpr-next` package mirror (managed mode, #389). */
export const moduleName = "transport/timekpr-mirror";

export {
  DEB_AR_MAGIC,
  TIMEKPR_PPA_NAME,
  TIMEKPR_PPA_OWNER,
  TimekprMirrorResolveError,
  binaryFileUrlsSchema,
  binaryFileUrlsUrl,
  debFilename,
  parseLatestPublication,
  publishedBinariesSchema,
  publishedBinarySchema,
  publishedBinariesUrl,
  selectDebUrl,
  selectPinnedPublication,
  type PublishedBinaries,
  type PublishedBinary,
} from "./release.js";
export {
  VERSION_SENTINEL,
  readVersionSentinel,
  refreshTimekprMirror,
  TimekprMirrorDownloadError,
  TimekprMirrorInvalidPackageError,
  type DownloadFetch,
  type RefreshConfig,
  type RefreshDeps,
  type RefreshResult,
} from "./refresh.js";
export {
  readMirrorState,
  type MirrorState,
  type MirrorStateConfig,
  type MirrorStateDeps,
} from "./state.js";
export {
  DEFAULT_REFRESH_BACKOFF,
  DEFAULT_REFRESH_PATTERN,
  REFRESH_LOG_COMPONENT,
  startTimekprMirrorRefresh,
  type RefreshBackoff,
  type TimekprMirrorRefreshHandle,
  type TimekprMirrorRefreshOptions,
} from "./scheduler.js";
