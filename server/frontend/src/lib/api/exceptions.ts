/**
 * CRUD calls for the `Exception` policy entity (#51 contract, #189 editor).
 *
 * Same proven shape as `$lib/api/budgets` (#53/#189): thin typed wrappers over
 * {@link apiFetch}, with request/response types imported from the shared `/api`
 * contract so the frontend never re-declares a DTO. An `Exception` is a
 * one-shot, date-boxed override: it `allow`/`deny`/`extend`s a `targetKind`
 * (`overall`, an `activity`, or an activity `group`) for a user over
 * `[effectiveFrom ?? createdAt, expiresAt)`. Unlike a `Schedule` it does not
 * recur — the date bounds are authored directly here.
 *
 * License boundary: none — JSON API only.
 */
import { apiFetch } from "./client.js";
import type {
  ExceptionResponse,
  CreateExceptionRequest,
  UpdateExceptionRequest,
} from "./contract.js";

/**
 * List exceptions. With `userId` the server restricts to that user; without it,
 * every exception is returned (the `?userId=` filter the route exposes).
 */
export function listExceptions(userId?: number): Promise<ExceptionResponse[]> {
  const path = userId === undefined ? "/exceptions" : `/exceptions?userId=${userId}`;
  return apiFetch<ExceptionResponse[]>(path);
}

/** Create an exception; the server validates target coherence and returns the row. */
export function createException(input: CreateExceptionRequest): Promise<ExceptionResponse> {
  return apiFetch<ExceptionResponse>("/exceptions", { method: "POST", body: input });
}

/** Patch an exception; `input` must carry at least one field (server enforces). */
export function updateException(
  id: number,
  input: UpdateExceptionRequest,
): Promise<ExceptionResponse> {
  return apiFetch<ExceptionResponse>(`/exceptions/${id}`, { method: "PATCH", body: input });
}

/** Delete an exception. Resolves on the server's `204`. */
export function deleteException(id: number): Promise<void> {
  return apiFetch<void>(`/exceptions/${id}`, { method: "DELETE" });
}
