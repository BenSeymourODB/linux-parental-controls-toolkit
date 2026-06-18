/** ActivityWatch transport: HTTP REST client tunneled over SSH to `aw-server`. */
export const moduleName = "transport/activitywatch";

export {
  ActivityWatchClient,
  type ActivityWatchClientOptions,
  type ActivityWatchLogger,
  type EventQuery,
  type FetchLike,
} from "./client.js";
export {
  ActivityWatchError,
  ActivityWatchParseError,
  ActivityWatchRequestError,
  ActivityWatchUnreachableError,
} from "./errors.js";
export {
  awAfkDataSchema,
  awBucketSchema,
  awBucketsResponseSchema,
  awEventSchema,
  awEventsResponseSchema,
  awServerInfoSchema,
  awWindowDataSchema,
  BUCKET_TYPE_AFK,
  BUCKET_TYPE_WINDOW,
  type AwAfkEvent,
  type AwBucket,
  type AwEvent,
  type AwServerInfo,
  type AwWindowEvent,
} from "./schemas.js";
