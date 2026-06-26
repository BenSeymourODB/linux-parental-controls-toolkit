# Issue #231 — Client install dispatch: OS-family first, then distro

Roadmap: `docs/roadmap.md` → Phase 3 (client install script).
Refs: `docs/client-install.md` → "Other distributions";
`docs/windows-client-support.md` → "Modularity tweaks to make cheaply now" (item 5).

## Problem

`client/install-client.sh` and `client/install-baseline-tools.sh` both gate on a
flat `pct_require_debian_family` check. There is no per-distro adapter dispatch
yet (`client/distros/` exists but is empty). The Windows-support design doc says
a future non-Linux client is **not** a "distro": the entry point should branch
on **OS family first**, then select a distro adapter *within* Linux, so a future
family (e.g. a Windows MSI installer) sits *beside* `client/distros/`, not wedged
inside it. Building the dispatch flat now would force a refactor later.

## Approach (structural seam only — no Windows code)

1. **New `client/lib/pct-dispatch.sh`** (sourced by both scripts; sources
   `pct-common.sh` defensively, double-source-guarded):
   - `pct_detect_os_family` → sets/echoes `PCT_OS_FAMILY` from `uname -s`
     (overridable via `PCT_UNAME` for tests): `Linux→linux`, `Darwin→macos`,
     `MINGW*/MSYS*/CYGWIN*/*NT*→windows`, else lowercased. Only `linux` is
     implemented today.
   - `pct_resolve_distro_adapter` → for Linux, detect the distro
     (`pct_detect_distro`) and resolve `client/distros/<ID>.sh`, falling back by
     `/etc/os-release` `ID`/`ID_LIKE` to the debian-family adapter. Echoes the
     adapter path; non-zero when none matches. `PCT_DISTROS_DIR` overridable.
   - `pct_require_supported_client` → the family-first entry point. Non-Linux
     family → clean "no installer for OS family 'X' yet" error (the additive
     seam). Linux → resolve + source the adapter, then call the adapter's
     `pct_distro_assert_supported` hook. Unsupported distro → error containing
     `"unsupported distro"` (preserves the existing test contract).

2. **New `client/distros/debian.sh`** — the first adapter (Debian/Ubuntu/Mint):
   declares `PCT_DISTRO_FAMILY=debian` and `pct_distro_assert_supported`, which
   delegates to the shared `pct_require_debian_family` predicate (kept in
   `pct-common.sh`). Adding Fedora/Arch later is a new sibling file here, not a
   dispatch change.

3. **Wire the two call sites** — replace `pct_require_debian_family` in
   `pct_install_client` and `pct_install_baseline_tools` with
   `pct_require_supported_client`; source `pct-dispatch.sh`. No behaviour change
   on the Mint/Ubuntu happy path. `pct_require_debian_family` stays (now reached
   via the debian adapter — still used, still tested).

4. **Docs** — update `docs/client-install.md` → "Other distributions" to reflect
   the now-built family-first dispatch and the debian adapter.

## Tests (`client/tests/pct-dispatch.bats`, bats)

- `pct_detect_os_family`: linux / windows / macos / lowercased-unknown via
  `PCT_UNAME`.
- `pct_resolve_distro_adapter`: ubuntu (ID), linuxmint (ID_LIKE), debian (direct
  file) → `debian.sh`; fedora → non-zero. A synthetic `PCT_DISTROS_DIR` proves
  direct `<ID>.sh` match.
- `pct_require_supported_client`: linux+ubuntu → 0, sources adapter, sets
  `PCT_DISTRO_FAMILY=debian`; non-Linux family → non-zero + "OS family" message;
  linux+fedora → non-zero + "unsupported distro".

Existing `pct-common.bats`, `install-client.bats`, `install-baseline-tools.bats`
must stay green unchanged.

## Gate

- `shellcheck client/**/*.sh scripts/**/*.sh` (CI `shellcheck` job).
- `bats client/tests/` (CI `client-tests` job).
- No server/TypeScript changes → server gate unaffected.

## Out of scope (unchanged)

- Any second distro's real package logic (Fedora/Arch are documented-only).
- Server-side capability-keyed transport dispatch → #232.
- Any Windows-specific code.
