# Issue #92 — AppArmor profile drops for per-app hard deny

Roadmap: `docs/roadmap.md` → Phase 6 ("AppArmor profile drops").
Architecture: `docs/architecture.md` → Enforcement responsibilities —
"Per-app deny (hard block) | AppArmor | Ansible-deployed profile".

## Goal

The second Phase-6 client enforcement playbook (after e2guardian, #90): turn
policy **always-on per-app `deny`** rules into AppArmor profiles dropped on the
client that hard-block the designated executables, driven by the existing
Ansible runner (subprocess, license-clean), with each run recorded in the audit
log (#85).

## License & tamper-resistance boundaries

- AppArmor is configured **only** by writing profile files and signalling a
  reload (`apparmor_parser`), driven by `ansible-playbook` as a subprocess — no
  in-process/GPL linkage, no GPL binary in the dashboard image (`CLAUDE.md` →
  License boundaries rules 3 & 6).
- In-scope per-app **blocking enforcement** only: it denies designated apps. It
  does **not** lock down `/etc`, `/usr`, or boot media against root, and does
  not fight a root user — staying under the bounded tamper-resistance posture
  (`docs/client-install.md`, the issue's own note).

## Design

### What maps to an AppArmor deny

AppArmor confines by **executable path**, not by Linux UID. A profile attaches
to a binary and applies machine-wide when that binary is exec'd. So the unit of
this mapping is "block executable E on client C", derived from policy.

Scope of rules consumed (mirrors #90's conservative first slice):

- **Always-on `deny` schedules** only — `action = "deny"` with all five
  recurrence/date-scoping columns `NULL` (`recurrenceDays`,
  `recurrenceStartMinute`, `recurrenceEndMinute`, `effectiveFrom`,
  `effectiveTo`). Windowed / date-scoped denies are deferred (an AppArmor
  profile cannot be time-gated without a scheduler swapping it; that is the
  e2guardian #216-equivalent follow-up).
- Targeting an **app activity**: `targetKind = "activity"` → an `activities`
  row with `kind = "app"`; or `targetKind = "group"` → an `activity_groups`
  row, expanded via `listGroupActivities` to its `kind = "app"` members.
- Only `matchType = "exact"` matchers that are **absolute paths** (start with
  `/`) are mappable to an AppArmor attachment. `app_group` named-bundle
  activities and non-`exact` / non-absolute matchers are **skipped** and
  documented (richer matching is #178/#195's domain; we do not guess a path).
- `targetKind = "overall"` and `extend`/`allow` actions are ignored.

### Per-UID precision — documented limitation

Because AppArmor attaches per executable (not per UID), a profile blocks the
binary for everyone on the client. The plan still records, per executable,
which supervised users (`userId`/`linuxUid`/`linuxUsername`) contributed the
deny — for the audit trail and a future per-UID mechanism — but the deployed
profile is keyed by executable. Where two users on one client have different
app-deny sets, the **union** is blocked. True per-UID exec gating (AppArmor
`owner`/uid conditions are about file ownership, not the exec'ing uid) is a
separate, harder problem → **deferred follow-up issue**.

### Server module — `server/src/transport/ansible/apparmor.ts`

- `AppArmorDenial` = `{ profileName, executable, blockedFor: {userId, linuxUid,
  linuxUsername}[] }`.
- `AppArmorPlan` = `{ clientId, hostname, denials: AppArmorDenial[] }` —
  `denials` deduped by executable, sorted ascending; `blockedFor` sorted by
  userId. `appArmorPlanSchema` (zod) validates it before the run.
- `profileNameFor(exe)`: `pct.` + path with leading `/` removed, `/` → `.`, any
  remaining non-`[A-Za-z0-9._-]` → `_`. Deterministic, collision-resistant.
- `buildAppArmorPlan(db, clientId): AppArmorPlan` — `getClient` (throw
  `AppArmorPlanError` if missing) → `listClientLinks` → for each user,
  `listUserSchedules`, filter always-on app denies, resolve activity/group to
  executables, accumulate `executable -> Set<user>`.
- `pushAppArmorProfiles(opts)` — build + validate the plan, then
  `runner.runPlaybook({ playbook: "apparmor-profiles.yml", hosts:[host],
  limit: hostname, extraVars: { apparmor_plan: plan } })`; record an
  `AuditEntry` (target from client host/22/sshUser, redacted representative
  argv, outcome mapped from the Ansible error taxonomy, `durationMs` from an
  injected clock) on success / unreachable / failed / binary-missing; rethrow
  the transport error after recording. Malformed plan → throw before any run
  (no audit). Audit sink is optional (no-sink path).
- Run even when `denials` is empty so the playbook **reconciles** stale
  `pct.*` profiles off the client.

### Runner change

Widen `RunPlaybookOptions.extraVars` from
`Record<string, string | number | boolean>` to a JSON-serialisable nested type
(`Record<string, ExtraVarValue>`) so the structured plan passes whole. The
runner already `JSON.stringify`s it — only the type widens. (#90/PR #217 makes
the same widening; a trivial merge either way.)

### Repository change

Add `listClientLinks(db, clientId): UserOnClientRow[]` (inverse of
`listUserLinks`), ascending by userId. (Also added by #90/PR #217 under the
same name — trivial merge.)

### Client playbook — `client/ansible/playbooks/apparmor-profiles.yml`

`become: true`, FQCN modules, consumes `apparmor_plan` (the nested object).

1. Ensure `/etc/apparmor.d/pct.d/` exists (our namespace).
2. Render one profile file per denial from `templates/pct-deny.profile.j2`
   into `/etc/apparmor.d/pct.d/<profileName>` — a minimal **deny-all enforce**
   profile attached to the executable (no permissions granted ⇒ the binary
   cannot mmap its libraries and fails to start).
3. Reconcile: remove `pct.d/*` files not in the current plan (find → filter →
   `apparmor_parser -R` then unlink) so a lifted deny is undone on re-apply.
4. Load/reload changed profiles with `apparmor_parser -r` (notify handler).
   Profiles live under `pct.d/` and are loaded explicitly by the playbook; a
   boot-time `apparmor_parser` of the directory keeps them applied (documented
   in the playbook header; full boot-persistence + the live convergence test is
   the deferred Molecule item).

Templates + a Molecule scenario (`molecule/apparmor/…`) mirroring the
activitywatch scenario shape; **live convergence run deferred** (needs
privileged Docker + AppArmor in the container) → follow-up issue, mirroring the
#215 split for e2guardian.

## Tests (Vitest, unit)

`server/tests/transport/ansible/apparmor.test.ts`:

- `profileNameFor`: sanitisation, prefix, idempotent charset.
- `buildAppArmorPlan`: always-on app deny (direct activity); group expansion to
  app members (non-app members ignored); dedupe across users + sort;
  `blockedFor` attribution + sort; skips windowed/date-scoped, `allow`/`extend`,
  `overall`, `app_group`, non-`exact`, non-absolute matchers; multiple users
  union; user with nothing to block omitted; unknown client throws; empty client
  → empty denials.
- `pushAppArmorProfiles`: extra-vars carries the plan + `--limit`; audit on
  success / unreachable / failed / binary-missing with outcome mapping + error
  truncation; no-sink path; malformed-plan rejection before run; empty-plan run
  still dispatched (reconcile).

`listClientLinks` repository test (ordering, empty, isolation by client).

YAML/Jinja parse + `ansible-lint` (production profile) on the new playbook;
live apply deferred.

## Deferred (issues to file + link)

- Live Molecule convergence applying the AppArmor playbook against a privileged
  AppArmor-capable container (mirrors #215).
- Windowed / date-scoped per-app denies (time-gated profiles) — the
  AppArmor analogue of #216.
- True per-UID exec gating (beyond AppArmor's executable-scoped attachment).
- `app_group` named-bundle expansion — owned by the richer-matcher work
  (#178/#195).

## Phases / pushes

1. Server: `apparmor.ts` (plan + push), runner widening, `listClientLinks`,
   unit tests → first push, open draft PR.
2. Client: playbook + templates + Molecule scenario; docs note (architecture
   enforcement table already lists it; add a short "AppArmor playbook" subsection
   if warranted) → second push.
3. Finalize: full gate, file deferred issues, mark ready, subagent review.
