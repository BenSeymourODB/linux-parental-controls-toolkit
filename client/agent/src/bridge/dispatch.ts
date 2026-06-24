/**
 * AF_UNIX fan-out from the bridge to the per-user agents (#101, Phase 8b).
 *
 * `docs/client-notifications.md`: the bridge "forwards each [event] to the
 * per-user agent over a small Unix socket at `/run/pct/<linux-uid>.sock`", and
 * the agent "subscribes to its own socket from the bridge". So the **bridge
 * owns the socket**: for each supervised user it listens on that user's path,
 * the agent connects in, and the bridge writes newline-delimited JSON frames to
 * whatever agent connection(s) are attached. Routing is by `event.userId →
 * local Linux uid → that uid's server`.
 *
 * A frame for an unknown `userId`, or for a user whose agent is not currently
 * connected, is logged and dropped — the degraded modes in
 * `docs/client-notifications.md` ("Notification stack unavailable") make
 * best-effort-per-frame delivery acceptable; the bridge must never block or
 * crash because an agent is down. The server keeps no per-client buffer either
 * (`events/stream.ts`), so there is nothing to replay here.
 *
 * Filesystem ownership/permissions of `/run/pct` and the socket files are an
 * install/packaging concern (#106): this module unlinks a stale socket and
 * applies the configured `mode`, but performs no privileged `chown`.
 *
 * License boundary: none touched — `node:net` + `node:fs` only.
 */
import { existsSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import net from "node:net";

import type { UserMapping } from "./config.js";
import type { Logger } from "./logger.js";
import type { EventFrame } from "./protocol.js";

/** Options for a {@link Dispatcher}. */
export interface DispatcherOptions {
  /** The supervised users on this client (the `userId → linuxUid` map). */
  users: readonly UserMapping[];
  /** Resolve the AF_UNIX path the bridge listens on for a local uid. */
  socketPath: (linuxUid: number) => string;
  /** Filesystem mode applied to each socket file after it binds. */
  socketMode: number;
  logger: Logger;
}

/** One supervised user's listening socket and its attached agent connections. */
class UserSocket {
  readonly #server: net.Server;
  readonly #connections = new Set<net.Socket>();

  constructor(
    readonly userId: number,
    readonly linuxUid: number,
    readonly path: string,
    private readonly logger: Logger,
  ) {
    this.#server = net.createServer((socket) => this.#onConnection(socket));
    this.#server.on("error", (err) => {
      this.logger.error({ uid: this.linuxUid, path: this.path, err }, "user socket error");
    });
  }

  /** Bind, set the file mode, and start accepting agent connections. */
  async listen(mode: number): Promise<void> {
    // A stale socket file from an unclean shutdown would make listen() throw
    // EADDRINUSE; the bridge owns this path, so reclaiming it is safe.
    if (existsSync(this.path)) unlinkSync(this.path);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once("error", onError);
      this.#server.listen(this.path, () => {
        this.#server.removeListener("error", onError);
        resolve();
      });
    });
    await chmod(this.path, mode);
  }

  /** Write a frame line to every attached agent connection. Returns the count. */
  send(line: string): number {
    for (const socket of this.#connections) socket.write(line);
    return this.#connections.size;
  }

  /** Number of agents currently attached (for tests/observability). */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Close all connections and the server, removing the socket file. */
  async close(): Promise<void> {
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  #onConnection(socket: net.Socket): void {
    this.#connections.add(socket);
    this.logger.info({ uid: this.linuxUid }, "agent connected");
    const drop = (): void => {
      this.#connections.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", (err) => {
      this.logger.warn({ uid: this.linuxUid, err }, "agent connection error");
      drop();
    });
  }
}

/**
 * Owns one listening AF_UNIX socket per supervised user and routes each
 * decoded {@link EventFrame} to the right user's connected agent(s).
 */
export class Dispatcher {
  readonly #byUserId = new Map<number, UserSocket>();
  readonly #options: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    this.#options = options;
    for (const { userId, linuxUid } of options.users) {
      const path = options.socketPath(linuxUid);
      this.#byUserId.set(userId, new UserSocket(userId, linuxUid, path, options.logger));
    }
  }

  /** Bind every per-user socket. Rejects if any fails to listen. */
  async start(): Promise<void> {
    for (const userSocket of this.#byUserId.values()) {
      await userSocket.listen(this.#options.socketMode);
    }
    this.#options.logger.info({ users: this.#byUserId.size }, "dispatcher listening");
  }

  /**
   * Route one frame to the addressed user's agent. A frame for an unmapped
   * `userId`, or for a user with no agent attached, is logged and dropped.
   * Returns the number of agent connections the frame was written to.
   */
  dispatch(frame: EventFrame): number {
    const userSocket = this.#byUserId.get(frame.event.userId);
    if (userSocket === undefined) {
      this.#options.logger.warn(
        { userId: frame.event.userId, type: frame.event.type, seq: frame.seq },
        "dropping frame for unmapped userId",
      );
      return 0;
    }
    const delivered = userSocket.send(JSON.stringify(frame) + "\n");
    if (delivered === 0) {
      this.#options.logger.warn(
        { userId: frame.event.userId, uid: userSocket.linuxUid, type: frame.event.type },
        "no agent connected; dropping frame",
      );
    }
    return delivered;
  }

  /** Number of agents attached for a given policy userId (for tests). */
  connectionCount(userId: number): number {
    return this.#byUserId.get(userId)?.connectionCount ?? 0;
  }

  /** Close every per-user socket and remove the socket files. */
  async stop(): Promise<void> {
    for (const userSocket of this.#byUserId.values()) {
      await userSocket.close();
    }
  }
}
