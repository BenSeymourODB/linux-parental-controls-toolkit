/**
 * zod DTOs for the account/device-core CRUD surface (#51): request bodies,
 * URL params, and response shapes for `User`, `Client`, and the `UserOnClient`
 * link. As with every `/api/*` DTO these are the single contract shared with
 * the SvelteKit frontend and external integrators — types are inferred from the
 * schemas, never hand-written twice (`CLAUDE.md` → "api/ — zod DTOs ...").
 *
 * Storage uses epoch-second `Date` columns (see `policy/schema.ts`); the
 * response mappers below serialize them as ISO-8601 UTC strings so the wire
 * contract is unambiguous and human-readable.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { isValidTimeZone } from "../../policy/budget-window.js";
import type { ClientRow, UserOnClientRow, UserRow } from "../../policy/repository.js";

/** An IANA timezone name, validated against the host's tz database (ADR-0001). */
export const tzSchema = z.string().refine(isValidTimeZone, { message: "Unknown IANA timezone" });

/** `:id` path param, coerced from the string Fastify provides. */
export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** Reject a PATCH that carries no updatable fields with a clear 400. */
function nonEmpty(value: object): boolean {
  return Object.keys(value).length > 0;
}

// --- Users -----------------------------------------------------------------

export const createUserSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  tz: tzSchema.nullable().optional(),
});

export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    tz: tzSchema.nullable().optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const userResponseSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  tz: z.string().nullable(),
  createdAt: z.string(),
});

export type CreateUserRequest = z.infer<typeof createUserSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;

/** Map a stored user row to its wire DTO. */
export function toUserResponse(row: UserRow): UserResponse {
  return {
    id: row.id,
    displayName: row.displayName,
    tz: row.tz,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Clients ---------------------------------------------------------------

export const createClientSchema = z.object({
  hostname: z.string().trim().min(1).max(253),
  sshUser: z.string().trim().min(1).max(64),
});

export const updateClientSchema = z
  .object({
    hostname: z.string().trim().min(1).max(253).optional(),
    sshUser: z.string().trim().min(1).max(64).optional(),
  })
  .refine(nonEmpty, { message: "At least one field must be provided" });

export const clientResponseSchema = z.object({
  id: z.number().int(),
  hostname: z.string(),
  sshUser: z.string(),
  enrolledAt: z.string(),
  lastSeen: z.string().nullable(),
});

export type CreateClientRequest = z.infer<typeof createClientSchema>;
export type UpdateClientRequest = z.infer<typeof updateClientSchema>;
export type ClientResponse = z.infer<typeof clientResponseSchema>;

/** Map a stored client row to its wire DTO. */
export function toClientResponse(row: ClientRow): ClientResponse {
  return {
    id: row.id,
    hostname: row.hostname,
    sshUser: row.sshUser,
    enrolledAt: row.enrolledAt.toISOString(),
    lastSeen: row.lastSeen === null ? null : row.lastSeen.toISOString(),
  };
}

// --- User-on-client links --------------------------------------------------

/** `:userId` path param for the nested link routes. */
export const userIdParamsSchema = z.object({ userId: z.coerce.number().int().positive() });

/** `:userId`/`:clientId` path params for a single link. */
export const userClientParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  clientId: z.coerce.number().int().positive(),
});

export const upsertLinkSchema = z.object({
  linuxUsername: z.string().trim().min(1).max(32),
  // Linux UIDs are non-negative; 0 (root) is permitted at the type level even
  // if policy would never map a supervised user to it.
  linuxUid: z.number().int().min(0),
});

export const linkResponseSchema = z.object({
  userId: z.number().int(),
  clientId: z.number().int(),
  linuxUsername: z.string(),
  linuxUid: z.number().int(),
});

export type UpsertLinkRequest = z.infer<typeof upsertLinkSchema>;
export type LinkResponse = z.infer<typeof linkResponseSchema>;

/** Map a stored link row to its wire DTO. */
export function toLinkResponse(row: UserOnClientRow): LinkResponse {
  return {
    userId: row.userId,
    clientId: row.clientId,
    linuxUsername: row.linuxUsername,
    linuxUid: row.linuxUid,
  };
}
