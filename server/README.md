# `dashboard` — parental-controls server

This subdirectory holds the dashboard server: a TypeScript (Node.js 22)
Fastify app that orchestrates Timekpr-nExT, ActivityWatch, e2guardian, and
(optionally) AdGuard Home over SSH, Ansible, and REST.

See the repository root [`README.md`](../README.md) for the project overview
and [`../CLAUDE.md`](../CLAUDE.md) for the architecture and license-boundary
rules contributors must follow when working in here.

## Layout

- `src/` — the package; modules match the split documented in
  `CLAUDE.md` ("Code conventions"): `web`, `api`, `policy`, `events`,
  `integrations`, and `transport/{ssh,ansible,activitywatch,adguard}`.
- `tests/` — Vitest tree mirroring the source layout. Unit tests are
  `*.test.ts`; integration tests are `*.int.test.ts` (see
  `docs/testing.md`).
- `frontend/` — SvelteKit project providing the `/admin` and `/app`
  surfaces (lands per roadmap; not yet scaffolded).
- `drizzle/` — generated drizzle-kit SQL migrations (lands in Phase 2).
- `package.json` — scripts + dependencies. Some dependencies are
  forward-declared for upcoming phases (see `docs/roadmap.md`); packages
  needing native builds (e.g. `argon2` for auth) land with the phase that
  first imports them.
- `.dockerignore` — tests, caches, and secrets are excluded from the
  build context; the runtime image gets compiled output only.

## Quick start

```bash
npm ci
npm test
```

Full quality gate:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```
