# Testing Strategy

This document describes how the project is tested — the philosophy,
the directory layout, the mock patterns, and the concrete coverage targets
per module. For *when* tests run (CI triggers, service containers, etc.)
see [`docs/ci-cd.md`](ci-cd.md).

---

## Philosophy

Testing in this project has two tiers:

**Tier 1 — Unit / contract tests** (fast, no live services)
- Test every module in isolation by mocking at the subprocess/REST boundary.
- Assert that we send the *right protocol* to each downstream tool.
- Run on every push via `ci.yml`.

**Tier 2 — Integration tests** (slower, Docker service containers)
- Spin up the real upstream tool (ActivityWatch, AdGuard Home, OpenSSH) and
  exercise the actual network or process boundary.
- Named `*.int.test.ts`; excluded from the unit-test run.
- Run on PRs to `main` and nightly via `integration.yml`.

The split is intentional. Integration tests give confidence that the
upstream tool's real API matches our assumptions; unit tests give fast
feedback during feature development. Neither replaces the other.

---

## Test directory layout

```
server/
└── tests/
    ├── helpers/                 # shared fixtures (test DB, subprocess mock, etc.)
    ├── stubs/
    │   └── timekpra             # stub CLI recorded by SSH integration tests
    ├── policy/
    │   ├── budget.test.ts
    │   ├── grant-ledger.test.ts
    │   ├── migrations.test.ts
    │   └── schedule.test.ts
    ├── api/
    │   ├── auth.test.ts
    │   ├── grants.test.ts
    │   ├── policy-endpoints.test.ts
    │   └── rate-limiting.test.ts
    ├── transport/
    │   ├── ssh/
    │   │   ├── timekpra-invocation.test.ts   # unit
    │   │   ├── offline-queue.test.ts          # unit
    │   │   └── ssh.int.test.ts                # integration
    │   ├── ansible/
    │   │   ├── playbook-generation.test.ts   # unit
    │   │   └── ansible.int.test.ts            # integration (Molecule)
    │   ├── activitywatch/
    │   │   ├── normalisation.test.ts          # unit
    │   │   └── activitywatch.int.test.ts      # integration
    │   └── adguard/
    │       ├── client.test.ts                 # unit
    │       └── adguard.int.test.ts            # integration
    ├── events/
    │   ├── broadcaster.test.ts
    │   └── event-schemas.test.ts
    ├── web/
    │   └── admin-routes.test.ts
    └── integrations/
        ├── token-scoping.test.ts
        └── idempotency.test.ts
```

---

## Vitest configuration

Two run configurations, selected by filename convention:

- `npm test` — unit tests only: runs `tests/**/*.test.ts`, **excluding**
  `*.int.test.ts`. Includes coverage (`@vitest/coverage-v8`) with the
  80 % gate.
- `npm run test:integration` — integration tests only: runs
  `tests/**/*.int.test.ts`. Requires the Docker services described in
  "Integration tests — local reproduction" below.

`server/vitest.config.ts` (relevant section):

```ts
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.int.test.ts", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
```

The filename convention replaces pytest's `@pytest.mark.integration`
marker: a test that needs a live service goes in an `*.int.test.ts`
file, full stop. There is no per-test marker to typo.

---

## Mock patterns by layer

### Transport — subprocess (SSH + Ansible)

Never invoke `timekpra` or `ansible-playbook` in unit tests. Mock
`node:child_process` at the module level so the transport code under
test cannot tell the difference:

```ts
import { describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

it("sets the daily limit with the right timekpra arguments", async () => {
  execFile.mockImplementation((_cmd, _args, _opts, cb) =>
    cb(null, "OK\n", ""),
  );

  await sshTransport.setDailyLimit({ user: "alice", seconds: 7200 });

  expect(execFile).toHaveBeenCalledWith(
    "timekpra",
    ["--settimelimitforday", "alice", "7200"],
    expect.anything(),
    expect.any(Function),
  );
});
```

