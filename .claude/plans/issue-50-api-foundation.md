# Issue #50 — API foundation: zod DTOs, shared error envelope, validation plumbing

Phase 2 (`docs/roadmap.md`). Establish the `/api/*` conventions **once**,
before policy routes (#51), auth (#52), and the admin UI (#53) land, so both
built-in frontends and external integrators share one stable contract.

No live DB required — this is the contract layer.

## Decisions

- **Error envelope:** the small `{ error: { code, message, details } }` shape
  (one of the two the issue offered), not RFC 9457 `problem+json`. Simpler to
  type with zod, trivial for the SvelteKit frontend to narrow on, and the
  `details` array surfaces structured zod issues instead of a stack trace.
- **Validation hook:** a Fastify-native **custom validator compiler** that runs
  `schema.safeParse(data)` for any route part (`body`/`querystring`/`params`/
  `headers`) given a zod schema. On failure it returns an `ApiValidationError`
  carrying the `ZodError` so the error handler can render `details`.
- **Type inference, zero new deps:** a ~6-line custom `ZodTypeProvider`
  (`FastifyTypeProvider`) so handlers infer `request.body`/`request.query` from
  the zod schema — no `as` casts, no hand-written interfaces, and no
  `fastify-type-provider-zod` dependency (an existing primitive, `zod` +
  Fastify's own type-provider hook, already covers it).
- **Encapsulation:** the envelope/validation/not-found conventions are installed
  inside the encapsulated `/api` plugin only, so `/`, `/healthz`, `/admin`,
  `/app` behaviour is untouched.
- **DTO export path:** `server/src/api/` (re-exported from `api/index.ts`), per
  `CLAUDE.md`. Documented in `docs/architecture.md` → API conventions.

## Files

- `server/src/api/errors.ts` — `ApiError`, `ApiValidationError`,
  `errorEnvelopeSchema` + `ErrorEnvelope`/`ErrorDetail` types, `zodIssuesToDetails`.
- `server/src/api/validation.ts` — `ZodTypeProvider`, `zodValidatorCompiler`,
  `apiErrorHandler`, `apiNotFoundHandler`, `installApiConventions(scope)`.
- `server/src/api/meta.ts` — `metaResponseSchema` + `MetaResponse`, the
  `GET /api/meta` route (proves the wiring).
- `server/src/api/plugin.ts` — `apiPlugin` + `registerApi(app)`.
- `server/src/api/index.ts` — keeps `moduleName = "api"` (package-layout test),
  re-exports the public types + `registerApi`.
- `server/src/web/app.ts` — call `registerApi(app)`.
- `docs/architecture.md` — short "API conventions" subsection (export path,
  envelope shape, validation).

## Tests (`server/tests/api/`)

- `errors.test.ts` — envelope schema round-trips; `zodIssuesToDetails`;
  `ApiError`/`ApiValidationError` fields.
- `validation.test.ts` — the validator compiler returns `{value}`/`{error}`;
  the `ZodTypeProvider` inference (type-level, compile check).
- `plugin.test.ts` — a real Fastify app via `installApiConventions` + probe
  routes exercises: valid body passes & infers; malformed body → 400 envelope
  with `details` (not a stack trace); malformed JSON → 400 envelope; thrown
  `ApiError` → mapped status + envelope; unexpected throw → 500 generic
  envelope (no leak); unknown `/api/*` → 404 envelope. Plus `GET /api/meta`
  via `buildApp().inject()`.

## Phases

1. Primitives (`errors.ts`, `validation.ts`) + unit tests. Push → draft PR.
2. `/api` plugin + meta route + wire into `buildApp` + docs + integration
   tests. Push → mark ready.

## Out of scope / deferred

- Policy CRUD routes (#51), auth (#52), admin UI (#53).
- Static-wildcard vs `/api` 404 precedence when the frontend build is mounted
  is #59's domain (SPA fallback); the `/api` not-found envelope is active in
  every config where no static `GET /*` is mounted (dev/CI/tests + until a
  build is present).
