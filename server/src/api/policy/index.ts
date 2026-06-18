/**
 * Policy CRUD surface (#51): the route registrar plus the zod DTOs and inferred
 * types the frontend and integrators consume. Re-exported from the top-level
 * `api/` barrel so the contract is imported from one place.
 */
export { registerPolicyRoutes } from "./routes.js";
export {
  clientResponseSchema,
  createClientSchema,
  createUserSchema,
  idParamsSchema,
  linkResponseSchema,
  tzSchema,
  updateClientSchema,
  updateUserSchema,
  upsertLinkSchema,
  userClientParamsSchema,
  userIdParamsSchema,
  userResponseSchema,
  type ClientResponse,
  type CreateClientRequest,
  type CreateUserRequest,
  type LinkResponse,
  type UpdateClientRequest,
  type UpdateUserRequest,
  type UpsertLinkRequest,
  type UserResponse,
} from "./dtos.js";
