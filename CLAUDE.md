# CLAUDE.md

Guidance for AI coding agents (Claude Code and others) working in this
repository. Read this before writing or changing code. The two documents in
`docs/` (`proposed-tech-stack.md` and `licensing-analysis.md`) are the
authoritative sources; this file summarises the rules that matter when
writing code.

---

## What this project is

A server/client toolkit that lets an admin set time and content limits on
specific Linux user accounts:

- **Server**: a custom web dashboard (TypeScript, Node.js, Fastify, SQLite)
  packaged as a Docker container. Orchestrates clients over SSH and via
  Ansible.
- **Client**: a supervised Linux desktop. Initial target is **Linux Mint
  with Cinnamon** (Ubuntu/Debian-family). Enforcement uses existing
  open-source tools — we do not reimplement screen-time or web-filtering
  logic.

The dashboard is the only fully custom component. Everything else is an
existing tool we configure and orchestrate.

> **Stack migration note (2026-06):** the project was originally designed
> around Python/FastAPI. It moved to TypeScript end-to-end before any
> feature code landed, so the maintainer can work in the language they
> know across backend and frontend. The architecture, license boundaries,
> module split, and roadmap are unchanged; only the implementation
> technology moved. If you find a stray Python-era reference in docs or
> issues, map it through the table in `docs/proposed-tech-stack.md`
> ("Stack decision — TypeScript end-to-end").

## Tech stack — what to use, what not to use

### Server side (this repo's primary code)

- **Language:** TypeScript (`strict: true`), Node.js 22 LTS. ESM modules.
- **Web framework:** Fastify 5. Do not introduce Express, Nest, or a
  second backend framework unless the design doc is updated.
- **Validation / DTOs:** zod. API request/response schemas are zod
  schemas in `server/src/api/`; both frontends and external integrators
  consume the types inferred from them.
