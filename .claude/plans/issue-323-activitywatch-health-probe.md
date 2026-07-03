# Plan — #323 Client health: surface ActivityWatch per-client connectivity

Roadmap: `docs/roadmap.md` → Phase 5 (ActivityWatch telemetry pull).

## Problem

`ClientHealthResponse`'s `activitywatch` component is permanently `unknown`
(a `DeferredProbe` with detail "per-user aw-server probe lands with Phase 5
(#86)"). Phase-5 SSH port-forward infra (#86) has since landed, so we can now
probe `aw-server` and report `ok` / `unhealthy` instead. A client whose AW has
crashed/been removed currently looks identical to a healthy one.

## Existing pieces we compose

- `SshTransport.withPortForward(target, {host?, port}, fn, opts?)` — opens a
  loopback local forward to the client's `aw-server` (5600), hands `fn` the
  local base URL, tears the forward down in a `finally` (leak-free). Same
  tunnel the #86 telemetry pull uses.
- `ActivityWatchClient.getInfo()` — REST-only `GET /api/0/info`, returns
  validated `AwServerInfo`. Throws the AW error taxonomy:
  `ActivityWatchUnreachableError` (no HTTP response), `ActivityWatchRequestError`
  (non-2xx), `ActivityWatchParseError` (bad body).
- `SshClientProber` walks `CLIENT_COMPONENTS`; constructed with the full
  `SshTransport` (which already has `withPortForward`) at
  `transport/policy-push/bootstrap.ts:198` — no call-site change needed.

## Design decision — per-user dimensionality (issue's "design this first")

`aw-server` is per-supervised-user; the issue flags `ComponentHealthDto` "may
need a per-user breakdown". This slice reports a single per-client
`activitywatch` verdict against the conventional `localhost:5600` bind,
matching today's per-(client, component) DTO shape. Rationale: the DTO/prober
are per-client-per-component; per-user multiplexing is a cross-cutting DTO+UI
change coupled to the unlanded #103 per-user agent probe (the issue's own
reference design); Alpha-1 assumes one account per child. True multi-user AW
health is deferred to a tracked follow-up, referenced from the PR.

## Changes (single coherent slice)

1. `transport/health/components.ts` — add
   `ActivityWatchRestProbe { method:"activitywatch-rest"; port:number }` to the
   `ComponentProbe` union; point the `activitywatch` entry at port 5600; add
   pure `classifyActivityWatchInfo(info)` (→ ok, "aw-server <version>") and
   `activityWatchFailureDetail(error)` mappers; refresh the module doc.
2. `transport/health/prober.ts` — extend `HealthProbeTransport` to also require
   `withPortForward` (structural); add injectable
   `probeAwServer?: (baseUrl)=>Promise<AwServerInfo>` defaulting to
   `new ActivityWatchClient({baseUrl}).getInfo()`; handle the
   `activitywatch-rest` branch in `probe()` — success→ok, `ActivityWatchError`→
   unhealthy, `SshError`→existing offline path, else rethrow.
3. Tests — `components.test.ts` (the two mappers); `prober.test.ts` (fake
   transport gains `withPortForward`; ok / unhealthy-per-error-kind / SSH-drop→
   offline / rethrow; update the existing online assertion for the new AW
   verdict).

## License boundary / non-goals

REST-only over the loopback SSH tunnel (rule 4 unchanged, no GPL linked). No
DTO/route/UI change (slot already renders), no per-user breakdown, no new dep.

## Quality gate

`npm run format && npm run lint:fix && npm run typecheck && npm test` from
`server/` (coverage 80%).
