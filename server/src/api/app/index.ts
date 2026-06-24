/**
 * Public surface of the per-user PIN auth API module (#112): the route
 * registrar and the inferred DTO types the frontend consumes.
 *
 * License boundary: none touched.
 */
export { registerAppAuthRoutes } from "./routes.js";
export {
  setUserPinSchema,
  userPinStatusResponseSchema,
  pinLoginRequestSchema,
  pinSessionUserSchema,
  pinSessionResponseSchema,
  appMeResponseSchema,
  type SetUserPinRequest,
  type UserPinStatusResponse,
  type PinLoginRequest,
  type PinSessionResponse,
  type AppMeResponse,
} from "./dtos.js";
