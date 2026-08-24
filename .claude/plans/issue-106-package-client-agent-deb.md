# Plan — Issue #106: Package the client agent as a `.deb` bundling its own Node runtime

Phase 8b. Ships the `pct-client` Debian package that installs the
`pct-client-bridge` (system service, one per client) and
`pct-client-agent` (`systemd --user`, per supervised user) daemons —
authoritative layout in
[`docs/client-install.md`](../../docs/client-install.md) §5a and
[`docs/client-notifications.md`](../../docs/client-notifications.md) §1/§2.

The bridge/agent TypeScript codebases (#101, #103) already exist under
`client/agent/`. Neither is packaged yet: `install-client.sh` (#76) has a
gap where "install the `pct-client` agent package" should go, and the
issue #106 tracks that packaging surface.

## Boundary posture

- **License**: nothing here changes the boundary. The bundled Node
  runtime is MIT/BSD and lives on the *client* only, never in the
  dashboard image (`CLAUDE.md` → License boundaries, rule 5 stays
  intact). No GPL linkage in the process (bridge/agent are our own TS
  daemons; `timekpra`/`ansible` are subprocesses only, invoked out of
  scope of this PR).
- **Tamper resistance**: within bounds — a plain notification / event
  relay daemon package, no anti-tamper, no `/etc`/`/usr`/boot lockdown
  (`CLAUDE.md` → "Tamper resistance is deliberately bounded").

## Layout the `.deb` installs (matches the docs verbatim)

```
/usr/lib/pct-client/
├── node/                              # bundled Node.js 22 runtime
│   ├── bin/node
│   └── LICENSE
├── dist/                              # compiled TS output
│   ├── main.js                        # bridge entry (pct-client-bridge)
│   ├── agent/main.js                  # agent entry (pct-client-agent)
│   ├── bridge/*.js
│   └── agent/*.js
├── node_modules/                      # production deps: ws, zod
│   ├── ws/
│   └── zod/
└── VERSION                            # the package version string

/usr/lib/systemd/system/pct-client-bridge.service        # system unit
/usr/lib/systemd/user/pct-client-agent.service           # user unit
/usr/lib/tmpfiles.d/pct-client.conf                      # /run/pct dir
/etc/default/pct-client-bridge                           # env, conffile
```

- **Bridge unit** runs `node dist/main.js` as `pct-agent` (created by
  `provision-agent-user.sh` on enrol, #78 — the package `Depends: adduser`
  and the `postinst` creates the user idempotently if missing so
  `dpkg -i pct-client_*.deb` also works in a lab / test setup).
- **Agent unit** runs `node dist/agent/main.js` under
  `systemd --user` for each supervised Linux user (the installer enables
  the user unit per supervised uid; the package's job is to ship the
  unit file only).
- **`/etc/default/pct-client-bridge`** carries `PCT_BRIDGE_SERVER_URL`,
  `PCT_BRIDGE_TOKEN`, `PCT_BRIDGE_USERS` (the `EnvironmentFile=` for the
  bridge unit). Conffile so a `dpkg` upgrade preserves the local values.

## Build pipeline (`client/agent/build-deb.sh`)

Single shell script under `client/agent/`, invoked by dev and CI. Runs
without root — uses `dpkg-deb --build --root-owner-group` (fakeroot
optional). Steps:

1. **Emit compiled JS** — `npx tsc -p tsconfig.build.json` produces
   `dist/` under a staged root.
2. **Stage production deps** — `npm ci --omit=dev --prefix <stage>` so
   `node_modules/` contains only `ws` + `zod`.
3. **Fetch the pinned Node runtime** — `NODE_VERSION` is pinned in a
   `client/agent/NODE_VERSION` sentinel file (single source of truth).
   The script downloads
   `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`
   and verifies against a SHA-256 pinned in the sentinel file
   (`SHA256_LINUX_X64`). `PCT_NODE_TARBALL=<path>` short-circuits the
   download so tests can inject a stub tarball with no network. The
   extracted `node` binary and `LICENSE` file land under
   `usr/lib/pct-client/node/`.
4. **Compose DEBIAN/**
   - `control` — `Package: pct-client`, `Architecture: amd64` (matches
     the bundled runtime), `Depends: systemd, adduser`, `Version:` from
     an env var / `git describe --tags --always` fallback.
   - `postinst` — create the `pct-agent` system user idempotently
     (`getent passwd pct-agent >/dev/null || useradd --system --user-group
     --home-dir /var/lib/pct-agent --shell /usr/sbin/nologin pct-agent`),
     `systemd-tmpfiles --create` for `/run/pct`, then
     `systemctl daemon-reload` and `systemctl enable pct-client-bridge`.
     `dpkg-triggers` on `daemon-reload` is not used to keep the script
     legible.
   - `prerm` — `systemctl disable --now pct-client-bridge` on remove.
   - `postrm` — on `purge` only, tidy `/etc/default/pct-client-bridge`.
   - `conffiles` — the one `/etc/default/pct-client-bridge` line.
5. **Emit** — `dpkg-deb --build --root-owner-group <stage>
   pct-client_<version>_amd64.deb`.

Output path controlled by `--output <path>` (default:
`client/agent/dist/pct-client_<version>_amd64.deb`).

**Reproducibility**: sorted `find`+`tar` inside the staging root, no
timestamps that vary with wall-clock; not bit-for-bit reproducible in
this slice, but structurally stable so `dpkg-deb --info` diffs cleanly
between runs on the same source.

## Tests

Two layers, both live with the code they exercise:

- **`client/tests/build-deb.bats`** — same pattern as
  `build-install-bundle.bats`: build the `.deb` with a stub Node
  tarball, then assert against `dpkg-deb --info`, `--contents`, and the
  extracted control scripts. Fifteen-ish tests covering:
  - the package name/architecture/dependencies
  - the `/usr/lib/pct-client/{node,dist,node_modules}/` layout is
    populated (bridge main + agent main present; `ws` and `zod` present)
  - the two systemd unit files land in the right dirs, `ExecStart`
    points at the bundled node + bundled dist, and the bridge unit
    references `/etc/default/pct-client-bridge`
  - the tmpfiles.d entry creates `/run/pct` with the documented perms
  - `postinst` / `prerm` are executable, contain the user-add and
    daemon-reload hooks, and the tmpfiles create call
  - `conffiles` lists `/etc/default/pct-client-bridge`
  - build fails cleanly on a missing sentinel / wrong SHA-256
- **`.github/workflows/ci.yml`** — extend the `client-agent` job (or add
  a sibling `client-agent-package` job — see phasing) that runs
  `bash client/agent/build-deb.sh` on the Ubuntu runner (dpkg-deb + real
  network to nodejs.org), then `dpkg-deb --info` on the artifact.

The existing `client-agent` job (lint / typecheck / vitest) is
unchanged; the compiled emit is validated in a *new* CI step so a broken
build-tsconfig fails independently of the unit tests.

## Documentation

- `docs/client-install.md` §5a — add a "How the package is built" note
  linking to `client/agent/build-deb.sh`; keep the runtime steps as-is
  (they already describe enabling the units).
- `client/agent/README.md` — a short "Building the `.deb`" section
  documenting `build-deb.sh` args and env (`PCT_NODE_TARBALL`,
  `--output`, `--version`).
- No ADR needed — this is packaging plumbing for a design already
  captured in `docs/client-install.md` / `docs/client-notifications.md`.

## Explicitly out of scope (tracked as follow-ups on the PR)

- **Publishing the `.deb`** from `release.yml` over the chosen channel
  (GitHub Release attachment vs an apt repo). That is #168 (Phase 14),
  which itself depends on the channel decision in #167. Filed as a
  follow-up if #168 lacks the concrete "release.yml step" scope.
- **`install-client.sh` fetching + installing the `.deb`.** The issue
  lists this as an "optional/late step". Without a publish channel it
  would fetch from nowhere. The install-client hook ships as a **passive
  env-guarded step**: `PCT_AGENT_DEB=<path>` (an already-fetched local
  file) triggers `dpkg -i` + `systemctl enable --now` for the per-user
  units. Full "fetch from the enrol response's advertised URL" is a
  follow-up that lands with #168 / the timekpr-mirror publish path
  (#389 epic).
- **Narrow bridge `sudoers` drop-in.** The bridge's privileged actions
  (`timekpra --kill-session` for `enforce.session_lock`, PAM lockout
  set/clear) are Phase 8c (#107 / #108), not yet implemented. `#345` is
  the ADR on the dashboard-side privilege model; the bridge-side
  sudoers drop-in will follow that decision. This PR ships the package
  with **no** privileged commands and **no** loosened sudoers config —
  the empty posture is the safe default. Filed as a Phase-8c follow-up
  linked from the PR.
- **Rich `pct-client-agent@<supervised-user>.service` templating** for
  enabling the user unit per supervised uid at package-install time.
  The `enrol` step in `install-client.sh` (#76 §5a) is the right place
  to enable user units per supervised uid (it already knows the
  supervised-user list); the package's job is to ship the unit file
  only.
- **Signing the `.deb` / apt index.** Ties to #393 (the server-hosted
  mirror's signed apt index). Not needed for a GitHub Release
  attachment.

## Phasing (commit + push per phase; first push opens the draft PR)

- **Phase 1** — Build pipeline + emit:
  `client/agent/tsconfig.build.json`, `client/agent/package.json` gains
  a `build` script, `client/agent/build-deb.sh` skeleton that builds an
  otherwise-empty `.deb` under a stub Node tarball, first `.bats` test
  asserting the `.deb` builds and `dpkg-deb --info` runs. Push → draft
  PR opens.
- **Phase 2** — Complete the package payload + full bats coverage:
  systemd units (bridge system + agent user), tmpfiles.d entry,
  DEBIAN/{control,postinst,prerm,postrm,conffiles}, and the rest of the
  bats assertions. Node runtime staging (still via stub tarball in
  tests).
- **Phase 3** — CI + docs + follow-ups. `.github/workflows/ci.yml` gains
  the package-build step (real Node download). `client/agent/README.md`
  build-deb section. `docs/client-install.md` §5a note. Mark PR ready,
  run review subagent, open follow-up issues (install-client.sh fetch
  hook, Phase-8c sudoers drop-in).

Each phase leaves the tree clean (`server`'s quality gate + `client/agent`'s
`format:check` / `lint` / `typecheck` / `test` + bats all green) before
pushing.
