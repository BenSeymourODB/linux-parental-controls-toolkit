/**
 * The `GET /api/events/stream` WebSocket route (#100, Phase 8b).
 *
 * The server end of the channel in `docs/client-notifications.md`: a
 * long-lived, client-initiated (outbound-through-NAT) WebSocket the
 * `pct-client-bridge` holds open, authenticated with the per-client bearer
 * token (#77). The lifecycle:
 *
 *  1. A `preHandler` runs {@link authenticateEventClient} *before* the upgrade,
 *     so a missing/invalid token is rejected as a `401` envelope and no socket
 *     is ever opened. The authenticated {@link ClientRow} is stashed on the
 *     request for the handler.
 *  2. **Version handshake (#165, ADR 0007).** The client speaks first: its
 *     opening `hello` frame is run through {@link negotiate} (the N-1 window).
 *     On `accept` the server sends the agreed dialect back, refreshes the
 *     client's reported `agent_version` (the #165/#101 heartbeat), and only
 *     *then* registers the connection in the {@link EventHub} and starts the
 *     ping/pong heartbeat. On `refuse` (incompatible / missing / unparseable
 *     `hello`, or a hello timeout) it sends a typed `refuse` frame and closes —
 *     it never registers an un-negotiated socket or assumes a dialect.
 *  3. On `close`/`error`, the heartbeat stops, the connection is unregistered,
 *     and `last_seen` is touched again — so the dashboard's notion of "live"
 *     (a registered connection) and "last seen" stay accurate.
 *
 * Reconnect is the client's job (backoff lives in the bridge, #101): each
 * reconnect re-authenticates and re-negotiates. The server keeps no per-client
 * event buffer — missed policy/grant *state* is reconciled over the SSH
 * transport (#84), not replayed here.
 *
 * `@fastify/websocket` (already a dependency) is registered in an encapsulated
 * child scope so WebSocket upgrade handling is confined to this route and does
 * not touch the rest of `/api`.
 *
 * License boundary: none touched — Fastify + `@fastify/websocket` (MIT).
 */
import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  recordClientAgentVersion,
  setClientUpdateRequired,
  touchClientLastSeen,
  type ClientRow,
} from "../policy/repository.js";
import { authenticateEventClient } from "./auth.js";
import type { EventHub } from "./hub.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, startHeartbeat } from "./heartbeat.js";
import { negotiate, parseHello } from "./protocol.js";

/** WebSocket close code for a refused/abandoned handshake (RFC 6455 "policy violation"). */
const HANDSHAKE_CLOSE_CODE = 1008;

/**
 * How long the server waits for the client's opening `hello` before refusing
 * and closing — so a silent client can't hold a socket open indefinitely
 * pre-handshake (the ping/pong heartbeat only starts once accepted).
 */
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The process-wide event fan-out registry (#100). Decorated at app
     * composition (`buildApp`); the event *producers* (#99, #108, Phase-10
     * grants) publish onto it with `app.eventHub.publishToClient(...)`.
     */
    eventHub: EventHub;
  }
  interface FastifyRequest {
    /**
     * The client authenticated for an `/api/events/stream` connection, set by
     * the route's `preHandler`; `null` on every other request.
     */
    eventClient: ClientRow | null;
  }
}

/** Options for {@link registerEventStream}. */
export interface EventStreamOptions {
  /** Ping interval for the liveness heartbeat (ms). Defaults to 30s. */
  heartbeatIntervalMs?: number;
  /** How long to wait for the opening `hello` before refusing. Defaults to 10s. */
  helloTimeoutMs?: number;
}

/**
 * Register `GET /events/stream` on an already-`/api`-prefixed scope, using
 * `hub` as the fan-out registry. Call inside the `/api` plugin so the route
 * inherits the shared error envelope (the `preHandler`'s `401` renders through
 * it). Registers `@fastify/websocket` in an encapsulated child scope.
 */
export async function registerEventStream(
  scope: FastifyInstance,
  hub: EventHub,
  options: EventStreamOptions = {},
): Promise<void> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  await scope.register(async (events) => {
    await events.register(fastifyWebsocket);
    events.decorateRequest("eventClient", null);

    events.get(
      "/events/stream",
      {
        websocket: true,
        preHandler: async (request) => {
          request.eventClient = authenticateEventClient(
            request.server.db,
            request.headers.authorization,
          );
        },
      },
      (socket: WebSocket, request: FastifyRequest) => {
        const client = request.eventClient;
        if (client === null) {
          // Unreachable: the preHandler sets it or throws. Closing keeps the
          // type honest without a non-null assertion.
          socket.close(1011, "unauthenticated");
          return;
        }
        const clientId = client.id;
        const db = request.server.db;
        const log = request.log;

        // Wait for the opening hello before registering/heart-beating. A silent
        // client is refused once the timeout fires (the heartbeat that would
        // otherwise reap it only starts after accept).
        const helloTimer = setTimeout(() => {
          const refusal = negotiate(null);
          socket.send(JSON.stringify(refusal.frame));
          log.warn(
            { event: "event_stream_refused", clientId, reason: "hello_timeout" },
            "client sent no hello before timeout; refusing event stream",
          );
          socket.close(HANDSHAKE_CLOSE_CODE, "hello timeout");
        }, helloTimeoutMs);
        helloTimer.unref?.();
        // Clear the timer if the socket goes away mid-handshake (idempotent with
        // the post-accept close handler installed below).
        socket.on("close", () => clearTimeout(helloTimer));

        socket.once("message", (data: unknown) => {
          clearTimeout(helloTimer);
          const hello = parseHello(String(data));
          const result = negotiate(hello);

          if (result.kind === "refuse") {
            socket.send(JSON.stringify(result.frame));
            // Only "too old" means the client must update; a "server_too_old"
            // (server behind) or "malformed_hello" (buggy/garbage opener) is not
            // the client's version to fix (ADR 0007 §5).
            if (result.reason === "client_too_old") {
              setClientUpdateRequired(db, clientId, true);
            }
            log.warn(
              { event: "event_stream_refused", clientId, reason: result.reason },
              "event-stream handshake refused",
            );
            socket.close(HANDSHAKE_CLOSE_CODE, result.reason);
            return;
          }

          // Accepted. `hello` is non-null here (negotiate refuses a null hello);
          // the guard satisfies the type system without a non-null assertion.
          socket.send(JSON.stringify(result.frame));
          if (hello !== null) {
            recordClientAgentVersion(db, clientId, hello.agentVersion, new Date());
          }
          // A compatible connect clears any stale update-required flag (the
          // client has since been updated to an in-window protocol).
          if (client.updateRequired) {
            setClientUpdateRequired(db, clientId, false);
          }
          hub.register(clientId, socket);
          touchClientLastSeen(db, clientId, new Date());
          log.info(
            { event: "event_stream_open", clientId, eventProtocol: result.frame.eventProtocol },
            "client event stream opened",
          );

          const heartbeat = startHeartbeat(socket, heartbeatIntervalMs);
          socket.on("pong", () => heartbeat.onPong());

          socket.on("error", (err: Error) => {
            log.warn({ event: "event_stream_error", clientId, err }, "client event stream error");
          });

          socket.on("close", () => {
            heartbeat.stop();
            hub.unregister(clientId, socket);
            touchClientLastSeen(db, clientId, new Date());
            log.info({ event: "event_stream_close", clientId }, "client event stream closed");
          });
        });
      },
    );
  });
}
