# Reverse proxy + TLS for non-LAN deployments

The default deployment (`docs/server-deployment.md`) runs the dashboard as
a plain-HTTP container on `0.0.0.0:8000`, which is fine on a trusted LAN.
The moment you want to reach it from outside that LAN — a parent checking
limits from their phone on mobile data, or the
[next-digital-wall-calendar](https://github.com/BenSeymourODB/next-digital-wall-calendar)
integrator POSTing grants from elsewhere — you should put it behind a
reverse proxy that terminates TLS and (optionally) adds another
authentication layer.

This guide covers what to proxy, the one dashboard-specific wrinkle (the
WebSocket event stream), how the proxy fits the home-NAT connectivity
model, copy-pasteable configs for Caddy / nginx / Traefik, and the
application-layer caveats that change once a proxy sits in front.

> **The proxy fronts the dashboard's HTTP surface only.** It does **not**
> touch the SSH transport the server uses to reach clients, or the
> ActivityWatch port-forwards — those stay on the LAN. See
> [Connectivity model](#connectivity-model) below.

---

## When you need this

| Scenario | Reverse proxy + TLS? |
|---|---|
| Dashboard and clients on the same trusted LAN; admin/parents only ever access it from that LAN | Optional. Plain HTTP on `:8000` works; the app applies a small failed-attempt limiter as defence-in-depth (`docs/server-deployment.md` → TrueNAS deployment). |
| Parents access `/app` (or admin uses `/admin`) from outside the home network | **Yes** — never send the admin session cookie or an enrolment token over plain HTTP across the internet. |
| An external integrator calls `/api/integrations/*` over the internet | **Yes** — terminate TLS and treat the proxy as the volumetric/DoS rate-limiting tier. |

The dashboard is designed for the single-admin household case
(`docs/server-deployment.md` → Authentication); exposing it publicly does
not change that. The proxy adds transport security and a rate-limiting /
WAF tier, not a multi-user identity model.

---

## What to proxy

The dashboard serves everything on one origin and one port (`:8000`).
Forward all of it to the container; the routes sort themselves out
internally:

| Path | What it is | Notes for the proxy |
|---|---|---|
| `/` | Landing/health placeholder | Plain HTTP GET. |
| `/healthz` | Liveness probe (`{"status":"ok"}`) | Handy as the proxy's upstream health check. |
| `/api/*` | The JSON API — the single contract for both frontends **and** external integrators | Plain HTTP; standard request buffering is fine. |
| `/api/events/stream` | The server→client **WebSocket** event stream (bearer-token auth, long-lived) | **Needs WebSocket upgrade + a long read timeout** — see below. |
| `/admin` | SvelteKit admin surface (served as static `admin.html` + hashed `_app/*` assets) | Canonical URL is slash-free; `/admin/` 308-redirects to `/admin`. |
| `/app` | Mobile-first PWA surface (`app.html` + assets) | Same slash handling as `/admin`. |

You do not need per-path proxy rules — a single catch-all upstream to
`dashboard:8000` is enough. The only path that needs *special* handling is
the WebSocket.

### The WebSocket event stream

`GET /api/events/stream` is a long-lived WebSocket the `pct-client-bridge`
holds open to receive `grant.applied`, `policy.changed`,
`enforce.force_close`, `enforce.session_lock`, and `lockout.cleared`
events (`docs/architecture.md` → Data flow; `docs/client-notifications.md`).
A reverse proxy must:

- Forward the `Upgrade: websocket` and `Connection: upgrade` headers so
  the HTTP/1.1 upgrade handshake reaches Fastify. Caddy and Traefik do
  this automatically; nginx needs an explicit `map` (shown below).
- Use a **long read/idle timeout** on that connection. The default
  proxy idle timeout (often 30–60s) will sever the stream and force the
  bridge to reconnect on a cycle. Set it generously (e.g. 1h); the bridge
  reconnects with backoff if the socket really drops, but you don't want
  the proxy churning a healthy connection.

If you also enable HTTP/2 or HTTP/3 at the proxy, keep an HTTP/1.1 path
available for the WebSocket upgrade (all three proxies below handle this
transparently; it is called out only because a hand-rolled HTTP/2-only
config can break WS upgrades).

---

## Connectivity model

This matters because it determines what the proxy is and isn't
responsible for. The dashboard talks to clients over **two independent
channels in opposite directions** (`docs/architecture.md`):

```
                          ┌─────────────────────────────┐
   parent's phone  ──────▶│  reverse proxy (TLS, :443)   │
   (off-LAN, HTTPS)       │   → dashboard :8000 (HTTP)   │
   integrator     ──────▶ └──────────────┬──────────────┘
                                         │
   client (bridge)  ─── WSS ─────────────┘   client → server, outbound
                                         (event stream /api/events/stream)

   dashboard  ─── SSH ───▶ client            server → client, LAN only
                                         (timekpra push, ActivityWatch pull)
```

- **HTTP surface (client/parent/integrator → server):** `/api`,
  `/api/events/stream`, `/admin`, `/app`. This is what the reverse proxy
  fronts and secures with TLS. The event stream is **client-initiated
  outbound**, so a client behind its own NAT reaches the dashboard
  without any inbound hole on the client side — and through the proxy when
  the dashboard is off-LAN.
- **SSH transport (server → client):** the dashboard opens SSH
  connections *out to each client* to run `timekpra` and to port-forward
  ActivityWatch's REST API (`docs/architecture.md` → Data flow;
  Enforcement responsibilities). **The reverse proxy is not involved in
  this at all.** It is not HTTP, it does not pass through the proxy, and
  for the household topology both server and clients sit on the same LAN.
  Exposing the dashboard's *web* surface to the internet does not expose,
  or require exposing, SSH.

Practical consequence: a non-LAN deployment publishes only `:443` (the
proxy). Port `8000` should bind to the proxy's network only (or
`127.0.0.1`), not the public interface. Nothing about SSH-to-clients needs
a public port.

