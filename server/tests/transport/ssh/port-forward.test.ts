/**
 * Focused unit tests for {@link SshPortForwarder} — the loopback port-forward
 * unit extracted from the SSH facade (#306).
 *
 * The forwarder drives only a structural `forwardOut`-capable client whose
 * channel is a `Duplex`, so these tests pass a fake client backed by
 * `PassThrough` channels (wired `socket.pipe(channel); channel.pipe(socket)` a
 * PassThrough echoes bytes straight back, exercising the real piping/teardown
 * over a loopback round-trip) — no `ssh2`, no remote, no `as` cast. The facade's
 * own suite covers the same behaviours end-to-end through `SshTransport`.
 */
import { connect } from "node:net";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  SshPortForwarder,
  type ForwardCapableClient,
} from "../../../src/transport/ssh/port-forward.js";

/** One recorded `forwardOut` request's destination + source descriptor. */
interface ForwardRecord {
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
}

class FakeForwardClient implements ForwardCapableClient {
  readonly forwardOuts: ForwardRecord[] = [];
  readonly channels: PassThrough[] = [];

  constructor(private readonly failWith?: Error) {}

  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, channel: PassThrough) => void,
  ): this {
    this.forwardOuts.push({ srcIP, srcPort, dstIP, dstPort });
    queueMicrotask(() => {
      if (this.failWith !== undefined) {
        // ssh2 passes no channel on failure; a throwaway keeps the callback's
        // 2-arg shape while the forwarder ignores it on the error path.
        cb(this.failWith, new PassThrough());
        return;
      }
      const channel = new PassThrough();
      this.channels.push(channel);
      cb(undefined, channel);
    });
    return this;
  }
}

/** Connect to a loopback port, send `message`, resolve with the echoed bytes. */
function roundTrip(port: number, message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(message));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

/** Connect, send a byte, resolve once the connection is closed (reset). */
function dropOnConnect(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("ping"));
    socket.on("close", () => resolve());
    socket.on("error", () => undefined);
  });
}

/** Resolve if a connect to `port` is refused (the listener is gone). */
function expectRefused(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error(`expected connection to ${port} to be refused`));
    });
    socket.on("error", () => resolve());
  });
}

describe("SshPortForwarder.run", () => {
  it("forwards a loopback connection over the session, then tears down", async () => {
    const client = new FakeForwardClient();
    let chosenPort = 0;

    const echoed = await new SshPortForwarder({ client, remote: { port: 5600 } }).run(
      async (local) => {
        expect(local.host).toBe("127.0.0.1");
        chosenPort = local.port;
        return roundTrip(local.port, "ping");
      },
      0,
    );

    expect(echoed).toBe("ping");
    // The forward targeted the requested remote endpoint (loopback default).
    expect(client.forwardOuts[0]).toMatchObject({ dstIP: "127.0.0.1", dstPort: 5600 });
    // The listener is closed once the window ends — connecting is now refused.
    await expectRefused(chosenPort);
  });

  it("defaults the remote host to loopback and honours an explicit one", async () => {
    const client = new FakeForwardClient();

    await new SshPortForwarder({ client, remote: { host: "10.0.0.5", port: 5600 } }).run(
      async (local) => {
        // forwardOut only fires per incoming connection — make one.
        await roundTrip(local.port, "x");
      },
      0,
    );

    expect(client.forwardOuts[0]).toMatchObject({ dstIP: "10.0.0.5", dstPort: 5600 });
  });

  it("destroys the forwarded channel on teardown (no channel leak)", async () => {
    const client = new FakeForwardClient();

    await new SshPortForwarder({ client, remote: { port: 5600 } }).run(async (local) => {
      // Hold the connection open (never end it) so the channel can't close from
      // EOF — only the teardown can destroy it. The echoed byte confirms the
      // socket↔channel↔socket loop is wired before the window ends.
      await new Promise<void>((resolve, reject) => {
        const socket = connect(local.port, "127.0.0.1", () => socket.write("ping"));
        socket.once("data", () => resolve());
        socket.on("error", reject);
      });
    }, 0);

    const channel = client.channels[0];
    expect(channel).toBeDefined();
    expect(channel?.destroyed).toBe(true);
  });

  it("drops a connection whose forward fails without sinking the window", async () => {
    const client = new FakeForwardClient(new Error("forward refused"));

    const result = await new SshPortForwarder({ client, remote: { port: 5600 } }).run(
      async (local) => {
        await dropOnConnect(local.port);
        return "fn-still-ran";
      },
      0,
    );

    expect(result).toBe("fn-still-ran");
    // The failed forward opened no tracked channel.
    expect(client.channels).toHaveLength(0);
  });

  it("propagates the callback's rejection and still tears the listener down", async () => {
    const client = new FakeForwardClient();
    let chosenPort = 0;

    const error = await new SshPortForwarder({ client, remote: { port: 5600 } })
      .run(async (local) => {
        chosenPort = local.port;
        throw new Error("consumer boom");
      }, 0)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toBe("consumer boom");
    await expectRefused(chosenPort);
  });
});
