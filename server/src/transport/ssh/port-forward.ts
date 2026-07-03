/**
 * Opens a local `127.0.0.1` port-forward over an already-connected `ssh2`
 * session, runs a caller-supplied `fn` against the loopback endpoint, and tears
 * the forward down cleanly. Extracted from `SshTransport.withPortForward` so the
 * facade is left focused on connection pooling + dispatch (#306).
 *
 * The forward is the inbound transport window for the telemetry pull (#86): a
 * loopback TCP listener accepts local connections and forwards each over the
 * pooled SSH session (`forwardOut`) to `remote` on the client — typically the
 * client's `aw-server`, whose unauthenticated API binds `127.0.0.1` and must
 * never be network-exposed, hence loopback-only.
 *
 * The listener and any in-flight sockets/channels are always closed when `fn`
 * settles, so a forward can't leak past its window; a single forwarded
 * connection that fails is dropped without sinking the window. Establishing the
 * SSH connection (which can fail as unreachable *before* `fn` runs) stays in
 * `SshTransport` — the forwarder receives an already-connected client.
 *
 * License boundary: unchanged — the tunnel only carries the REST/loopback
 * traffic the caller drives; no GPL code is linked in-process (`CLAUDE.md`,
 * `./facade.ts`).
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { PortForwardTarget } from "./facade.js";

/** The only address a forwarded port ever binds — never network-exposed. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * The forward surface a {@link SshPortForwarder} drives — `ssh2`'s `forwardOut`.
 * The forwarded channel is a `Duplex` (pipe-able + destroyable), so the real
 * `ClientChannel` and a test `PassThrough` both satisfy it without an `as` cast
 * (the same structural-fake pattern as `transport/health`).
 */
export interface ForwardCapableClient {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Duplex) => void,
  ): unknown;
}

/** Construction context for an {@link SshPortForwarder}. */
export interface SshPortForwarderOptions {
  /** The already-connected pooled SSH session to forward over. */
  readonly client: ForwardCapableClient;
  /** The remote endpoint on the client to forward to (loopback host by default). */
  readonly remote: PortForwardTarget;
}

/**
 * A single loopback port-forward window. Construct with the session + remote
 * target, then call {@link run} once with the consumer callback.
 */
export class SshPortForwarder {
  readonly #client: ForwardCapableClient;
  readonly #remote: PortForwardTarget;

  constructor(options: SshPortForwarderOptions) {
    this.#client = options.client;
    this.#remote = options.remote;
  }

  /**
   * Open the forward on an OS-assigned (or `localPort`, when non-zero) loopback
   * port, run `fn` with the `{ host, port }` it can be reached at, and tear the
   * forward — listener, in-flight sockets, and forwarded channels — down when
   * `fn` settles. Returns `fn`'s result; propagates its rejection.
   */
  async run<T>(
    fn: (local: { host: string; port: number }) => Promise<T>,
    localPort: number,
  ): Promise<T> {
    const remoteHost = this.#remote.host ?? LOOPBACK_HOST;
    const openSockets = new Set<Socket>();
    const openChannels = new Set<Duplex>();

    const server = createServer((socket: Socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
      // One broken forwarded connection must not take down the whole window.
      socket.on("error", () => socket.destroy());

      this.#client.forwardOut(
        LOOPBACK_HOST,
        addressPort(server),
        remoteHost,
        this.#remote.port,
        (err: Error | undefined, channel: Duplex) => {
          if (err !== undefined) {
            socket.destroy();
            return;
          }
          // Track the channel too: `socket.pipe(channel)` does not propagate a
          // socket `destroy()` to the SSH channel, so without this the channel
          // would linger half-open on the pooled connection across passes.
          openChannels.add(channel);
          channel.on("close", () => openChannels.delete(channel));
          channel.on("error", () => socket.destroy());
          socket.pipe(channel);
          channel.pipe(socket);
        },
      );
    });

    try {
      const port = await listenLoopback(server, localPort);
      return await fn({ host: LOOPBACK_HOST, port });
    } finally {
      for (const socket of openSockets) socket.destroy();
      for (const channel of openChannels) channel.destroy();
      await closeServer(server);
    }
  }
}

/** The bound TCP port of a listening server (0 before it is listening). */
function addressPort(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

/** Resolve once `server` is listening on loopback `port`, with its actual port. */
function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      // Swallow late operational errors so a transient socket fault on the
      // loopback listener can't surface as an unhandled 'error' that crashes
      // the process; the forward is best-effort and its consumer reports
      // failures of its own.
      server.on("error", () => undefined);
      resolve(addressPort(server));
    });
  });
}

/** Close `server`, resolving once it has stopped accepting connections. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
