/**
 * zod DTOs for the post-enrol connectivity-verification surface (#354): the
 * response the client's installer receives from
 * `POST /api/clients/:id/verify-connection`.
 *
 * As with every `/api/*` DTO this is the single contract shared with the client
 * installer (and the admin frontend for the persisted-outcome fields on the
 * health DTO). The `failureClass` enum is derived from
 * {@link sshUnreachableReasonValues} — the same "DTO enum from the transport
 * source-of-truth" discipline `health-dtos` uses for the component /
 * reachability enums — so the classification (#353) is never re-declared here.
 *
 * License boundary: none touched — plain TypeScript + zod.
 */
import { z } from "zod";

import { sshUnreachableReasonValues } from "../../transport/health/index.js";

/**
 * The classified SSH failure cause (#353) — `dns` / `connection_refused` /
 * `timeout` / `auth` / `handshake` / `unknown` — each with a different operator
 * fix, surfaced so the installer can print a class-specific remediation hint.
 */
export const sshUnreachableReasonSchema = z.enum(sshUnreachableReasonValues);

export const verifyConnectionResponseSchema = z.object({
  /** Whether the dashboard reached the client over SSH on this run. */
  reachable: z.boolean(),
  /**
   * The classified failure cause when `reachable` is `false`; omitted when the
   * verification succeeded.
   */
  failureClass: sshUnreachableReasonSchema.optional(),
  /** A human-readable detail line (the underlying SSH message, or a success note). */
  detail: z.string(),
  /** ISO-8601 timestamp of when the verification ran. */
  verifiedAt: z.string(),
});

export type VerifyConnectionResponse = z.infer<typeof verifyConnectionResponseSchema>;