Key assertions to make for every timekpra call:
- Correct subcommand and argument order
- Correct user name passed (never a different user due to a scoping bug)
- Non-zero exit code rejects with a typed error (not a silent pass)
- Malformed stdout rejects with a typed error (not a silent pass)

### Transport — REST (ActivityWatch, AdGuard Home)

The REST clients use the global `fetch` (undici). Use undici's
`MockAgent` to intercept outbound HTTP without a live server:

```ts
import { MockAgent, setGlobalDispatcher } from "undici";

it("pushes a blocklist", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  agent
    .get("http://adguard.local")
    .intercept({ path: "/control/filtering/set_rules", method: "PUT" })
    .reply(200);

  await adguardClient.pushBlocklist({ rules: ["||ads.example.com^"] });

  agent.assertNoPendingInterceptors();
});
```

Test the following error cases for every REST client:
- 401 Unauthorized — rejects with `AuthError`
- 409 Conflict — handled idempotently (no exception)
- Connection refused / timeout — rejects with `TransportError` carrying
  retry context

### Policy model

Use an in-memory SQLite database via the shared `testDb()` helper
(`tests/helpers/db.ts`). better-sqlite3 supports `:memory:` natively, and the
Drizzle migrations run against it in milliseconds:

```ts
import { testDb } from "../helpers/db.js";

const db = testDb(); // fresh :memory: database with all migrations applied
```

The helper resolves the committed migrations folder relative to itself (not
the process cwd), so it works regardless of where the runner is invoked from.
The underlying handle is reachable via `db.$client` (e.g. `db.$client.close()`).
This keeps policy tests hermetic and fast — no file I/O, no leftover state.

### HTTP routes

Use Fastify's built-in injection — no sockets, no port binding. The
`buildTestApp()` helper (`tests/helpers/app.ts`) builds the app with a silent
logger and bundles a `testDb()`:

```ts
import { buildTestApp } from "../helpers/app.js";

it("grant endpoint is idempotent by source_ref", async () => {
  const { app, db, close } = buildTestApp();
  const payload = { user: "alice", seconds: 1800, source_ref: "chore-abc-001" };

  const r1 = await app.inject({ method: "POST", url: "/api/grants", headers: authHeaders, payload });
  const r2 = await app.inject({ method: "POST", url: "/api/grants", headers: authHeaders, payload });

  expect(r1.statusCode).toBe(201);
  expect(r2.statusCode).toBe(200); // idempotent: same grant, not a new one
  expect(r1.json().id).toBe(r2.json().id);

  await close(); // closes the app and the in-memory db
});
```

