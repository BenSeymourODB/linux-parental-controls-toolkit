# Issue #281 (slice) — Save-and-push preview: opt-in live-reachability probe

Roadmap: `docs/roadmap.md` → Phase 4 (SSH + `timekpra` transport).

## Context

#281 is the umbrella for the save-and-push preview follow-ups to #64. Two of
its bullets already landed:

- **#282 / #64** — the pure diff engine + the side-effect-free
  `POST /api/users/:userId/policy-preview` endpoint (change set + affected
  clients annotated with `lastSeen` + pending-queue depth).
- **#299** — the `/admin` rendering (`PolicyPreviewView`).

This slice ships the **live-reachability probe** bullet: an **opt-in**
online/offline marker on the preview, reusing the Phase-4 `ClientProber` seam
and the #198 bounded-concurrency + per-list-deadline fan-out. The default
preview stays cheap and side-effect-free — the probe only runs when the admin
explicitly asks ("Check live status").

Remaining #281 bullets are gated elsewhere and stay tracked on the umbrella:
future-dated preview (`?date=`, gated on #142/#141) and the Ansible-side filter
diff (Phase 6 / #90). The combined-editor + "Save & push" action is #304.

## Design

- **Opt-in, default off.** `policyPreviewRequestSchema` gains
  `probe: z.boolean().optional()` (optional, *not* `.default(false)`, so the
  inferred request type keeps `probe?: boolean` and existing callers/tests that
  omit it still typecheck). The route treats `probe === true` as the only
  trigger.
- **Reuse, don't re-invent.** When `probe` is set *and* the live prober is
  wired (it is injected exactly like `/api/clients/health`, absent pre-#39),
  each affected client is probed via `prober.probe(client)` through
  `mapWithConcurrency` + `timerDeadline`, bounded by
  `settings.clientHealth.probeConcurrency` / `probeDeadlineMs` — the same #198
  bounds the health page uses, so a wedged host can't stall the preview.
- **Degrade honestly.** No prober wired, or probe not requested ⇒
  `reachability: null`, `probedAt: null` (exactly as the Clients page degrades
  to `unknown` pre-#39). A probe that times out or throws a non-SSH error ⇒
  `unknown` (the prober itself maps SSH-unreachable to `offline`).
- **`lastSeen` bump on success.** A probe that reaches a client bumps
  `last_seen` to the probe instant and reflects it in the row — matching
  `health-service.refreshLastSeen`. The probe *is* the opt-in side effect the
  admin asked for; the default (no-probe) path writes nothing.

## Deliverables

### Backend
1. `api/policy/preview-dtos.ts`
   - `probe?: boolean` on the request schema.
   - `reachability: z.enum(clientReachabilityValues).nullable()` +
     `probedAt: z.string().nullable()` on `previewAffectedClientSchema`
     (`clientReachabilityValues` imported from the `transport/health` barrel —
     single source, no drift).
2. `api/policy/preview-routes.ts`
   - Split "gather affected client base rows" from the annotation.
   - New exported `probeReachability(db, prober, rows, opts)` → per-clientId
     `{ reachability, probedAt, lastSeen }` map, using the concurrency+deadline
     bounds; unit-testable with a fake prober + injected `deadlineFactory`.
   - Thread the optional `ClientProber` into `registerPreviewRoutes` and probe
     only when `probe === true`.
3. `api/plugin.ts` — pass `opts.prober` to `registerPreviewRoutes`.

### Frontend
4. `frontend/src/lib/views/PolicyPreviewView.svelte`
   - A "Check live status" button in the affected-clients panel that re-requests
     with `probe: true` (one-shot); a `probing` flag for its busy state.
   - A per-client reachability pill (online / offline / unknown), shown only
     once a probe has run.
   - The debounced auto-preview (on edits) stays probe-free.
5. `frontend/src/lib/api/policy-preview.ts` — pass `probe` through (the field is
   already on `PolicyPreviewRequest`).

### Tests
- Backend HTTP (`tests/api/policy-preview.test.ts`): existing affected-client
  `toEqual`s extended with `reachability: null` / `probedAt: null` (contract
  gained fields — not a weakening); default path unprobed; `probe:true` with no
  prober ⇒ null; `probe:true` with an injected fake prober ⇒ online (lastSeen
  bumped) + offline.
- Backend unit (`tests/api/policy-preview-probe.test.ts`): `probeReachability`
  online / offline / throw→unknown / deadline-timeout→unknown / order + lastSeen
  bump, with a fake prober and injected `deadlineFactory`.
- Frontend api (`tests/api/policy-preview.test.ts`): `probe:true` reaches the
  request body.
- Frontend component (`tests/components/policy-preview-view.test.ts`): clicking
  "Check live status" calls the API with `probe:true` and renders the pills.

## License boundary

None touched. The probe reaches the client only over the existing Phase-4 SSH
subprocess facade (via the injected `ClientProber`); no GPL code linked
in-process, no subprocess/REST boundary collapsed, no image or dependency
change. `CLAUDE.md` → "License boundaries".
