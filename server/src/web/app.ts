/**
 * Fastify app composition.
 *
 * `buildApp()` is a factory (not a module-level singleton) so tests can
 * construct isolated instances and exercise routes via `app.inject()`
 * without binding a socket — see docs/testing.md → "HTTP routes".
 *
 * This is the minimal Phase 1 slice: a "hello, no policy yet" landing
 * route and a `/healthz` probe. Logging configuration (pino, request
 * IDs) lands in #11; the policy/api/integrations mounts land in later
 * phases.
 */
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Build and configure a Fastify instance.
 *
 * The logger is disabled here; #11 owns the shared pino configuration
 * that the rest of the app will follow.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/", async (_request, reply) => {
    return reply.type("text/plain").send("hello, no policy yet");
  });

  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  return app;
}
