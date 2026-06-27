# Plan — #235: opt-in `trustProxy` for the per-IP failed-attempt limiter

Roadmap: `docs/roadmap.md` → Phase 11 (hardening/polish; reverse-proxy + TLS).

## Problem

`buildApp()` (`server/src/web/app.ts`) constructs Fastify without
`trustProxy`, so `request.ip` is always the immediate TCP peer. The two
unauthenticated surfaces key their per-IP failed-attempt limiter on
`request.ip`:

- admin login — `server/src/auth/routes.ts:41`
- `POST /api/clients/enrol` — `server/src/api/clients/routes.ts:102`

Behind a reverse proxy every request arrives from the proxy's address, so
the per-IP limiter collapses into one global bucket (one host's
brute-force throttles everyone). Defence-in-depth degradation, not an auth
bypass.

## Design

Add an opt-in `PCT_TRUST_PROXY` setting, **default off**, parsed in
`server/src/config.ts` into the shape Fastify's
[`trustProxy`](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)
option accepts (which Fastify hands to `proxy-addr`):

- boolean word-forms → `true` / `false` (`true|false|yes|no|on|off`,
  case-insensitive)
- a bare non-negative integer → hop count (`number`)
- anything else → comma-separated CIDR/IP/keyword allowlist → `string[]`
  (e.g. `127.0.0.1,10.0.0.0/8`, or `loopback`)
- unset / empty / whitespace-only → `false` (preserve current safe LAN
  behaviour: never trust `X-Forwarded-*` from an untrusted direct caller)

Parsing precedence is deliberate and documented: boolean **words** are
booleans; a bare integer is a **hop count** (so `"1"`/`"0"` mean 1/0 hops,
not true/false); everything else is an **allowlist**.

`Settings.trustProxy: boolean | number | string[]`. Thread it into the
`Fastify({ ... })` factory in `buildApp()` as `trustProxy: settings.trustProxy`.
Passing `false` is identical to Fastify's default, so the off path is a
no-op.

No change to the limiter or the two routes — they already key on
`request.ip`, which is exactly what `trustProxy` redefines.

## License / tamper

N/A — no GPL surface, no transport/packaging/Docker change, no
tamper-resistance feature. Pure Fastify config + parsing.

## Phases

1. **config + wiring + tests** — `parseTrustProxy` helper + schema field in
   `config.ts`; thread into `app.ts`; unit tests in `tests/config.test.ts`
   (each parse form + default) and `tests/web/app.test.ts` (limiter buckets
   per forwarded IP when enabled+trusted; spoofed `X-Forwarded-For` ignored
   when disabled, via `app.inject` against the login limiter).
2. **docs** — update `docs/reverse-proxy-tls.md` → "Client IP and the
   failed-attempt limiter" (planned→shipped) and add `PCT_TRUST_PROXY` to
   `docs/server-deployment.md` + `.env.example` if present.

## Acceptance criteria (from the issue)

- [ ] Opt-in `PCT_TRUST_PROXY`, default off; supports boolean / hop count /
      CIDR-IP allowlist.
- [ ] Limiter keys on forwarded client IP when enabled and trusted.
- [ ] Spoofed `X-Forwarded-For` ignored when disabled.
- [ ] Docs updated.
