# Plan — Structured logging configuration (issue #11)

Roadmap: `docs/roadmap.md` → Phase 1. Blocked by #5 (Fastify app factory)
and #10 (settings loader, `PCT_LOG_LEVEL`) — both merged to `main`.

## Goal

One opinionated pino setup configured once in `buildApp()`, establishing the
conventions every later log source follows (Phase 4 transport audit logs,
Phase 6 Ansible output capture, Phase 8b event broadcaster).

## Acceptance criteria → implementation

1. **Shared pino options; level from `PCT_LOG_LEVEL`; pretty only on demand.**
   - `src/web/logger.ts` → `buildLoggerOptions(settings, stream?)` returns the
     Fastify `logger` option: `{ level }` by default (JSON), `pino-pretty`
     transport only when `settings.logPretty` is set, an explicit `stream`
     (test seam) taking precedence.
   - Add `logPretty` (from `PCT_LOG_PRETTY`) to the settings schema in
     `config.ts` using `z.stringbool()` (env-var-safe boolean).
   - `pino-pretty` added as a **dev-only** dependency (ships nowhere near the
     runtime image; pino itself is already inside Fastify — no new runtime dep).
2. **Request-ID on every request-scoped line.**
   - Fastify constructed with `requestIdHeader: "x-request-id"` (honour inbound
     header) and `genReqId: genRequestId` (UUID fallback). `reqId` propagates
     to `request.log` automatically.
3. **Named child loggers for non-request sources.**
   - `componentLogger(app, component)` → `app.log.child({ component })`. The
     convention is documented in the module header; concrete sources arrive in
     later phases.
4. **ESLint `no-console` for `src/`.**
   - Scoped rule block in `eslint.config.js`.
5. **Unit test asserts request-ID propagation.**
   - `tests/web/logging.test.ts`: inject with/without `X-Request-Id`, capture
     the log stream, assert the `reqId` field; plus `componentLogger`,
     `buildLoggerOptions`, and `genRequestId` coverage.

## Wiring

- `buildApp(options?: { settings?, loggerStream? })` — defaults settings to
  `loadSettings()`. `main.ts` passes the already-parsed settings (no double
  parse). Existing route test passes a silent-level settings object so test
  output stays clean (assertions unchanged).

## License boundary

N/A — no transport/subprocess/REST/Docker changes. `pino-pretty` is an
MIT dev-only dependency.
