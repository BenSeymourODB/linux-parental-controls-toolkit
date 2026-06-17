/**
 * The signed admin session cookie (#52).
 *
 * The session is stateless: a small, **non-secret** payload (`{ sub, iat }`)
 * is base64url-encoded and carried in a cookie that `@fastify/cookie` signs
 * with `PCT_SECRET_KEY` (HMAC, via `cookie-signature`). Signing gives
 * integrity — a tampered or unsigned cookie is rejected — which is all a
 * single-admin "this request is the admin" marker needs; there is nothing
 * secret to encrypt. Expiry is enforced twice: the browser drops the cookie at
 * `maxAge`, and {@link readSession} independently rejects a payload whose `iat`
 * is older than {@link SESSION_TTL_SECONDS} (so a replayed cookie cannot
 * outlive the window even if the client ignores `maxAge`).
 *
 * License boundary: none touched — `@fastify/cookie` is MIT and the payload is
 * our own.
 */
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/** Cookie name for the admin session. */
export const SESSION_COOKIE = "pct_session";

/** How long a session is valid, in seconds (7 days). */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The signed session payload. `sub` is the admin username; `iat` is epoch seconds. */
const sessionPayloadSchema = z.object({
  sub: z.string().min(1),
  iat: z.number().int().positive(),
});

/** The decoded, validated session. */
export type Session = z.infer<typeof sessionPayloadSchema>;

/** Cookie attributes shared by set and clear so they always match. */
const COOKIE_OPTIONS: CookieSerializeOptions = {
  // Not readable from JS (mitigates XSS token theft); the admin UI never needs
  // to read it — it calls GET /api/auth/session to learn its login state.
  httpOnly: true,
  // Strict: the cookie is not sent on cross-site requests at all, which closes
  // off CSRF against the cookie-authenticated mutating routes.
  sameSite: "strict",
  // Sent to every path so /admin (the SvelteKit app) and /api/* both see it.
  path: "/",
};

/** base64url-encode the JSON payload (no signing — `setCookie` signs it). */
function encode(payload: Session): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Reverse {@link encode}; returns `null` on any malformed/invalid input. */
function decode(raw: string): Session | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const result = sessionPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Issue a fresh signed session cookie for `username` on the reply. */
export function issueSession(reply: FastifyReply, username: string): void {
  const payload: Session = { sub: username, iat: Math.floor(Date.now() / 1000) };
  reply.setCookie(SESSION_COOKIE, encode(payload), {
    ...COOKIE_OPTIONS,
    signed: true,
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clear the session cookie (logout). Mirrors {@link issueSession}'s attributes. */
export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}

/**
 * Read and validate the session from a request. Returns the decoded
 * {@link Session} when the cookie is present, correctly signed, well-formed,
 * and within {@link SESSION_TTL_SECONDS}; otherwise `null`.
 */
export function readSession(request: FastifyRequest): Session | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw === undefined) return null;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;

  const session = decode(unsigned.value);
  if (session === null) return null;

  const ageSeconds = Math.floor(Date.now() / 1000) - session.iat;
  if (ageSeconds > SESSION_TTL_SECONDS) return null;

  return session;
}
