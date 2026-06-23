/**
 * Shared `Authorization: Bearer <token>` header parsing.
 *
 * The dashboard authenticates several distinct surfaces with opaque bearer
 * secrets — the client-enrolment exchange (#77) and the integration tokens
 * (#114) — so the header parser lives here, next to {@link ./secret-token.js},
 * rather than in any one feature's route module. Keeping it in `auth/` means a
 * guard (`integrations/guard.ts`) never has to reach back into a sibling
 * feature's HTTP routes to parse a header.
 *
 * License boundary: none touched — plain TypeScript.
 */

/**
 * Extract the token from an `Authorization: Bearer <token>` header, or `null`
 * if the header is missing or not a non-empty bearer credential.
 */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}
