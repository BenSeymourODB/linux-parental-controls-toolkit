# Issue #87 — ActivityWatch REST client + zod-validated event parsing

Roadmap: `docs/roadmap.md` → Phase 5 ("ActivityWatch telemetry pull").
Module home: `server/src/transport/activitywatch/`.
Test home: `server/tests/transport/activitywatch/`.

## Goal

A typed, REST-only client for `aw-server`'s buckets/events API that the
Phase-5 telemetry job (#86 SSH port-forward, #88 normalisation) drives. It
takes an injected base URL (the local end of the SSH forward, typically
`http://localhost:<forwarded>`), queries buckets and events for a polling
window, and validates every response with zod before it crosses into typed
code. REST-only — no source-level coupling to ActivityWatch (license
boundary, `docs/licensing-analysis.md`; AW is REST-only per
`CLAUDE.md` → "License boundaries" rule 4).

## Boundary with neighbouring issues

- **In scope (#87):** connection options + per-request timeout, the
  buckets/events/info REST calls, zod schemas for AW responses, windowed
  querying (caller supplies `start`/`end`), an error taxonomy that separates
  *unreachable* (feeds the offline-queue / retry) from *request failed* and
  *malformed response*, and typed `window`/`afk` event projections.
- **Out of scope:** normalisation into `UsageSample` rows, dedup of
  clock-skew overlaps, dropping future-timestamped events, aggregation —
  that is #88. The SSH port-forward itself is #86; this client only needs the
  resulting base URL. No `croner` scheduling here (#86).

## API surface

```ts
interface ActivityWatchClientOptions {
  baseUrl: string;          // e.g. "http://localhost:5600"
  timeoutMs?: number;       // per-request; default 10_000
  fetch?: typeof fetch;     // injectable for DI/tests; default global fetch
}

interface EventQuery { start: Date; end: Date; limit?: number }

class ActivityWatchClient {
  getInfo(): Promise<AwServerInfo>;                 // GET /api/0/info
  listBuckets(): Promise<AwBucket[]>;               // GET /api/0/buckets/
  getEvents(bucketId, query): Promise<AwEvent[]>;   // GET /api/0/buckets/{id}/events
  getWindowEvents(query): Promise<AwWindowEvent[]>; // currentwindow buckets, typed data
  getAfkEvents(query): Promise<AwAfkEvent[]>;       // afkstatus buckets, typed data
}
```

`getWindowEvents` / `getAfkEvents` locate buckets by AW `type`
(`currentwindow` / `afkstatus`), then project each event's `data` through the
watcher-specific zod schema; events whose `data` does not match are **skipped**
(robustness — "skip malformed payloads rather than trusting them"), while a
whole-response shape mismatch on the generic events call is **rejected** with a
typed parse error.

## Files

- `src/transport/activitywatch/errors.ts` — `ActivityWatchError` base +
  `ActivityWatchUnreachableError` (carries `cause`, `timedOut`),
  `ActivityWatchRequestError` (carries `statusCode`), `ActivityWatchParseError`
  (carries the `ZodError`).
- `src/transport/activitywatch/schemas.ts` — zod schemas: server info, bucket
  (object-map → array), event (ISO timestamp → `Date`), window/afk `data`.
- `src/transport/activitywatch/client.ts` — the client + request helper
  (timeout via `AbortSignal.timeout`, error mapping, zod parse-or-throw).
- `src/transport/activitywatch/index.ts` — keep `moduleName`
  (package-layout smoke test) + re-export the public surface.
- `tests/transport/activitywatch/client.test.ts` — undici `MockAgent` for the
  HTTP happy / non-2xx / malformed paths and `replyWithError` for unreachable;
  injected fetch for the deterministic timeout path.
- `tests/transport/activitywatch/schemas.test.ts` — direct schema coverage.

## Testing approach

Follow `docs/testing.md` → "Transport — REST": undici `MockAgent` +
`setGlobalDispatcher`, `disableNetConnect`, `assertNoPendingInterceptors`.
Cases: happy buckets/events/info; bucket discovery by type; window/afk
projection incl. skip-malformed; empty bucket → `[]`; non-2xx →
`ActivityWatchRequestError`; connection error → `ActivityWatchUnreachableError`;
timeout (injected fetch honouring the abort signal) → unreachable with
`timedOut`; non-JSON / shape-mismatch → `ActivityWatchParseError`; invalid
window (`end` before `start`) rejected before any request. Coverage gate 80%.

## New dependency

`undici` (devDependency only) — the REST-mock pattern prescribed by
`docs/testing.md`; Node bundles undici for global `fetch` but the importable
`MockAgent`/`setGlobalDispatcher` test API needs the package present. No
existing dependency intercepts outbound HTTP. Not shipped in the runtime image.

## Observability — don't silently drop telemetry

`getWindowEvents` / `getAfkEvents` and `listBuckets` **skip** individual
malformed entries rather than failing the whole pull, but skipping silently
would hide a real watcher/version problem. The client takes an optional
injected `logger` (`{ warn(obj, msg): void }`, default a noop) and emits a warn
per skipped entry. The top-level shape is still validated strictly (a buckets
body that is not an object, or an events body that is not an array, throws
`ActivityWatchParseError`); only per-entry shape mismatches are skipped+warned.

## License-boundary note

REST-only over HTTP; no ActivityWatch source linked, no GPL binary added to the
image. New dep is dev-only.
