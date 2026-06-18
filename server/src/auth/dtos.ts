/**
 * Auth request/response DTOs (#52).
 *
 * zod schemas are the single source of truth for the auth contract; the
 * inferred types are re-exported from `server/src/api/index.ts` so the
 * SvelteKit frontend imports them from the same `/api` surface as every other
 * DTO (`CLAUDE.md` → "Validation / DTOs").
 */
import { z } from "zod";

/** `POST /api/auth/login` request body. */
export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** The inferred login request type. */
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Response shape of `GET /api/auth/session` and `POST /api/auth/login`:
 * whether the caller holds a valid admin session, and the admin username when
 * they do. The admin UI reads this to decide between the login screen and the
 * dashboard.
 */
export const sessionResponseSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().optional(),
});

/** The inferred session/login response type. */
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