---

## Example configurations

All three assume the dashboard container is reachable to the proxy as
`dashboard:8000` (same Docker network) and that you own a DNS name
(`parentalcontrols.example.com`) pointing at the proxy. Set the
dashboard's `PCT_BASE_URL` to the **public HTTPS URL** so any
absolute-URL generation matches what browsers actually requested:

```yaml
environment:
  - PCT_BASE_URL=https://parentalcontrols.example.com
```

### Caddy

Caddy is the least-effort option: automatic HTTPS via Let's Encrypt and
transparent WebSocket proxying, so the whole config is a few lines.

```caddyfile
# Caddyfile
parentalcontrols.example.com {
    # Caddy obtains and renews the certificate automatically.
    reverse_proxy dashboard:8000 {
        # WebSocket upgrades are proxied transparently; no extra directives
        # needed for /api/events/stream. Raise the upstream stream timeout
        # so a healthy long-lived event stream is not cut.
        transport http {
            read_timeout 1h
        }
    }
}
```

```yaml
# docker-compose.yml (excerpt) — Caddy in front of the dashboard
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - dashboard

  dashboard:
    image: ghcr.io/benseymourodb/linux-parental-controls-toolkit:latest
    restart: unless-stopped
    # No published ports: only Caddy reaches it, over the compose network.
    expose:
      - "8000"
    volumes:
      - pct_data:/data
    environment:
      - PCT_BASE_URL=https://parentalcontrols.example.com
      - PCT_SECRET_KEY_FILE=/run/secrets/pct_secret_key
      # ...the rest of your dashboard env (AdGuard mode, timezone, etc.)
    secrets:
      - pct_secret_key

volumes:
  pct_data:
  caddy_data:
  caddy_config:
secrets:
  pct_secret_key:
    file: ./secrets/pct_secret_key
```

### nginx

nginx needs an explicit `Upgrade`/`Connection` map for the WebSocket and
a long `proxy_read_timeout` on the stream. Certificates are assumed to be
provisioned out of band (e.g. certbot, or an `nginx-proxy` +
`acme-companion` pair).

```nginx
# Maps the inbound Upgrade header to the right Connection value:
# "upgrade" for a WebSocket request, "" (close/keep-alive) otherwise.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name parentalcontrols.example.com;

    ssl_certificate     /etc/letsencrypt/live/parentalcontrols.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/parentalcontrols.example.com/privkey.pem;

    # The long-lived event-stream WebSocket. HTTP/1.1 + upgrade headers +
    # a generous read timeout so a healthy stream is not severed.
    location /api/events/stream {
        proxy_pass http://dashboard:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP        $remote_addr;
        proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    # Everything else: /, /healthz, /api, /admin, /app and their assets.
    location / {
        proxy_pass http://dashboard:8000;
        proxy_http_version 1.1;
        proxy_set_header Host             $host;
        proxy_set_header X-Real-IP        $remote_addr;
        proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Optional: redirect plain HTTP to HTTPS.
server {
    listen 80;
    server_name parentalcontrols.example.com;
    return 308 https://$host$request_uri;
}
```

