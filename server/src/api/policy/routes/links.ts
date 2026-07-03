/**
 * User-on-client link routes (#51): `/users/:userId/clients[/:clientId]`. A
 * link upsert/delete pushes a `link.*` command; the delete carries the
 * now-cascaded-away OS account name so the executor can "unmanage" it (#253).
 *
 * License boundary: none touched — plain TypeScript + zod + Drizzle.
 */
import type { FastifyInstance } from "fastify";

import * as repo from "../../../policy/repository.js";
import { linkPushCommands, type PolicyPushStub } from "../../../transport/stub.js";
import type { ZodTypeProvider } from "../../validation.js";
import {
  toLinkResponse,
  upsertLinkSchema,
  userClientParamsSchema,
  userIdParamsSchema,
  type LinkResponse,
} from "../dtos.js";
import { asConflict, assertFound, notFound } from "./shared.js";

/** Register the user-on-client link routes. */
export function registerLinkRoutes(scope: FastifyInstance, push: PolicyPushStub): void {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const guard = { preHandler: scope.requireAdmin };

  typed.get(
    "/users/:userId/clients",
    { ...guard, schema: { params: userIdParamsSchema } },
    async (request): Promise<LinkResponse[]> => {
      assertFound(repo.getUser(scope.db, request.params.userId), "User", request.params.userId);
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
      assertFound(repo.getUser(scope.db, userId), "User", userId);
      assertFound(repo.getClient(scope.db, clientId), "Client", clientId);
      const row = asConflict(
        () => repo.upsertLink(scope.db, userId, clientId, request.body),
        `OS account reference ${request.body.osUserRef} is already mapped to another user on client ${clientId}`,
      );
      push.push(
        linkPushCommands("link.upserted", userId, clientId, {
          osUsername: row.osUsername,
          osUserRef: row.osUserRef,
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
      const removed = repo.deleteLink(scope.db, userId, clientId);
      if (removed === undefined) {
        throw notFound(`No link between user ${userId} and client ${clientId}`);
      }
      // Carry the now-cascaded-away OS account name so the executor can
      // "unmanage" it on the client (lift stale timekpra limits back to
      // unrestricted), #253 — the link row is gone, so the name can only come
      // from here. Mirrors the `link.upserted` detail.
      push.push(
        linkPushCommands("link.deleted", userId, clientId, {
          osUsername: removed.osUsername,
          osUserRef: removed.osUserRef,
        }),
      );
      return reply.code(204).send();
    },
  );
}
