/**
 * The signed per-user PIN session cookie (#112).
 *
 * The child-scoped counterpart to the admin {@link ./session.ts}: a small,
 * **non-secret** payload (`{ uid, iat }`) base64url-encoded in a cookie that
 * `@fastify/cookie` signs with `PCT_SECRET_KEY`. Signing gives integrity — a
 * tampered or unsigned cookie is rejected — which is all a "this request is
 * user N" marker needs; there is nothing secret to encrypt. It is a **distinct
 * cookie** (`pct_pin_session`) from the admin session, so the two never collide
 * and an `/app` PIN login never grants admin rights (or vice versa).
 *
 * Expiry is enforced twice (browser `maxAge` + an independent `iat` check in
 * {@link readPinSession}), so a replayed cookie cannot outlive the window even
 * if the client ignores `maxAge`. The window is short (12h) because a shared
 * child device should re-authenticate roughly daily, tighter than the 7-day
 * admin session.
 *
 * License boundary: none touched — `@fastify/cookie` is MIT and the payload is
 * our own.
 */
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/** Cookie name for the per-user PIN session — distinct from the admin cookie. */
export const PIN_SESSION_COOKIE = "pct_pin_session";

/**
 * How long a PIN session is valid, in seconds (12 hours). Short enough that a
 * shared family device re-prompts roughly daily, long enough not to nag a child
 * mid-session.
 */
export const PIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

/** The signed PIN-session payload. `uid` is the supervised user's id; `iat` is epoch seconds. */
const pinSessionPayloadSchema = z.object({
  uid: z.number().int().positive(),
  iat: z.number().int().positive(),
});

/** The decoded, validated PIN session. */
export type PinSession = z.infer<typeof pinSessionPayloadSchema>;

/** Cookie attributes shared by set and clear so they always match. */
const COOKIE_OPTIONS: CookieSerializeOptions = {
  // Not readable from JS (mitigates XSS token theft); the /app UI learns its
  // login state from GET /api/app/session, never by reading the cookie.
  httpOnly: true,
  // Strict: not sent on cross-site requests, closing off CSRF against the
  // cookie-authenticated /app routes.
  sameSite: "strict",
  // Sent to every path so /app (the SvelteKit app) and /api/* both see it.
  path: "/",
};

/** base64url-encode the JSON payload (no signing — `setCookie` signs it). */
function encode(payload: PinSession): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Reverse {@link encode}; returns `null` on any malformed/invalid input. */
function decode(raw: string): PinSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const result = pinSessionPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Issue a fresh signed PIN-session cookie for `userId` on the reply. */
export function issuePinSession(reply: FastifyReply, userId: number): void {
  const payload: PinSession = { uid: userId, iat: Math.floor(Date.now() / 1000) };
  reply.setCookie(PIN_SESSION_COOKIE, encode(payload), {
    ...COOKIE_OPTIONS,
    signed: true,
    maxAge: PIN_SESSION_TTL_SECONDS,
  });
}

/** Clear the PIN-session cookie (logout). Mirrors {@link issuePinSession}'s attributes. */
export function clearPinSession(reply: FastifyReply): void {
  reply.clearCookie(PIN_SESSION_COOKIE, COOKIE_OPTIONS);
}

/**
 * Read and validate the PIN session from a request. Returns the decoded
 * {@link PinSession} when the cookie is present, correctly signed, well-formed,
 * and within {@link PIN_SESSION_TTL_SECONDS}; otherwise `null`.
 */
export function readPinSession(request: FastifyRequest): PinSession | null {
  const raw = request.cookies[PIN_SESSION_COOKIE];
  if (raw === undefined) return null;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;

  const session = decode(unsigned.value);
  if (session === null) return null;

  const ageSeconds = Math.floor(Date.now() / 1000) - session.iat;
  if (ageSeconds > PIN_SESSION_TTL_SECONDS) return null;

  return session;
}
