# Issue #268 — Enable + verify Timekpr-nExT native warning UX (Alpha-1)

Roadmap: Phase 3 (client install). Alpha-1 epic #185; acceptance run #261.

## Problem

Alpha-1 ships **without** the `pct-client-agent` toast/cadence/grace UX (Phase
8b: #103/#101/#106/#104/#105). So the *only* warning a supervised user gets
before a Timekpr session cutoff is Timekpr-nExT's **own** client indicator. The
Phase-3 installer installs the `timekpr-next` package but neither configures the
client indicator's autostart nor verifies it runs — and gives no generous
advance warning — so enforcement can land as a silent cold logout.

## Upstream facts (verified)

- Package ships the system-wide autostart entry
  `/etc/xdg/autostart/timekpr-client.desktop`; client/indicator binary is
  `/usr/bin/timekprc`.
- `/etc/timekpr/timekpr.conf` keys (defaults):
  - `TIMEKPR_FINAL_NOTIFICATION_TIME = 60` — single "time's almost up" heads-up,
    N seconds before termination.
  - `TIMEKPR_FINAL_WARNING_TIME = 10` — continuous final countdown duration.
  - `TIMEKPR_TERMINATION_TIME = 15` — irreversible window (left untouched — it is
    the technical termination-assignment lead, not a warning).

## Design

Generous Alpha-1 lead times (overridable via env, defaults chosen here):
- `TIMEKPR_FINAL_NOTIFICATION_TIME = 300` (5-minute advance heads-up).
- `TIMEKPR_FINAL_WARNING_TIME = 60` (final-minute countdown).

Edit only those keys **in place**, preserving the rest of the file (session
types, excluded users, polltime, …) — never overwrite the whole config.

Autostart: copy the package's own `timekpr-client.desktop` into each supervised
user's `~/.config/autostart/` (so the `Exec` stays correct across upgrades) and
force it enabled (`Hidden=false`, `X-GNOME-Autostart-enabled=true`) to defend
against a stale per-user `Hidden=true` override that would silently suppress the
indicator on Cinnamon.

## License / tamper posture

Configures an upstream GPL tool by editing its config file + dropping a desktop
entry — no in-process linkage, no GPL binary added to any image (same model as
e2guardian). Tamper-resistance ceiling unchanged: this only *enables/verifies*
an upstream tool's own UX and makes warnings **more** generous.

## Phases

1. **Lib helper + baseline install** (`client/lib/pct-common.sh`,
   `client/install-baseline-tools.sh`):
   - `pct_set_conf_key file key value` — idempotent in-place key set
     (replace-or-append), dry-run aware.
   - `pct_timekpr_write_user_autostart src dest` — copy + force-enable
     (unit-testable without resolving a real user).
   - Extend `pct_baseline_configure_timekpr` to tune the two warning keys.
   - New per-user step `pct_baseline_configure_timekpr_client` wired after the
     ActivityWatch step (so `~/.config` is already user-owned).
   - bats: `pct-common.bats` (set-conf-key), `install-baseline-tools.bats`
     (dry-run plan lines + real autostart write).
2. **Self-test + docs** (`client/self-test.sh`, `client/tests/self-test.bats`,
   `docs/client-install.md`):
   - `pct_selftest_timekpr_client_autostart` — per supervised user, present &
     not disabled; fail the enrol otherwise.
   - Update self-test fixtures + add pass/fail cases.
   - Document Timekpr's native client as the Alpha-1 warning UX (richer Phase-8b
     UX is the Alpha-2 gate).

## Tests / gate

`shellcheck` clean across `client/**`; all bats green (no root/network/tools).
No server/TypeScript changes. No new dependency.
