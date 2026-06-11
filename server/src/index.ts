/**
 * Parental-controls dashboard (Fastify orchestrator).
 *
 * Module split (see CLAUDE.md "Code conventions"):
 *   web/          Fastify app composition: /admin, /app, /api, /integrations
 *   api/          zod DTOs and JSON routes shared by frontends + integrators
 *   policy/       policy model, persistence, immutable grant ledger
 *   events/       WebSocket server-to-client event stream
 *   integrations/ external inbound APIs (e.g. family-calendar rewards)
 *   transport/    subprocess + REST runners reaching each client component
 */
export const packageName = "dashboard";
