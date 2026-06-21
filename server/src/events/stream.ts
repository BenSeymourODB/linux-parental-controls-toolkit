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
 *  2. On open, the connection is registered in the {@link EventHub} under its
 *     `Client.id` (the address producers fan out to), `last_seen` is touched,
 *     and a ping/pong {@link startHeartbeat heartbeat} starts.
 *  3. On `close`/`error`, the heartbeat stops, the connection is unregistered,
 *     and `last_seen` is touched again — so the dashboard's notion of "live"
 *     (a registered connection) and "last seen" stay accurate.
 *
 * Reconnect is the client's job (backoff lives in the bridge, #101): each
 * reconnect re-authenticates and re-registers. The server keeps no per-client
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

import { touchClientLastSeen, type ClientRow } from "../policy/repository.js";
import { authenticateEventClient } from "./auth.js";
import type { EventHub } from "./hub.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, startHeartbeat } from "./heartbeat.js";

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

        hub.register(clientId, socket);
        touchClientLastSeen(db, clientId, new Date());
        request.log.info({ event: "event_stream_open", clientId }, "client event stream opened");

        const heartbeat = startHeartbeat(socket, heartbeatIntervalMs);
        socket.on("pong", () => heartbeat.onPong());

        socket.on("error", (err: Error) => {
          request.log.warn(
            { event: "event_stream_error", clientId, err },
            "client event stream error",
          );
        });

        socket.on("close", () => {
          heartbeat.stop();
          hub.unregister(clientId, socket);
          touchClientLastSeen(db, clientId, new Date());
          request.log.info({ event: "event_stream_close", clientId }, "client event stream closed");
        });
      },
    );
  });
}
