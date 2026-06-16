/**
 * `GET /api/meta` — a trivial, dependency-free route that proves the `/api`
 * prefix and the validation/envelope conventions are wired (issue #50). It
 * also models the response-DTO pattern the policy routes (#51) will follow:
 * the shape is a zod schema, and the handler's return type is the inferred
 * type, so the contract has one source of truth.
 *
 * License boundary: none touched.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ZodTypeProvider } from "./validation.js";

/** Response shape of `GET /api/meta`. */
export const metaResponseSchema = z.object({
  /** Service identifier; matches the package name. */
  name: z.string(),
  /** Major version of the `/api/*` contract. Bumped on breaking changes. */
  apiVersion: z.number().int().positive(),
});

/** The inferred `GET /api/meta` response type, shared with the frontend. */
export type MetaResponse = z.infer<typeof metaResponseSchema>;

const META: MetaResponse = { name: "dashboard", apiVersion: 1 };

/** Register `GET /meta` on the given (already `/api`-prefixed) scope. */
export function registerMetaRoute(scope: FastifyInstance): void {
  scope.withTypeProvider<ZodTypeProvider>().get("/meta", async (): Promise<MetaResponse> => META);
}
