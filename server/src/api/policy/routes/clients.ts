/**
 * Client CRUD routes (#51): `/clients`. A create/update/delete pushes a
 * `client.*` command; a duplicate hostname maps to `409 conflict`.
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { clientPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  createClientSchema,
  idParamsSchema,
  toClientResponse,
  updateClientSchema,
  type ClientResponse,
} from "../dtos.js";
import { asConflict, assertFound, assertRemoved } from "./shared.js";

/** Register the `/clients` CRUD routes. */
export function registerClientRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

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
      push.push(
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
      const row = assertFound(
        repo.getClient(scope.db, request.params.id),
        "Client",
        request.params.id,
      );
      return toClientResponse(row);
    },
  );

  typed.patch(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema, body: updateClientSchema } },
    async (request): Promise<ClientResponse> => {
      const row = assertFound(
        asConflict(
          () => repo.updateClient(scope.db, request.params.id, request.body),
          "That hostname is already in use by another client",
        ),
        "Client",
        request.params.id,
      );
      push.push(clientPushCommands("client.updated", row.id, { ...request.body }));
      return toClientResponse(row);
    },
  );

  typed.delete(
    "/clients/:id",
    { ...guard, schema: { params: idParamsSchema } },
    async (request, reply) => {
      assertRemoved(
        repo.deleteClient(scope.db, request.params.id),
        `Client ${request.params.id} not found`,
      );
      push.push(clientPushCommands("client.deleted", request.params.id, {}));
      return reply.code(204).send();
    },
  );
}
