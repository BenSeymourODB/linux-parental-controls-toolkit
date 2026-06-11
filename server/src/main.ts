/**
 * Process entrypoint: build the Fastify app and bind it to a socket.
 *
 * The build (`server/Dockerfile`, #6) runs the compiled output as
 * `node dist/main.js`. Listening on 0.0.0.0 makes the dashboard reachable
 * from outside the container. The bind host/port become configurable via
 * the settings loader (#10); 8000 is the documented default for now.
 *
 * This file is excluded from the coverage gate (vitest.config.ts): it is a
 * thin bootstrap whose only job is to call buildApp() and listen.
 */
import { buildApp } from "./web/app.js";

const HOST = "0.0.0.0";
const PORT = 8000;

async function main(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
