/**
 * Serve the client install script at `GET /install-client.sh` (#itoffd).
 *
 * The script is bundled into the image at build time
 * (`COPY client/install-client.sh ./client-scripts/install-client.sh`) and
 * served directly from disk. A client device can bootstrap with:
 *
 *   sudo bash <(curl -fsSL https://<dashboard>/install-client.sh) \
 *       --server-url https://<dashboard> \
 *       --enrolment-token <token> \
 *       --supervised-user <username>
 *
 * If the script is absent (e.g. a dev build without the client directory in
 * scope), the route 404s and a startup warning is emitted — startup is never
 * blocked on the presence of the file.
 *
 * License boundary: none touched — plain Fastify + Node.js fs streaming.
 */
import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Settings } from "../config.js";
import { componentLogger } from "./logger.js";

/**
 * Register `GET /install-client.sh` on the app.
 *
 * Streams the bundled script with `Content-Type: text/x-shellscript`. If the
 * file is absent the route returns 404; a warning is also emitted at startup
 * so the operator notices before a client tries to download it.
 */
export function registerInstallScript(app: FastifyInstance, settings: Settings): void {
  const scriptPath = settings.installClientScriptPath;

  if (!existsSync(scriptPath)) {
    componentLogger(app, "web/install-script").warn(
      { installClientScriptPath: scriptPath },
      "install-client.sh not found; GET /install-client.sh will 404 until it is present",
    );
  }

  app.get("/install-client.sh", async (_request, reply) => {
    if (!existsSync(scriptPath)) {
      return reply.code(404).type("text/plain").send("install-client.sh not found");
    }
    return reply.type("text/x-shellscript").send(createReadStream(scriptPath));
  });
}
