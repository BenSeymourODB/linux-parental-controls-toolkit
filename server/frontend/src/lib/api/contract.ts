/**
 * The frontend's single import surface for the `/api` contract.
 *
 * Per `CLAUDE.md` ("Validation / DTOs") and #53, the frontend never
 * hand-writes a parallel DTO: it consumes the **inferred zod types** from the
 * server `/api` source. These are `import type` re-exports, so they are erased
 * at build time — `vite build` never bundles server code, and there is no
 * runtime coupling across the process boundary. `svelte-check` resolves the
 * server graph's bare imports (`zod`, `drizzle-orm`) from `server/node_modules`
 * (the CI `frontend-build` job installs the server package first).
 *
 * License boundary: type-only; no GPL surface. zod (MIT) / drizzle (Apache-2.0)
 * are pulled in only for type resolution, never linked into the frontend bundle.
 */
export type { SessionResponse, LoginRequest } from "../../../../src/auth/dtos.js";
export type {
  UserResponse,
  CreateUserRequest,
  UpdateUserRequest,
} from "../../../../src/api/policy/dtos.js";
export type { ErrorEnvelope, ErrorDetail } from "../../../../src/api/errors.js";
