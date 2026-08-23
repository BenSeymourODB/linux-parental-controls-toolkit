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
  refreshTimekprMirror,
  TimekprMirrorDownloadError,
  TimekprMirrorInvalidPackageError,
  type DownloadFetch,
  type RefreshConfig,
  type RefreshDeps,
  type RefreshResult,
} from "./refresh.js";
