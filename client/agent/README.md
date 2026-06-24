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

| Variable | Required | Meaning |
|---|---|---|
| `PCT_BRIDGE_SERVER_URL` | yes | `ws(s)://…/api/events/stream` |
| `PCT_BRIDGE_TOKEN` | yes | per-client enrolment bearer token |
| `PCT_BRIDGE_USERS` | yes | JSON array of `{ "userId": N, "linuxUid": N }` |
| `PCT_BRIDGE_SOCKET_DIR` | no | socket dir (default `/run/pct`) |
| `PCT_BRIDGE_SOCKET_MODE` | no | socket file mode (default `0o600`) |
| `PCT_BRIDGE_BACKOFF_BASE_MS` / `PCT_BRIDGE_BACKOFF_MAX_MS` | no | reconnect bounds |

### Not in this slice (tracked elsewhere)

- The **ADR-0007 version handshake** (`hello`/`accept`/`refuse`) — lands once
  the server side (#165) is on `main`.
- **Privileged enforcement actions** (`timekpra --kill-session`, lockout
  set/clear) and the narrow `sudoers` rule — Phase 8c (#107 / #108).
- The **`pct-client-agent`** per-user notification daemon — #103.
- **`.deb` packaging, systemd units, `/run/pct` provisioning** — #106.

## Develop

```bash
cd client/agent
npm ci
npm run format:check && npm run lint && npm run typecheck && npm test
```
