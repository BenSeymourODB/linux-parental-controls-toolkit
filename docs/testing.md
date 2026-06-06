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
- Marked `@pytest.mark.integration`; excluded from the unit-test job.
- Run on PRs to `main` and nightly via `integration.yml`.

The split is intentional. Integration tests give confidence that the
upstream tool's real API matches our assumptions; unit tests give fast
feedback during feature development. Neither replaces the other.

---

## Test directory layout

```
server/
└── tests/
    ├── conftest.py              # shared fixtures (test DB, mock subprocess, etc.)
    ├── stubs/
    │   └── timekpra             # stub CLI recorded by SSH integration tests
    ├── policy/
    │   ├── test_budget.py
    │   ├── test_grant_ledger.py
    │   ├── test_migrations.py
    │   └── test_schedule.py
    ├── api/
    │   ├── test_auth.py
    │   ├── test_grants.py
    │   ├── test_policy_endpoints.py
    │   └── test_rate_limiting.py
    ├── transport/
    │   ├── ssh/
    │   │   ├── test_timekpra_invocation.py   # unit
    │   │   ├── test_offline_queue.py          # unit
    │   │   └── test_integration.py            # @pytest.mark.integration
    │   ├── ansible/
    │   │   ├── test_playbook_generation.py   # unit
    │   │   └── test_integration.py            # @pytest.mark.integration (Molecule)
    │   ├── activitywatch/
    │   │   ├── test_normalisation.py          # unit
    │   │   └── test_integration.py            # @pytest.mark.integration
    │   └── adguard/
    │       ├── test_client.py                 # unit
    │       └── test_integration.py            # @pytest.mark.integration
    ├── events/
    │   ├── test_broadcaster.py
    │   └── test_event_schemas.py
    ├── web/
    │   └── test_admin_routes.py
    └── integrations/
        ├── test_token_scoping.py
        └── test_idempotency.py
```

---

## pytest configuration

`server/pyproject.toml` (relevant section):

```toml
[tool.pytest.ini_options]
addopts = "--strict-markers -q"
markers = [
    "integration: requires live external services (deselect with -m 'not integration')",
]
testpaths = ["tests"]
```

`--strict-markers` means any test decorated with an unregistered marker fails
immediately — a useful safeguard against typos like `@pytest.mark.integation`.

---

## Mock patterns by layer

### Transport — subprocess (SSH + Ansible)

Never invoke `timekpra` or `ansible-playbook` in unit tests. Patch at the
`asyncio` level so the transport code under test cannot tell the difference:

```python
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock

@patch("asyncio.create_subprocess_exec")
async def test_set_daily_limit(mock_exec):
    proc = MagicMock()
    proc.communicate = AsyncMock(return_value=(b"OK\n", b""))
    proc.returncode = 0
    mock_exec.return_value = proc

    await ssh_transport.set_daily_limit(user="alice", seconds=7200)

    mock_exec.assert_called_once_with(
        "timekpra",
        "--settimelimitforday", "alice", "7200",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
```

Key assertions to make for every timekpra call:
- Correct subcommand and argument order
- Correct user name passed (never a different user due to a scoping bug)
- Non-zero returncode raises a typed exception (not a silent pass)
- Malformed stdout raises a typed exception (not a silent pass)

### Transport — REST (ActivityWatch, AdGuard Home)

Use `respx` (mock transport for `httpx`) to intercept outbound HTTP without
a live server:

```python
import respx
import httpx

@respx.mock
async def test_push_blocklist():
    respx.put("http://adguard.local/control/filtering/set_rules").mock(
        return_value=httpx.Response(200)
    )
    await adguard_client.push_blocklist(rules=["||ads.example.com^"])
    assert respx.calls.call_count == 1
```

Test the following error cases for every REST client:
- 401 Unauthorized — raises `AuthError`
- 409 Conflict — handled idempotently (no exception)
- Connection refused / timeout — raises `TransportError` with retry context

### Policy model

Use a SQLite in-memory database (`:memory:`) via a pytest fixture:

```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from dashboard.policy.models import Base

@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
```

This keeps policy tests hermetic and fast — no file I/O, no leftover state.

### FastAPI routes

Use FastAPI's built-in `TestClient`:

```python
from fastapi.testclient import TestClient
from dashboard.web.app import app

client = TestClient(app)

def test_grant_endpoint_idempotent():
    payload = {"user": "alice", "seconds": 1800, "source_ref": "chore-abc-001"}
    r1 = client.post("/api/grants", json=payload, headers=auth_headers)
    r2 = client.post("/api/grants", json=payload, headers=auth_headers)
    assert r1.status_code == 201
    assert r2.status_code == 200       # idempotent: same grant, not a new one
    assert r1.json()["id"] == r2.json()["id"]
```

---

## Coverage targets by module

| Module | Target | Notes |
|---|---|---|
| `dashboard.policy` | 90 % | Core business logic; highest priority |
| `dashboard.api` | 85 % | All routes and auth paths |
| `dashboard.transport.*` | 80 % | Unit tests only; integration tests supplement |
| `dashboard.events` | 80 % | WebSocket broadcaster and schema validation |
| `dashboard.integrations` | 85 % | Idempotency is critical |
| `dashboard.web` | 70 % | Route rendering; UI tested manually |
| Overall | 80 % | Enforced in CI via `--cov-fail-under=80` |

