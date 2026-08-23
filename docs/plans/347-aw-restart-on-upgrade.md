# Plan — #347 (part a): restart per-user ActivityWatch units on upgrade

Roadmap: operations/lifecycle (no numbered phase); follow-up to the
upgrade-in-place work in PR #344. Closes the ActivityWatch slice of #347.

## Problem

`install-baseline-tools.sh` supports an idempotent upgrade-in-place re-run.
PR #344 already made the **system** daemons apply changed config on a re-run
(`pct_apply_change`: `try-restart timekpr.service` when `timekpr.conf` changed,
`try-reload-or-restart e2guardian.service` when the filter group changed).

The **per-user ActivityWatch** units were left out. `pct_baseline_install_activitywatch`
extracts the pinned AW bundle to `${AW_PREFIX}` and records the version in a
stamp; on an upgrade re-run it drops the new binaries, but the running
`systemd --user` units (`aw-server`, `aw-watcher-afk`, `aw-watcher-window`)
keep executing the old binary until restarted. So a bumped `AW_VERSION` silently
does not take effect for an already-logged-in supervised user.

## Scope (this PR)

Part (a) of #347 only — the ActivityWatch per-user restart.

- **Detect a genuine upgrade** in `pct_baseline_install_activitywatch`: read the
  previously-installed version from the stamp *before* overwriting it. Set a
  process-global `PCT_AW_VERSION_CHANGED=1` only when a *different* version was
  previously installed. A first install (no prior version) and a same-version
  no-op re-run both leave it `0`.
- **Best-effort per-user restart** (`pct_aw_restart_user_units`): when AW was
  upgraded, `try-restart` each of the user's three `--user` units so they pick
  up the new binaries. Skips cleanly when the user has no per-user runtime dir
  (`${PCT_USER_RUNTIME_BASE}/<uid>` absent — no `systemd --user` bus to talk to);
  the newly installed binaries then start clean on next login. The configure
  loop runs `loginctl enable-linger` just before this, so on a re-run the runtime
  dir is usually already present; `try-restart` is a no-op for an inactive unit,
  so only actually-running units are bounced. Failures are per-user best-effort:
  a unit that will not restart is **warned about, never fatal**, so one user's
  failure cannot abort the whole (idempotent) reconcile mid-way under `set -e`.
- Reuses the established change-detection idiom: `try-*` verbs (never swallow a
  genuine failure of an active unit), a dry-run intent line mirroring
  `pct_apply_change`, and env-overridable seams (`PCT_USER_SYSTEMCTL`,
  `PCT_USER_RUNTIME_BASE`) so the path is unit-testable without root, a real
  login session, or a real `/run/user`.

### Behaviour matrix

| Re-run case                     | `PCT_AW_VERSION_CHANGED` | Restart? |
| ------------------------------- | ------------------------ | -------- |
| First install (no stamp)        | 0                        | no       |
| Same version (stamp == pinned)  | 0 (install short-circuits) | no     |
| Upgrade (stamp != pinned)       | 1                        | yes, best-effort per reachable user |

## Tests (`client/tests/install-baseline-tools.bats`)

- First install → no restart planned.
- Same-version re-run → `already installed`, no restart planned.
- Upgrade re-run → `upgrade detected (old -> new)` + a per-user restart intent
  for each supervised user.
- Real reachability guard: unreachable bus → logs + issues no `systemctl --user`
  call; reachable bus → exactly one `try-restart` per unit.
- Real best-effort guarantee: one unit's `try-restart` failing → the function
  still returns 0, warns, and still attempts the other two units.

Validated with `shellcheck -x` (client + scripts) and `bats client/tests/`.

## Deferred (tracked)

- Part (b) of #347 — the `pct-client` agent `.deb` postinst restarting
  `pct-client-bridge` / the per-user `pct-client-agent` — depends on the agent
  `.deb` packaging, which does not exist yet (**#106**). Rides with that work;
  #347 stays open for it.

## License boundary

None touched. Pure Bash + `systemctl` verbs over the existing per-user unit
model; no GPL source linked, no GPL binary added to the image, no Docker change.