- **Database:** SQLite for the policy store, via better-sqlite3 +
  Drizzle ORM. Migrations via drizzle-kit (generated SQL committed under
  `server/drizzle/`). Migrations are **timestamp-prefixed**
  (`migrations: { prefix: "timestamp" }` in `drizzle.config.ts`) so
  concurrent sessions don't collide on filenames — always generate with
  `npm run db:generate`, never hand-number a migration (#133).
- **Frontend:** Two surfaces, one SvelteKit project (`server/frontend/`,
  Svelte 5, `adapter-static`), served by the same Fastify process:
  - `/admin/*` — desktop admin experience (policy editors, live
    burndown charts, drag-to-reorder editors).
  - `/app/*` — the mobile-first PWA surface for the user/parent
    experience (per-child status, parents adjusting limits from a
    phone).
  - `/api/*` — JSON API; the single contract for both frontends **and
    for external integrations** (see "External integrations" below).
  The frontend is built at image-build time into static assets that
  Fastify serves. **One runtime: Node.js** — backend and frontend share
  the language, the toolchain, and the API types.
- **Process management:** `node:child_process` (`execFile` / `spawn`)
  for invoking external GPL tools (`timekpra`, `ansible-playbook`). No
  in-process linkage to GPL projects (see "License boundaries" below).
- **SSH:** the `ssh2` library for remote `timekpra` invocation and
  ActivityWatch port-forwarding.
- **Scheduling:** croner for in-process periodic jobs (telemetry pull,
  Ansible re-apply).
- **Packaging:** Single Docker image (`node:22-slim` base, multi-stage
  build). Persistent state lives in a mounted volume. The image must not
  contain GPL binaries; see
  [`docs/server-deployment.md`](docs/server-deployment.md).

### Client side

- **Session limits:** Timekpr-nExT (driven remotely via `timekpra` over SSH).
- **Activity tracking:** ActivityWatch (`aw-server`, `aw-watcher-window`,
  `aw-watcher-afk`, plus the browser extension).
- **Web filtering:** e2guardian with per-Linux-UID filter groups; iptables
  OUTPUT-chain redirect to its proxy port.
- **Client agent:** small TypeScript daemon installed by the client
  install script — system-level `pct-client-bridge` (event channel from
  the server) plus a per-supervised-user `pct-client-agent`
  (notifications, sound, time-remaining cadence, per-app force-close).
  Shipped as a `.deb` that bundles its own Node runtime so it does not
  depend on the distro's Node packages. The agent does not replace
  Timekpr-nExT's session enforcement; it adds notifications and a
  graceful end-of-budget experience around it. See
  [`docs/client-notifications.md`](docs/client-notifications.md).
- **DNS filtering (optional, server-side):** AdGuard Home in one of
  three modes — `disabled` (default), `managed` (dashboard fetches and
  supervises a sidecar), or `external` (dashboard talks to an existing
  AdGuard Home instance the homelab already runs). All three integrate
  only via AdGuard's REST API. See
  [`docs/server-deployment.md`](docs/server-deployment.md).
- **Configuration management:** Ansible (agentless, SSH). Invoked by the
  dashboard as a subprocess from a Python venv bootstrapped into the
  data volume at first run (the image ships a stock Python 3 interpreter
  for this purpose only — no dashboard code is Python).

### Tools that were considered and rejected

Do not reach for these without updating the design doc:
LittleBrother, UCS / UCC, SaltStack, Puppet, Chef, Pi-hole, FleetDM,
malcontent (Flatpak-only). On the server stack: Flask/Django/FastAPI
(superseded by the TypeScript migration), Express/Nest, Prisma (Drizzle
chosen for its plain-SQL migrations and lighter runtime).

## External integrations

The dashboard exposes an authenticated JSON API at `/api/*` that is the
single source of truth for both built-in frontends and for external
systems. The first planned external integrator is
[next-digital-wall-calendar](https://github.com/BenSeymourODB/next-digital-wall-calendar),
which will call the dashboard to **grant** screen-time rewards when
chores or calendar events are completed (e.g. "Alice finished her
chores → grant +30 minutes of overall time today" or "+45 minutes of
YouTube"). Design rules that apply now, even before this is built:

- All inbound external traffic goes through `/api/*`; never expose a
  separate side-channel.
- Per-integration API tokens (scoped, revocable, rate-limited).
- Grant requests are **idempotent** by an integration-supplied
  `source_ref` so a retried calendar webhook does not double-grant.
- Grants are recorded in an immutable ledger (`Grant` entity, see
  `docs/architecture.md`) so the admin can audit who gave what time and
  why, and revoke if needed.
- Grants are additive adjustments on top of the policy, not a
  replacement for it. The policy model stays the source of the
  baseline; grants are a separate layer.

## License boundaries — non-negotiable

The dashboard is **not** a derivative work of any GPL component. This is
true only as long as we keep process and network boundaries between the
dashboard and GPL code. Concrete rules:

1. **Never link GPL code into the dashboard process.** The GPL tools we
   orchestrate (Timekpr-nExT, Ansible) are Python; a Node process cannot
   import them in-process, and that structural separation is the point —
   do not undermine it with bindings, embedded interpreters, or vendored
   GPL source.
2. **Talk to `timekpra` as a subprocess.** Use `node:child_process`
   (`execFile` / `spawn`), locally or through `ssh2`'s `exec`. Pass
   arguments via the CLI; parse stdout. Do not parse Timekpr-nExT's
   on-disk state files using its own parsing code.
3. **Invoke Ansible as a subprocess** (`ansible-playbook ...` from the
   first-run venv in the data volume). Never embed or vendor it.
4. **Talk to ActivityWatch and AdGuard Home over their REST APIs only.**
   No source-level integration.
5. **Do not bundle GPL binaries inside the dashboard Docker image.**
   GPL components are kept out of the image: Ansible is installed into
   an isolated venv inside the data volume on first run; AdGuard Home
   is either fetched at first run (managed mode), pointed at an
   existing instance (external mode), or skipped entirely (disabled
   mode). Client-side GPL components (Timekpr-nExT, e2guardian) are
   installed by the client install script via `apt`.
6. **e2guardian** is configured by writing config files and signalling a
   reload. No code-level integration.

If any of these rules ever becomes inconvenient, **stop and update the
design docs first**; do not silently collapse the process boundary.

See [`docs/licensing-analysis.md`](docs/licensing-analysis.md) for the
full reasoning.

## Code conventions

- Format with **Prettier**, lint with **ESLint** (typescript-eslint).
  Both are wired into the pre-commit hook.
- TypeScript `strict: true` everywhere; `tsc --noEmit` must pass. No
  `any`, no unchecked `as` casts, no `@ts-ignore` (use `@ts-expect-error`
  with a reason comment in the rare case it's justified).
- Validate all external input (HTTP bodies, subprocess stdout, REST
  responses from AW/AdGuard) with zod schemas before it crosses into
  typed code.
- Keep modules small and per-responsibility. The dashboard's split
  (under `server/src/`):
  - `web/` — Fastify app: mounts `/api`, serves the built frontend
    at `/admin` and `/app`, hosts `/integrations`
  - `api/` — zod DTOs, JSON routes used by both frontends and by
    external integrations
  - `auth/` — single-admin authentication: Argon2id hashing, the signed
    session cookie, the `requireAdmin` guard, and first-admin bootstrap
    (wired into the `/api` scope; auth DTO types re-exported from `api/`)
  - `policy/` — Drizzle schema, policy model, DB access, grant ledger
  - `integrations/` — external-system inbound APIs (e.g. the
    family-calendar rewards endpoint; see `docs/architecture.md`)
  - `transport/ssh/` — SSH + `timekpra` invocation
  - `transport/ansible/` — playbook orchestration
  - `transport/activitywatch/` — telemetry pull
  - `transport/adguard/` — AdGuard Home REST client
  - `events/` — WebSocket server-to-client event stream
    (`grant.applied`, `policy.changed`, `enforce.force_close`, etc.;
    see `docs/client-notifications.md`)
- Tests live in `server/tests/` mirroring the source layout. Use
  **Vitest**. Unit tests are `*.test.ts`; integration tests (live
  services) are `*.int.test.ts` and excluded from the default run.
- Do not introduce a new dependency without a sentence in the PR
  description explaining why an existing one doesn't suffice.

The full quality gate, from `server/`:

```bash
npm ci
npm run format:check   # prettier
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest unit tests + coverage gate (80%)
```

## Repository layout (target)

```
.
├── CLAUDE.md                 # this file
├── README.md                 # human-facing overview
├── docs/                     # architecture, deployment, licensing, roadmap
├── server/                   # the Docker-packaged dashboard (TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/...               # web, api, policy, events, integrations, transport/*
│   ├── tests/
│   ├── frontend/             # SvelteKit project (admin + app surfaces)
│   ├── drizzle/              # generated SQL migrations
│   └── Dockerfile
├── client/                   # client-side install scripts and templates
│   ├── install-client.sh
│   ├── agent/                # pct-client bridge + agent (TypeScript)
│   └── ansible/              # playbooks invoked by the server
└── scripts/                  # dev utilities (lint, build, etc.)
```

This layout is the target; commit it in pieces as features land rather
than scaffolding everything up front.

## Working on this repo

- Develop on the session's designated `claude/*` feature branch. Do not
  push elsewhere without explicit approval.
- All non-trivial work should be tracked by an issue on the
  [roadmap project](https://github.com/users/BenSeymourODB/projects/2).
- Keep PRs small and focused on one milestone item at a time.

## Tamper resistance is deliberately bounded

The client-side hardening described in
[`docs/client-install.md`](docs/client-install.md) ("Tamper resistance
posture") is the **ceiling**, not the starting point. Do not propose
or implement:

- Anti-tamper hooks, kernel modules, eBPF probes, or other low-level
  enforcement techniques.
- Obfuscation of agent binaries or configuration.
- Lockdown of `/etc`, `/usr`, or boot media against root access.
- Any feature whose purpose is "make it harder for the supervised
  user to circumvent the system."

The design assumes a household context: parent admin, child user.
If the supervised user has reached the level of skill required to
defeat the documented protections, they have **outgrown the product**
and the right response is a parent-child conversation, not an arms
race in software. A bug report that boils down to "my advanced
teenager found a workaround" is not a defect to chase; it's a
signal that the product is no longer the right fit for that user.

If a task seems to call for hardening beyond what's already
documented, push back on the request rather than implementing it.

## When in doubt

- Re-read [`docs/proposed-tech-stack.md`](docs/proposed-tech-stack.md) and
  [`docs/licensing-analysis.md`](docs/licensing-analysis.md).
- If the task seems to require violating a license-boundary rule, stop and
  ask in the issue thread before writing code.
- Prefer using an existing upstream tool over writing new enforcement
  logic. The dashboard's job is orchestration, not enforcement.