---

## Policy module — what to test

### `tests/policy/test_grant_ledger.py`

- Second `create_grant` with the same `source_ref` returns the existing
  `Grant` row, not a new one (idempotency invariant).
- Revoking a grant marks it revoked but does not delete the row
  (immutability invariant).
- `budget_remaining` = base policy seconds + sum of unrevoked grant seconds.
- A revoked grant is excluded from `budget_remaining`.
- `budget_remaining` never goes below zero (floor invariant).

### `tests/policy/test_schedule.py`

- A schedule with no exceptions evaluates correctly at boundaries
  (midnight, day-change).
- An exception overrides the base schedule for its date range only.
- Overlapping exceptions: the narrower range wins (or document which wins
  and test that specific behaviour).
- Clock-skew tolerance: a sample timestamped ≤60 s in the future is
  accepted; >60 s is rejected.

### `tests/policy/test_migrations.py`

- `alembic upgrade head` on an empty DB succeeds.
- `alembic downgrade base` after `upgrade head` succeeds.
- Re-running `upgrade head` on an already-migrated DB is a no-op (alembic
  already guarantees this, but the test documents the expectation).

---

## API module — what to test

### `tests/api/test_auth.py`

- Request with no `Authorization` header → 401.
- Request with an expired token → 401.
- Request with a revoked token → 401.
- Request with a token scoped to `grants:write` hitting a `policy:write`
  endpoint → 403 (wrong scope, not a missing token).

### `tests/api/test_rate_limiting.py`

- N+1 requests within the rate-limit window from the same integration token
  → 429 on the N+1th request.
- Requests from two different tokens do not share a rate-limit bucket.

### `tests/api/test_grants.py`

- POST with valid payload and token → 201 with `Grant` schema.
- POST same `source_ref` again → 200 with same `Grant` (idempotency).
- POST with missing `source_ref` → 422.
- POST that would push `budget_remaining` negative → behaviour is documented
  (either capped at zero or rejected — pick one and test it).

---

## Transport module — what to test

### `tests/transport/ssh/test_timekpra_invocation.py`

For each public method of the SSH transport (e.g. `set_daily_limit`,
`get_time_used`, `kill_session`):

- The correct `timekpra` subcommand is called.
- Arguments are passed in the order `timekpra` expects (the CLI is
  positional, so order matters).
- The user identifier is always the one passed to the method (no
  scoping-leak bugs).
- stdout is parsed correctly for the happy path.
- A non-zero exit code raises `TimekpraError`.
- Unparseable stdout raises `TimekpraParseError`.

### `tests/transport/activitywatch/test_normalisation.py`

- A raw `aw-server` window-event response is normalised to a `UsageSample`
  with the correct `duration_seconds` and `app_name`.
- Overlapping events (a client-clock-skew artifact) are deduplicated.
- An event with a future timestamp beyond the tolerance window is dropped,
  not summed into the total.
- An empty bucket response produces an empty list, not an exception.

### `tests/transport/adguard/test_client.py`

- `disabled` mode: all public methods are no-ops that return immediately.
- `external` mode: methods make REST calls to the configured URL.
- `managed` mode: `start()` spawns the AdGuard Home subprocess; `stop()`
  terminates it; REST calls go to `localhost`.
- All three modes implement the same interface (duck-type compatible).

---

## Events module — what to test

### `tests/events/test_broadcaster.py`

- A `grant.applied` event delivered to the broadcaster is received by all
  connected WebSocket clients.
- A slow consumer (simulated with `asyncio.sleep`) does not block the
  broadcaster from delivering to other consumers.
- A disconnected client is removed from the subscriber list without an
  unhandled exception.

### `tests/events/test_event_schemas.py`

- Each event type (`grant.applied`, `policy.changed`, `enforce.force_close`,
  `enforce.session_lock`, `lockout.cleared`) serialises to valid JSON and
  deserialises back to the correct schema without data loss.

---

## Integration tests — local reproduction

Each integration job can be reproduced locally with Docker Compose. Save the
snippet below as `docker-compose.integration.yml` in the repo root (do not
commit it; it is a local dev aid only):

```yaml
# docker-compose.integration.yml — local integration test environment
services:
  activitywatch:
    image: activitywatch/aw-server:latest
    ports: ["5600:5600"]

  adguardhome:
    image: adguard/adguardhome:latest
    ports: ["3000:3000", "53:53/udp"]

  ssh-target:
    image: lscr.io/linuxserver/openssh-server:latest
    ports: ["2222:22"]
    volumes:
      - ./server/tests/stubs:/usr/local/bin:ro
```

Start the services:

```bash
docker compose -f docker-compose.integration.yml up -d
```

Run the integration tests:

```bash
cd server
AW_SERVER_URL=http://localhost:5600 \
ADGUARD_URL=http://localhost:3000 \
SSH_TARGET_HOST=localhost SSH_TARGET_PORT=2222 \
  pytest tests/ -m integration -v
```

---

## Ansible playbooks — Molecule

Playbook integration tests use [Molecule](https://ansible.readthedocs.io/projects/molecule/)
with the Docker driver. The scenario lives at
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
