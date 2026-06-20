# ADR 0007 — Event-stream and API version-compatibility contract

- **Status:** Accepted (2026-06-19) — decision only; implementation lands with the event stream in Phase 8b.
- **Issue:** [#165](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/165)
- **Phase:** 8b (underpins the Phase 14 fleet-update epic, [#163](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/163))

## Context

The Phase-8b event stream (`docs/client-notifications.md`) gives the dashboard
a long-lived, **client-initiated** WebSocket to each enrolled client:
`pct-client-bridge` connects out to `/api/events/stream` and the server pushes
JSON frames (`grant.applied`, `policy.changed`, `enforce.force_close`,
`enforce.session_lock`, `lockout.cleared`). `docs/client-notifications.md`
explicitly defers the exact wire format ("fix it during implementation,
document it in a separate API reference once it stabilises").

The Phase-14 fleet-update story ([#163](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/163))
rests on one promise: **upgrade the server first, roll the clients
afterwards.** That is only safe if a freshly-upgraded server can keep talking
to clients that haven't updated yet — which requires the server and the bridge
to *agree on a protocol version at connect time* and for the server to degrade
gracefully (or refuse cleanly) when they don't match.

This has to be decided **before the WebSocket wire format is frozen**, not
after. An un-versioned client already in the field cannot be told how to behave
when the contract later changes — there is no field in its frames to negotiate
on, and no install base to retrofit. A version field costs one key in the
handshake now; bolting it on after clients are deployed is impossible. Hence
this ADR settles the contract now even though the stream itself is built later.

Two foundations already exist and this ADR builds on them rather than inventing
parallel machinery:

- **`GET /api/meta`** returns `apiVersion` — a positive integer, "bumped on
  breaking changes" (`server/src/api/meta.ts`). It is the JSON-contract version
  external integrators and frontends read.
- **Enrolment (#164)** already records `agent_version` / `component_versions` /
  `versions_reported_at` on the `Client` row (`docs/architecture.md` → "Policy
  model"), and `architecture.md` already anticipates a Phase-8b heartbeat
  (#165/#101) that refreshes `agent_version` + `versions_reported_at`.

## Decision

### 1. Two independent version axes, one shared discipline

The JSON API and the WebSocket frame envelope evolve independently, so they get
**two version numbers**, but governed by the **same rule**:

| Axis | Field | Governs | Bumped when |
|---|---|---|---|
| **API contract** | `apiVersion` (existing, in `/api/meta`) | `/api/*` request/response shapes | a **breaking** change to a JSON DTO |
| **Event protocol** | `eventProtocol` (new) | the WebSocket frame *envelope* + the handshake itself | a **breaking** change to the frame envelope or handshake |

Both are **positive integers**. **Additive changes never bump either number;
breaking changes do.** "Additive" = a new optional field, a new event *type*, a
new enum value a client can safely ignore. "Breaking" = renaming/removing a
field, changing a field's type or meaning, or changing the envelope/framing.
This is the discipline the issue asks for ("additive changes don't bump;
breaking changes do") and mirroring it across both axes is what lets clients and
integrators "read one consistent contract."

The event protocol is a **separate integer from `apiVersion`** (not a reuse)
because the two surfaces have different change cadences: a JSON DTO can break
without touching the frame envelope, and vice-versa. Conflating them would force
a version bump (and a compatibility-window event) on one surface every time the
other broke.

### 2. The handshake

The bridge speaks first, on every (re)connection — the handshake is cheap and
re-running it per connect avoids any sticky-state problem:

- **Client → server `hello`** carries:
  - `agentVersion` — the `pct-client` agent `.deb` version (the same value
    reported at enrolment, #164); the server uses it to refresh
    `agent_version` + `versions_reported_at` (the #165/#101 heartbeat).
  - `eventProtocol` — the integer frame-protocol version the client speaks.
  - `capabilities` — a string set of additive feature flags the client
    supports (see §4).
- **Server → client** replies with exactly one of:
  - **`accept`** — `{ eventProtocol: <agreed>, apiVersion, … }`, the agreed
    frame dialect (see §3). The stream proceeds.
  - **`refuse`** — a typed error frame `{ code: "incompatible_protocol", … }`
    using the standard `/api/*` error envelope vocabulary
    (`docs/architecture.md` → "API conventions"), after which the server closes
    the socket. The server records the client as `update_required` (§5).

A connection with a missing or unparseable `hello` is treated as incompatible
and refused — the server never assumes a dialect.

### 3. The N-1 compatibility window (keyed on the integer)

Let `P` be the server's current `eventProtocol`. **The server accepts a client
advertising `P` or `P − 1`, and refuses anything else:**

- `eventProtocol === P` → accept, full current dialect.
- `eventProtocol === P − 1` → accept, but the server emits the **N-1 dialect**:
  it withholds any frame *type* or envelope feature introduced by the breaking
  bump to `P`, sending only what a `P − 1` client can parse.
- `eventProtocol < P − 1` → **refuse** (client too old) and flag
  `update_required`.
- `eventProtocol > P` → **refuse** (server is behind the client — the
  "upgrade server first" rule was violated). The server cannot invent a future
  dialect; it refuses and the condition is surfaced to the admin so the *server*
  gets upgraded.

"N-1" is therefore a window of **two adjacent protocol majors**. This is the
documented support policy: **the fleet may lag the server by at most one
breaking event-protocol bump.** Phase 14's rollout cadence is bounded by this —
a server upgrade that bumps `eventProtocol` twice without the fleet moving in
between will strand clients, so the update orchestration (#170) must roll the
fleet within one window.

### 4. Additive evolution rides on capabilities, not on version bumps

Because additive changes do **not** bump `eventProtocol`, the mechanism for "the
server has a new event type that only newer clients understand" is the
`capabilities` set in the handshake, **not** the version window. The server only
sends a frame type a client advertised support for; an older client simply never
receives a frame it couldn't handle, and is not refused for it.

This is the seam the (merged) Windows-client design
(`docs/windows-client-support.md` → "Modularity tweaks") asked to be folded in
here: a client advertises *which enforcement primitives it supports*
(e.g. `session_budget`, `per_app_close`, `applocker_deny`, `dns_filter`), the
server withholds `enforce.*` frames a client can't honour, and the admin UI can
grey out unsupported controls per client. A Linux client and a future Windows
client speak the **same** `eventProtocol` and differ only in advertised
`capabilities`. Capability strings are themselves additive: adding one is not a
breaking change.

The `enforce.*` frames this gates are not hypothetical: the per-activity
enforcement *decision* logic already lives in `server/src/enforcement/` (#98,
documented in `CLAUDE.md`'s module split as deciding "on `events/` +
transport"). That module computes *when* a quota is exhausted; Phase 8b's event
stream is *how* the resulting `enforce.force_close` / `enforce.session_lock`
reaches the client — and this contract is what decides whether a given client
is sent that frame at all. The capability gate sits between the two.

The division of labour:

- **`eventProtocol` (the window)** guards the *envelope and framing* — the parts
  every client must agree on to parse anything at all. Breaking it is rare and
  deliberate.
- **`capabilities` (additive)** guards *which optional frames* a client opts
  into. This absorbs the steady churn of new event types and per-platform
  feature differences without ever consuming the compatibility window.

### 5. `update_required` semantics

A client refused for being too old (`eventProtocol < P − 1`) is recorded as
`update_required` in the client inventory and surfaced in the admin **Clients**
health view — which now exists (#81 has merged:
`server/src/api/clients/health-*.ts`, with per-component `status`,
`reachability` (live/offline), and transport-queue state). `update_required` is
a new signal *added to* that surface in Phase 8b, sitting alongside the version
inventory #164 already collects; it reuses the health view's existing
status-enum pattern rather than inventing a new admin surface. This is a **flag
and a signal**, not an action: the ADR deliberately stops at marking the
client. The actual remediation — pushing an agent update — is the Phase-14
update mechanism (#169/#170) and is explicitly out of scope here, matching the
issue's "Out of scope" note.

### 6. `/api/*` alignment

`apiVersion` stays a positive integer in `/api/meta` and keeps its existing
meaning (breaking-change major of the JSON contract). When the event stream is
built, **`/api/meta` also exposes `eventProtocol`** so a client, frontend, or
external integrator can read both axes from one place — the "one consistent
contract" the issue calls for. No change to `apiVersion`'s value or semantics is
made by this ADR.

### 7. Where the contract will live (forward-looking, not built here)

So that Phase-8b implementation has an unambiguous target, the intended shape:

- A **pure** version module — `server/src/events/protocol.ts` — holding the
  `EVENT_PROTOCOL` constant and a total `negotiate(clientHello) → accept |
  refuse` decision function, mirroring how `policy/budget-window.ts` and
  `policy/schedule-precedence.ts` isolate a pure decision the rest of the system
  routes through. The window logic is testable with zero I/O.
- The `hello` / `accept` / `refuse` frames as **zod schemas** in `server/src/api/`
  (or `events/`), inferred types shared with the bridge — the established DTO
  pattern (`CLAUDE.md` → "api/").
- The refusal uses the existing error-envelope vocabulary; no second error
  shape is introduced.

No code is written under this ADR. This section is guidance for the Phase-8b PR.

## Consequences

- **"Upgrade server first" becomes safe and bounded.** The window is the
  contract Phase 14 rolls against: the fleet may trail the server by one
  breaking protocol bump, no more. This is now a documented, enforceable number
  rather than an implicit hope.
- **Most evolution never touches the window.** New event types and per-platform
  features (including the entire Windows client) ride on `capabilities`, so the
  scarce N-1 window is spent only on genuine envelope breaks — which should be
  rare.
- **Clean failure, not silent corruption.** An out-of-window client is refused
  with a typed error and flagged, instead of being sent frames it would
  mis-parse. The admin sees *which* clients are stranded.
- **Two numbers to maintain.** The cost of independent axes is two version
  constants and the discipline to bump the right one. The shared "additive
  doesn't bump" rule keeps the mental model single.
- **Heartbeat for free.** Because `hello` carries `agentVersion` on every
  connect, the live inventory (`agent_version` + `versions_reported_at`) stays
  fresh without a separate heartbeat message — satisfying the #165/#101 refresh
  `architecture.md` anticipates.
- **Implementation deferred.** This ADR commits the *contract*; the module,
  schemas, handshake wiring, refusal path, `update_required` flag, and the
  `/api/meta` `eventProtocol` field are all Phase-8b work, built against this
  decision.

## Alternatives not chosen

- **A single version axis (reuse `apiVersion` for the stream too).** Rejected:
  the JSON API and the frame envelope break on different schedules; one number
  would force a spurious compatibility-window event on one surface every time
  the other broke, and would couple external integrators' contract to the
  client wire format they have no stake in.
- **semver `major.minor` with the window keyed on the *minor*.** The issue's
  phrasing ("current and previous minor") suggested this. Rejected for an
  integer-major window because (a) it matches `apiVersion`'s existing
  integer-major discipline, keeping "one consistent contract" literally
  consistent, and (b) the additive churn that a minor axis would track is
  better served by `capabilities`, which also handles per-platform feature
  differences a linear minor number cannot express. "Previous minor" in the
  issue is read here as "previous version", i.e. N-1 on the integer.
- **Per-event-type versioning** (each frame type carries its own version).
  Rejected as over-engineered: it multiplies the negotiation surface and the
  test matrix, while `capabilities` already covers "does this client understand
  frame type X?" additively. The envelope-level integer is the only thing that
  needs a hard compatibility window.
- **Best-effort send with no refusal** (always stream; let the client drop
  frames it can't parse). Rejected: it turns a version mismatch into silent,
  per-frame data loss with no admin-visible signal, and makes
  `enforce.*`/`lockout.cleared` semantics (where a dropped frame means missed
  enforcement or a child stuck locked out) unsafe. A clean refusal + a visible
  `update_required` flag is the safer failure mode.
- **Negotiating capabilities as a version range instead of a flag set.**
  Rejected: a flag set is order-independent, trivially additive, and maps
  directly onto the per-platform primitive differences (Linux vs Windows) the
  design already needs to express.
</content>