`buildApp()` takes an optional `db` (#49): when omitted it opens and migrates
one from `settings` via `createDb()` and closes it on `app.close()`; when
injected (as `buildTestApp()` does with `testDb()`) the app uses that handle
and leaves closing it to the provider. So `app.db`, the `db` returned by
`buildTestApp()`, and the handle you passed in are all the same object, and
`close()` tears down the app and then the database.

---

## Coverage targets by module

| Module | Target | Notes |
|---|---|---|
| `src/policy` | 90 % | Core business logic; highest priority |
| `src/api` | 85 % | All routes and auth paths |
| `src/transport/*` | 80 % | Unit tests only; integration tests supplement |
| `src/events` | 80 % | WebSocket broadcaster and schema validation |
| `src/integrations` | 85 % | Idempotency is critical |
| `src/web` | 70 % | Route wiring; UI tested manually |
| Overall | 80 % | Enforced in CI via the Vitest coverage thresholds |

---

## Policy module — what to test

### `tests/policy/grant-ledger.test.ts`

- Second `createGrant` with the same `source_ref` returns the existing
  `Grant` row, not a new one (idempotency invariant).
- Revoking a grant marks it revoked but does not delete the row
  (immutability invariant).
- `budgetRemaining` = base policy seconds + sum of unrevoked grant seconds.
- A revoked grant is excluded from `budgetRemaining`.
- `budgetRemaining` never goes below zero (floor invariant).

### `tests/policy/schedule.test.ts`

- A schedule with no exceptions evaluates correctly at boundaries
  (midnight, day-change).
- An exception overrides the base schedule for its date range only.
- Overlapping exceptions: the narrower range wins (or document which wins
  and test that specific behaviour).
- Clock-skew tolerance: a sample timestamped ≤60 s in the future is
  accepted; >60 s is rejected.

### `tests/policy/migrations.test.ts`

- Applying all drizzle-kit migrations to an empty DB succeeds.
- Re-applying on an already-migrated DB is a no-op (drizzle's journal
  guarantees this, but the test documents the expectation).
- The migrated schema matches the Drizzle schema definition
  (`drizzle-kit check` is also run in CI to catch drift).

### `tests/policy/migration-naming.test.ts`

Migrations are **timestamp-prefixed** (`<YYYYMMDDHHmmss>_<slug>`), not
sequentially numbered — `drizzle.config.ts` sets `migrations: { prefix:
"timestamp" }` so two sessions branching off the same `main` don't generate
colliding filenames (issue #133). Always generate with `npm run db:generate`
so the prefix is applied; never hand-name a migration.

- Every migration tag in `drizzle/meta/_journal.json` matches *either* the
  legacy index prefix (`^[0-9]{4}_…`, grandfathered) or the timestamp
  convention `^[0-9]{14}_[a-z0-9_]+$`; a hand-named or malformed tag fails.
- No two timestamp migrations share the same second.
- Each journal tag has its `<tag>.sql` and `<prefix>_snapshot.json`, with no
  stray SQL files.

This runs in the unit-test job. Legacy index migrations are accepted
structurally (not via a hardcoded list) — the `prefix: "timestamp"` config is
what prevents *new* index migrations, so the guard backstops timestamp
well-formedness and same-second collisions. The `drizzle-kit check` drift gate
above remains the backstop for *semantic* conflicts between two independent
schema edits.

---

## API module — what to test

### `tests/api/auth.test.ts`

- Request with no `Authorization` header → 401.
- Request with an expired token → 401.
- Request with a revoked token → 401.
- Request with a token scoped to `grants:write` hitting a `policy:write`
  endpoint → 403 (wrong scope, not a missing token).

### `tests/api/rate-limiting.test.ts`

- N+1 requests within the rate-limit window from the same integration token
  → 429 on the N+1th request.
- Requests from two different tokens do not share a rate-limit bucket.

### `tests/api/grants.test.ts`

- POST with valid payload and token → 201 with `Grant` schema.
- POST same `source_ref` again → 200 with same `Grant` (idempotency).
- POST with missing `source_ref` → 400 from zod validation.
- POST that would push `budgetRemaining` negative → behaviour is documented
  (either capped at zero or rejected — pick one and test it).

---

## Transport module — what to test

### `tests/transport/ssh/timekpra-invocation.test.ts`

For each public method of the SSH transport (e.g. `setDailyLimit`,
`getTimeUsed`, `killSession`):

- The correct `timekpra` subcommand is called.
- Arguments are passed in the order `timekpra` expects (the CLI is
  positional, so order matters).
- The user identifier is always the one passed to the method (no
  scoping-leak bugs).
- stdout is parsed correctly for the happy path.
- A non-zero exit code rejects with `TimekpraError`.
- Unparseable stdout rejects with `TimekpraParseError`.

### `tests/transport/activitywatch/normalisation.test.ts`

- A raw `aw-server` window-event response is normalised to a `UsageSample`
  with the correct `durationSeconds` and `appName`.
- Overlapping events (a client-clock-skew artifact) are deduplicated.
- An event with a future timestamp beyond the tolerance window is dropped,
  not summed into the total.
- An empty bucket response produces an empty list, not an exception.
- The raw response is validated with a zod schema before use; a response
  that doesn't match the expected shape rejects with a typed error.

### `tests/transport/adguard/client.test.ts`

- `disabled` mode: all public methods are no-ops that return immediately.
- `external` mode: methods make REST calls to the configured URL.
- `managed` mode: `start()` spawns the AdGuard Home subprocess; `stop()`
  terminates it; REST calls go to `localhost`.
- All three modes implement the same TypeScript interface.

---

## Events module — what to test

### `tests/events/broadcaster.test.ts`

- A `grant.applied` event delivered to the broadcaster is received by all
  connected WebSocket clients.
- A slow consumer does not block the broadcaster from delivering to other
  consumers.
- A disconnected client is removed from the subscriber list without an
  unhandled rejection.

### `tests/events/event-schemas.test.ts`

- Each event type (`grant.applied`, `policy.changed`, `enforce.force_close`,
  `enforce.session_lock`, `lockout.cleared`) serialises to valid JSON and
  parses back through its zod schema without data loss.

---

## Integration tests — local reproduction

Each integration job can be reproduced locally. The AdGuard Home and SSH
targets run as Docker containers; ActivityWatch does **not** (the project
publishes no official image — see issue #20), so its server is started
natively from the pinned upstream release by `scripts/start-aw-server.sh`,
exactly as the CI job does.

Save the snippet below as `docker-compose.integration.yml` in the repo root
(do not commit it; it is a local dev aid only):

The SSH transport authenticates with a key only (never a password), so generate
a throwaway key pair first and hand the public half to the container:

```bash
mkdir -p .int-ssh-key
ssh-keygen -t ed25519 -N '' -f .int-ssh-key/id_ed25519   # once; .int-ssh-key/ is a local aid
```

```yaml
# docker-compose.integration.yml — local integration test environment
services:
  adguardhome:
    image: adguard/adguardhome:latest
    ports: ["3000:3000", "53:53/udp"]

  ssh-target:
    image: lscr.io/linuxserver/openssh-server:latest
    environment:
      - PUID=1000
      - PGID=1000
      - USER_NAME=pctagent
      - PUBLIC_KEY_FILE=/pubkey/id_ed25519.pub
    ports: ["2222:22"]
    volumes:
      - ./server/tests/stubs:/usr/local/bin:ro
      - ./.int-ssh-key:/pubkey:ro
```

Start the services:

```bash
# Containerised targets (AdGuard Home + SSH):
docker compose -f docker-compose.integration.yml up -d

# ActivityWatch aw-server (native, downloaded + checksum-verified):
scripts/start-aw-server.sh
```

Run the integration tests:

```bash
cd server
AW_SERVER_URL=http://localhost:5600 \
ADGUARD_URL=http://localhost:3000 \
SSH_TARGET_HOST=localhost SSH_TARGET_PORT=2222 \
SSH_TARGET_USER=pctagent SSH_TARGET_KEY_FILE="$PWD/../.int-ssh-key/id_ed25519" \
  npm run test:integration
```

The SSH suites are env-gated: with `SSH_TARGET_HOST` / `SSH_TARGET_KEY_FILE`
unset they `describe.skipIf` themselves out, so the unit run (`npm test`, which
never collects `*.int.test.ts`) is unaffected.

---

## Ansible playbooks — Molecule

Playbook integration tests use [Molecule](https://ansible.readthedocs.io/projects/molecule/)
with the Docker driver. (Molecule is part of the Ansible ecosystem and is
installed with `pip` into a throwaway environment — it never enters the
dashboard's dependency tree.) The scenario lives at
`client/ansible/molecule/default/`. Running it locally:

```bash
pip install molecule molecule-plugins[docker]
cd client/ansible
molecule test
```

This spins up a Debian/Ubuntu container, applies the playbooks, and
verifies the resulting state (config files present, services enabled,
iptables rules applied). It is the authoritative test that the Ansible
side of the client install actually works end-to-end.

---

## The stub `timekpra` binary

`server/tests/stubs/timekpra` is a shell script used by the SSH integration
tests. It records every invocation (arguments + timestamp) to
`/tmp/timekpra-invocations.log` and exits 0. Integration tests SSH into the
container, run a transport method, then read the log file back over SSH to
assert the correct arguments were passed.

The stub does not simulate Timekpr-nExT's actual behaviour. Its only job is
to prove that the dashboard sent the right arguments over SSH.
