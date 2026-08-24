# `pct-client` agent (bridge + per-user agent)

The supervised-client daemons described in
[`docs/client-notifications.md`](../../docs/client-notifications.md). This is a
**standalone TypeScript package** — it ships in the client `.deb` bundling its
own Node runtime under `/usr/lib/pct-client/`, so it does not depend on the
distro's Node and is intentionally separate from `server/`.

## `pct-client-bridge` (this slice — #101)

The system-level service that:

- holds the outbound WebSocket to the dashboard's `GET /api/events/stream`,
  authenticated with the per-client enrolment bearer token;
- reconnects with exponential backoff (full jitter);
- validates each server-pushed event frame against the shared taxonomy; and
- fans each event out to the right per-user `pct-client-agent` over an AF_UNIX
  socket the bridge owns at `/run/pct/<linux-uid>.sock`, routing by
  `event.userId → local Linux uid`.

### Configuration

The bridge reads its configuration from the environment (see
`src/bridge/config.ts`):

| Variable                                                   | Required | Meaning                                        |
| ---------------------------------------------------------- | -------- | ---------------------------------------------- |
| `PCT_BRIDGE_SERVER_URL`                                    | yes      | `ws(s)://…/api/events/stream`                  |
| `PCT_BRIDGE_TOKEN`                                         | yes      | per-client enrolment bearer token              |
| `PCT_BRIDGE_USERS`                                         | yes      | JSON array of `{ "userId": N, "linuxUid": N }` |
| `PCT_BRIDGE_SOCKET_DIR`                                    | no       | socket dir (default `/run/pct`)                |
| `PCT_BRIDGE_SOCKET_MODE`                                   | no       | socket file mode (default `0o600`)             |
| `PCT_BRIDGE_BACKOFF_BASE_MS` / `PCT_BRIDGE_BACKOFF_MAX_MS` | no       | reconnect bounds                               |

### Not in this slice (tracked elsewhere)

- The **ADR-0007 version handshake** (`hello`/`accept`/`refuse`) — lands once
  the server side (#165) is on `main`.
- **Privileged enforcement actions** (`timekpra --kill-session`, lockout
  set/clear) and the narrow `sudoers` rule — Phase 8c (#107 / #108).
- The **`pct-client-agent`** per-user notification daemon — #103.

## Develop

```bash
cd client/agent
npm ci
npm run format:check && npm run lint && npm run typecheck && npm test
```

## Building the `.deb` (#106)

`build-deb.sh` produces the `pct-client` Debian package: it compiles the agent
TypeScript, stages the production deps (`ws`, `zod`), downloads and
SHA-256-verifies the pinned Node runtime, and assembles the package with
`dpkg-deb`. The pinned Node version + hashes live in `NODE_VERSION`.

```bash
cd client/agent
npm ci
./build-deb.sh --version 0.1.0            # -> dist/pct-client_0.1.0_amd64.deb
./build-deb.sh --arch arm64 --version 0.1.0
```

| Flag / env         | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `--output PATH`    | where to write the `.deb` (default `dist/pct-client_<ver>_<arch>.deb`) |
| `--version VER`    | package version (default `$PCT_DEB_VERSION`, else `git describe`)      |
| `--arch ARCH`      | `amd64` (default) or `arm64`                                           |
| `PCT_NODE_TARBALL` | pre-fetched Node tarball to skip the download (offline builds)         |
| `PCT_NODE_SHA256`  | override the expected tarball hash (e.g. an injected stub)             |

The package installs the bundled runtime + daemons under `/usr/lib/pct-client/`,
the two systemd units, a `tmpfiles.d` entry for `/run/pct`, and the
`/etc/default/pct-client-bridge` conffile. `postinst` creates the `pct-agent`
account and **enables** (not starts) the bridge — `install-client.sh` writes the
enrolment token to the conffile and starts it. See
[`docs/client-install.md`](../../docs/client-install.md) §5a. Publishing the
package (GitHub Release / apt) is #168; `client/tests/build-deb.bats` covers the
build offline.
