import { describe, expect, it } from "vitest";

import {
  SshUnreachableError,
  classifySshUnreachableReason,
  sshUnreachableReasonValues,
  type SshTargetRef,
} from "../../../src/transport/ssh/errors.js";

const target: SshTargetRef = { host: "omega-B85M-DS3H", port: 22, username: "pct-agent" };

/**
 * Build an object shaped like the errors `ssh2` emits — an `Error` carrying
 * `code` / `level` / `syscall` in addition to a message — so the classifier is
 * exercised against realistic fixtures rather than bare strings.
 */
function ssh2Error(props: {
  message: string;
  code?: string;
  level?: string;
  syscall?: string;
  cause?: unknown;
}): Error {
  const err = new Error(
    props.message,
    props.cause === undefined ? undefined : { cause: props.cause },
  );
  return Object.assign(err, {
    ...(props.code === undefined ? {} : { code: props.code }),
    ...(props.level === undefined ? {} : { level: props.level }),
    ...(props.syscall === undefined ? {} : { syscall: props.syscall }),
  });
}

describe("classifySshUnreachableReason", () => {
  it("classifies DNS failures (getaddrinfo ENOTFOUND)", () => {
    const err = ssh2Error({
      message: "getaddrinfo ENOTFOUND omega-B85M-DS3H",
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
      level: "client-socket",
    });
    expect(classifySshUnreachableReason(err)).toBe("dns");
  });

  it("classifies transient DNS failures (EAI_AGAIN)", () => {
    const err = ssh2Error({ message: "getaddrinfo EAI_AGAIN host", code: "EAI_AGAIN" });
    expect(classifySshUnreachableReason(err)).toBe("dns");
  });

  it("classifies a refused connection (ECONNREFUSED — no sshd)", () => {
    const err = ssh2Error({
      message: "connect ECONNREFUSED 10.0.0.4:22",
      code: "ECONNREFUSED",
      syscall: "connect",
      level: "client-socket",
    });
    expect(classifySshUnreachableReason(err)).toBe("connection_refused");
  });

  it("classifies a socket timeout (ETIMEDOUT)", () => {
    const err = ssh2Error({ message: "connect ETIMEDOUT 10.0.0.4:22", code: "ETIMEDOUT" });
    expect(classifySshUnreachableReason(err)).toBe("timeout");
  });

  it("classifies no-route / network-unreachable as timeout", () => {
    expect(
      classifySshUnreachableReason(
        ssh2Error({ message: "connect EHOSTUNREACH 10.0.0.4:22", code: "EHOSTUNREACH" }),
      ),
    ).toBe("timeout");
    expect(
      classifySshUnreachableReason(
        ssh2Error({ message: "connect ENETUNREACH", code: "ENETUNREACH" }),
      ),
    ).toBe("timeout");
  });

  it("does not misclassify a hostname containing 'kex' as a handshake failure", () => {
    // Only the message carries "kex" (as part of the host); no handshake signal.
    expect(
      classifySshUnreachableReason(ssh2Error({ message: "connect to kex-gateway failed" })),
    ).toBe("unknown");
  });

  it("classifies ssh2's handshake-wait timeout as timeout, not handshake", () => {
    // ssh2's readyTimeout path reads "Timed out while waiting for handshake" —
    // the word "handshake" appears but the cause is a timeout.
    const err = ssh2Error({
      message: "Timed out while waiting for handshake",
      level: "client-timeout",
    });
    expect(classifySshUnreachableReason(err)).toBe("timeout");
  });

  it("classifies an auth rejection (client-authentication)", () => {
    const err = ssh2Error({
      message: "All configured authentication methods failed",
      level: "client-authentication",
    });
    expect(classifySshUnreachableReason(err)).toBe("auth");
  });

  it("classifies a genuine handshake/protocol failure", () => {
    const err = ssh2Error({
      message: "Handshake failed: no matching key exchange algorithm",
      level: "protocol",
    });
    expect(classifySshUnreachableReason(err)).toBe("handshake");
  });

  it("walks the cause chain to find the discriminating field", () => {
    const wrapped = ssh2Error({
      message: "connection failed",
      cause: ssh2Error({ message: "connect ECONNREFUSED", code: "ECONNREFUSED" }),
    });
    expect(classifySshUnreachableReason(wrapped)).toBe("connection_refused");
  });

  it("returns unknown when there is no cause", () => {
    expect(classifySshUnreachableReason(undefined)).toBe("unknown");
    expect(classifySshUnreachableReason(null)).toBe("unknown");
  });

  it("returns unknown for an unrecognised error", () => {
    expect(classifySshUnreachableReason(ssh2Error({ message: "something odd" }))).toBe("unknown");
  });

  it("tolerates a non-object cause", () => {
    expect(classifySshUnreachableReason("ECONNREFUSED string")).toBe("connection_refused");
  });

  it("every classification is a member of the exported taxonomy", () => {
    const reasons = [
      classifySshUnreachableReason(ssh2Error({ message: "ENOTFOUND", code: "ENOTFOUND" })),
      classifySshUnreachableReason(undefined),
    ];
    for (const reason of reasons) {
      expect(sshUnreachableReasonValues).toContain(reason);
    }
  });
});

describe("SshUnreachableError.reason", () => {
  it("derives the reason from the ssh2 cause", () => {
    const err = new SshUnreachableError(target, {
      cause: ssh2Error({ message: "getaddrinfo ENOTFOUND", code: "ENOTFOUND" }),
    });
    expect(err.reason).toBe("dns");
    expect(err.retriable).toBe(true);
  });

  it("is 'unknown' when constructed without a cause (mid-session drop)", () => {
    const err = new SshUnreachableError(target);
    expect(err.reason).toBe("unknown");
    expect(err.retriable).toBe(true);
  });
});