The `X-Forwarded-*` headers are sent so a future `trustProxy` option can
recover the real client IP — see [Caveats](#application-layer-caveats)
below for why that matters today.

### Traefik

Traefik (v3) configured via Docker labels. WebSocket upgrades are handled
automatically; the only stream-specific knob is the read timeout, set on
the entrypoint.

```yaml
# docker-compose.yml (excerpt)
services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      # Redirect HTTP→HTTPS for every router on the web entrypoint.
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      # Generous read timeout so the long-lived event stream is not cut.
      - "--entrypoints.websecure.transport.respondingTimeouts.readTimeout=1h"
      - "--certificatesresolvers.le.acme.email=you@example.com"
      - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik_letsencrypt:/letsencrypt

  dashboard:
    image: ghcr.io/benseymourodb/linux-parental-controls-toolkit:latest
    restart: unless-stopped
    expose:
      - "8000"
    volumes:
      - pct_data:/data
    environment:
      - PCT_BASE_URL=https://parentalcontrols.example.com
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.pct.rule=Host(`parentalcontrols.example.com`)"
      - "traefik.http.routers.pct.entrypoints=websecure"
      - "traefik.http.routers.pct.tls.certresolver=le"
      - "traefik.http.services.pct.loadbalancer.server.port=8000"

volumes:
  pct_data:
  traefik_letsencrypt:
```

---

## Application-layer caveats

A reverse proxy changes two things the dashboard assumes about its
environment. Neither blocks a proxied deployment, but you should know
about both.

### TLS, HTTPS, and the session cookie

The admin session cookie is signed (`PCT_SECRET_KEY`), `HttpOnly`, and
`SameSite=Strict`, and it is **not** marked `Secure` — the default LAN
deployment is plain HTTP, and marking it `Secure` there would break login
(`docs/server-deployment.md` → Authentication). When you terminate TLS at
a proxy:

- The proxy is where HTTPS is enforced. Browsers talk HTTPS to the proxy;
  the proxy talks plain HTTP to the container on the trusted internal
  network. Always redirect plain HTTP → HTTPS at the proxy (shown in each
  config above) so a cookie is never sent in clear text over the internet.
- `SameSite=Strict` is fine for off-LAN parent access: the cookie is
  first-party to the proxied origin
  (`https://parentalcontrols.example.com`), so a parent navigating
  directly to `/app` or `/admin` on that origin sends it normally. It
  only suppresses the cookie on *cross-site* navigations, which is the
  CSRF protection you want.
- The cookie is not `Secure`, which means it *could* be sent over plain
  HTTP if a browser ever reached the container directly. Don't publish
  port `8000` on a public interface — bind it to the proxy network or
  `127.0.0.1` (the compose examples use `expose:` rather than `ports:` so
  the container is reachable only from the proxy).

### Client IP and the failed-attempt limiter

The dashboard applies a per-IP failed-attempt limiter to its two
unauthenticated surfaces — the admin login and the token-authenticated
`POST /api/clients/enrol` exchange — as cheap defence-in-depth
(`docs/server-deployment.md`; issues #154). That limiter keys on the
TCP peer address (Fastify's `request.ip`), and the dashboard does **not**
currently trust `X-Forwarded-*` headers.

Behind a reverse proxy, every request arrives from the **proxy's**
address, so the per-IP limiter sees a single IP for all callers and
effectively becomes one global bucket: a brute-force attempt from one host
can throttle legitimate logins from another, and per-attacker isolation is
lost. This is a defence-in-depth degradation, not an authentication
bypass — the Argon2id check and signed-cookie session are unaffected.

Two things follow:

1. **Put the real rate limiting / WAF tier at the proxy.** This is where
   volumetric and per-client-IP throttling belongs anyway
   (`docs/server-deployment.md` notes the proxy is the DoS-protection
   tier). All three proxies above can rate-limit by real client IP.
2. **Forward `X-Forwarded-For`** (the nginx config does; Caddy and
   Traefik do by default). A planned opt-in `trustProxy` setting will let
   the dashboard recover the real client IP from that header so its own
   per-IP limiter works correctly behind a proxy — tracked in
   [#235](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/235).
   Until then, rely on the proxy tier for per-IP limits.

---

## See also

- [`docs/server-deployment.md`](server-deployment.md) — image design,
  volume layout, AdGuard modes, authentication, backup/restore. This guide
  extends its "terminate TLS at a reverse proxy" note.
- [`docs/architecture.md`](architecture.md) — the connectivity model
  (outbound policy push over SSH, inbound telemetry pull, the event
  stream) this guide's [Connectivity model](#connectivity-model) draws on.
- [`docs/client-notifications.md`](client-notifications.md) — what flows
  over the `/api/events/stream` WebSocket.
