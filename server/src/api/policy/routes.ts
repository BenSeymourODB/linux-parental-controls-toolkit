/**
 * Policy CRUD routes for the account/device core (#51): `User`, `Client`, and
 * the `UserOnClient` link.
 *
 * Registered inside the `/api` plugin scope (after `registerAuth`) so every
 * route inherits the zod validator compiler + shared error envelope and sits
 * behind the `requireAdmin` guard — anonymous requests get a `401` envelope,
 * never an unguarded read/write (`CLAUDE.md` → "no privileged in-process
 * shortcuts"). Handlers stay thin: they validate via the DTOs, delegate to the
 * `policy/repository` service over `app.db`, and map "missing row" → `404` and
 * unique-constraint collisions → `409`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../policy/repository.js";
import {
  clientPushCommands,
  createPolicyPushStub,
  linkPushCommands,
  userPushCommands,
} from "../../transport/stub.js";
import { ApiError } from "../errors.js";
import type { ZodTypeProvider } from "../validation.js";
import {
  createClientSchema,
  createUserSchema,
  idParamsSchema,
  toClientResponse,
  toLinkResponse,
  toUserResponse,
  updateClientSchema,
  updateUserSchema,
  upsertLinkSchema,
  userClientParamsSchema,
  userIdParamsSchema,
  type ClientResponse,
  type LinkResponse,
  type UserResponse,
} from "./dtos.js";

/** Run a repository write, mapping a UNIQUE collision to a `409 conflict`. */
function asConflict<T>(write: () => T, message: string): T {
  try {
    return write();
  } catch (err) {
    if (repo.isUniqueViolation(err)) {
      throw new ApiError(409, "conflict", message);
    }
    throw err;
  }
}

/**
 * Register the policy CRUD routes on an already-`/api`-prefixed scope. Call
 * after {@link registerAuth} so `scope.requireAdmin` is decorated.
 */
export function registerPolicyRoutes(scope: FastifyInstance): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  // Phase-2 stub transport (#54): every successful mutation logs the intended
  // per-client effect instead of dispatching it. This is the seam Phase 4
  // (SSH + `timekpra`) and Phase 6 (Ansible) fill in — see `transport/stub.ts`
  // and `docs/architecture.md` → "Outbound (server → client) — policy push".
  const pushStub = createPolicyPushStub(scope.log);

  // --- Users ---------------------------------------------------------------

  typed.get(
    "/users",
    guard,
    async (): Promise<UserResponse[]> => repo.listUsers(scope.db).map(toUserResponse),
  );

  typed.post(
    "/users",
    { ...guard, schema: { body: createUserSchema } },
    async (request, reply): Promise<UserResponse> => {
      const row = repo.createUser(scope.db, request.body);
      // A brand-new user has no client links yet, so this pushes to nobody —
      // the seam still fires (an empty command list is a no-op).
      pushStub.push(
        userPushCommands("user.created", row.id, repo.listUserClientIds(scope.db, row.id), {
          displayName: row.displayName,
          tz: row.tz,
        }),
      );
      reply.code(201);
      return toUserResponse(row);
    },
  );

  typed.get(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<UserResponse> => {
      const row = repo.getUser(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `User ${request.params.id} not found`);
      }
      return toUserResponse(row);
    },
  );

  typed.patch(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateUserSchema } },
    async (request): Promise<UserResponse> => {
      const row = repo.updateUser(scope.db, request.params.id, request.body);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `User ${request.params.id} not found`);
      }
      pushStub.push(
        userPushCommands("user.updated", row.id, repo.listUserClientIds(scope.db, row.id), {
          ...request.body,
        }),
      );
      return toUserResponse(row);
    },
  );

  typed.delete(
    "/users/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      // Resolve the affected clients before deleting — the links cascade away
      // with the user.
      const clientIds = repo.listUserClientIds(scope.db, request.params.id);
      if (!repo.deleteUser(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `User ${request.params.id} not found`);
      }
      pushStub.push(userPushCommands("user.deleted", request.params.id, clientIds, {}));
      return reply.code(204).send();
    },
  );

  // --- Clients -------------------------------------------------------------

  typed.get(
    "/clients",
    guard,
    async (): Promise<ClientResponse[]> => repo.listClients(scope.db).map(toClientResponse),
  );

  typed.post(
    "/clients",
    { ...guard, schema: { body: createClientSchema } },
    async (request, reply): Promise<ClientResponse> => {
      const row = asConflict(
        () => repo.createClient(scope.db, request.body),
        `A client with hostname "${request.body.hostname}" already exists`,
      );
      pushStub.push(
        clientPushCommands("client.created", row.id, {
          hostname: row.hostname,
          sshUser: row.sshUser,
        }),
      );
      reply.code(201);
      return toClientResponse(row);
    },
  );

  typed.get(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request): Promise<ClientResponse> => {
      const row = repo.getClient(scope.db, request.params.id);
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      return toClientResponse(row);
    },
  );

  typed.patch(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateClientSchema } },
    async (request): Promise<ClientResponse> => {
      const row = asConflict(
        () => repo.updateClient(scope.db, request.params.id, request.body),
        "That hostname is already in use by another client",
      );
      if (row === undefined) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      pushStub.push(clientPushCommands("client.updated", row.id, { ...request.body }));
      return toClientResponse(row);
    },
  );

  typed.delete(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!repo.deleteClient(scope.db, request.params.id)) {
        throw new ApiError(404, "not_found", `Client ${request.params.id} not found`);
      }
      pushStub.push(clientPushCommands("client.deleted", request.params.id, {}));
      return reply.code(204).send();
    },
  );

  // --- User-on-client links ------------------------------------------------

  typed.get(
    "/users/:userId/clients",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<LinkResponse[]> => {
      if (repo.getUser(scope.db, request.params.userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${request.params.userId} not found`);
      }
      return repo.listUserLinks(scope.db, request.params.userId).map(toLinkResponse);
    },
  );

  typed.put(
    "/users/:userId/clients/:clientId",
    { ...guard, schema: { params: userClientParamsSchema, body: upsertLinkSchema } },
    async (request): Promise<LinkResponse> => {
      const { userId, clientId } = request.params;
      // Confirm both ends exist so the caller gets a precise 404 rather than an
      // opaque foreign-key failure.
      if (repo.getUser(scope.db, userId) === undefined) {
        throw new ApiError(404, "not_found", `User ${userId} not found`);
      }
      if (repo.getClient(scope.db, clientId) === undefined) {
        throw new ApiError(404, "not_found", `Client ${clientId} not found`);
      }
      const row = asConflict(
        () => repo.upsertLink(scope.db, userId, clientId, request.body),
        `Linux UID ${request.body.linuxUid} is already mapped to another user on client ${clientId}`,
      );
      pushStub.push(
        linkPushCommands("link.upserted", userId, clientId, {
          linuxUsername: row.linuxUsername,
          linuxUid: row.linuxUid,
        }),
      );
      return toLinkResponse(row);
    },
  );

  typed.delete(
    "/users/:userId/clients/:clientId",
    { ...guard, schema: { params: userClientParamsSchema } },
    async (request, reply) => {
      const { userId, clientId } = request.params;
      if (!repo.deleteLink(scope.db, userId, clientId)) {
        throw new ApiError(
          404,
          "not_found",
          `No link between user ${userId} and client ${clientId}`,
        );
      }
      pushStub.push(linkPushCommands("link.deleted", userId, clientId, {}));
      return reply.code(204).send();
    },
  );
}
