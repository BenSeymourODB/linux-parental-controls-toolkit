/**
 * The `/api/*` JSON-contract version (ADR 0007 §1, §6).
 *
 * A standalone constant module so both `api/meta.ts` (which publishes it on
 * `GET /api/meta`) and `events/protocol.ts` (which stamps it into the handshake
 * `accept` frame) read one source without an import cycle. A **positive
 * integer**, bumped only on a *breaking* change to a `/api/*` request/response
 * DTO (additive changes never bump it).
 *
 * License boundary: none touched.
 */
export const API_VERSION = 1;
