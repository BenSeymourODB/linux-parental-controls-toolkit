/**
 * `ClientConnectionVerifier` — the post-enrol connectivity self-test (#354).
 *
 * Enrolment is client→server HTTP only: `POST /api/clients/enrol` proves the
 * *client can reach the dashboard*, but nothing proves the *dashboard can reach
 * the client over SSH* — the direction every push, probe, and telemetry pull
 * actually uses. In the v0.1.0-alpha.5 incident three clients "enrolled
 * successfully" for days while that server→client path had never once worked.
 * This verifier closes that gap with a real round-trip.
 *
 * The check is deliberately the *cheapest* thing that exercises the whole ladder
 * — resolve → TCP connect → SSH auth + a trivial `exec true`. The SSH facade
 * already collapses those failure modes into one {@link SshUnreachableError}
 * whose classified {@link SshUnreachableReason} (#353) discriminates `dns` /
 * `connection_refused` / `timeout` / `auth` / `handshake` / `unknown`, each with
 * a different operator fix — so verification is a thin classified wrapper over a
 * single `true` exec, the same primitive the offline-queue's dead-host skip
 * (`sshReachabilityProbe`) uses, returning the classified outcome rather than a
 * bare boolean.
 *
 * Built against an injected SSH seam (like the prober and the offline-queue) so
 * it unit-tests without a live client; the concrete wiring (the dashboard's SSH
 * key) is plumbed by the first-run SSH-key bootstrap (#39). Uses the transport's
 * *un-audited* surface: a liveness `true` is data, not an admin command, so it
 * must not flood the audit log the way the `timekpra` pushes deliberately do.
 *
 * License boundary: none touched — the verifier only *execs* `true` over the
 * existing SSH subprocess facade; no GPL code is linked in-process and no
 * REST/subprocess boundary is collapsed.
 */
import type { ClientRow } from "../../policy/repository.js";
import {
  SshError,
  SshExecTimeoutError,
  SshUnreachableError,
  type SshUnreachableReason,
} from "../ssh/errors.js";
import {
  targetFromClient,
  type ExecOptions,
  type ExecResult,
  type SshCredentials,
  type SshTarget,
} from "../ssh/facade.js";

/** The outcome of one connectivity verification. */
export interface ConnectionVerification {
  /** Whether the server reached the client over SSH on this run. */
  readonly reachable: boolean;
  /**
   * The classified SSH failure cause (#353) when {@link reachable} is `false`,
   * else `null`. Lets the installer print a class-specific remediation hint
   * (DNS vs refused vs timeout vs auth) rather than one catch-all string.
   */
  readonly reason: SshUnreachableReason | null;
  /** A human-readable detail line (the underlying `ssh2`/socket message, or a success note). */
  readonly detail: string;
  /** When the verification ran (drives `last_verified_at` / the `last_seen` bump). */
  readonly at: Date;
}

/**
 * Verifies that the dashboard can reach one enrolled client over SSH. Injected
 * into the verify-connection route so it is testable without SSH and so the live
 * SSH wiring can be supplied (or withheld, pre-#39) at bootstrap.
 */
export interface ClientConnectionVerifier {
  /**
   * `id` is optional so a caller can verify by address alone, but the route
   * always passes the full authenticated client row.
   */
  verify(
    client: Pick<ClientRow, "hostname" | "sshUser"> & { readonly id?: number },
  ): Promise<ConnectionVerification>;
}

/**
 * The slice of the SSH transport the verifier needs: a single *unchecked*
 * `exec` (a `true` that runs is success; the connection failures are the SSH
 * error taxonomy). Declared structurally so the real `SshTransport` satisfies it
 * and tests pass a lightweight fake without an `as` cast — same pattern as
 * {@link HealthProbeTransport} / `TimekprTransport`.
 */
export interface VerifyTransport {
  exec(target: SshTarget, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

/**
 * The slice of a structured logger the verifier uses: one `warn` per failed
 * verification. Structural so any compatible logger — or a test spy — satisfies
 * it without an import or an `as` cast.
 */
export interface VerifyLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/** Construction options for {@link SshClientConnectionVerifier}. */
export interface SshClientConnectionVerifierOptions {
  /** Per-exec overrides (e.g. a tighter `timeoutMs`) forwarded to the transport. */
  readonly execOptions?: ExecOptions;
  /** Clock for `result.at`; overridable in tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Optional structured logger. When set, one `warn` is emitted per failed
   * verification with `{ clientId?, host, port, reason, cause }` (#353) so an
   * unreachable client's root cause is captured in the server logs too.
   */
  readonly log?: VerifyLogger;
}

/**
 * The underlying `ssh2`/socket message behind a thrown error, for the detail /
 * log line. An {@link SshUnreachableError} carries the discriminating text on
 * its `cause`; with no cause there is nothing more informative than the reason.
 */
function causeText(error: unknown): string {
  if (error instanceof SshUnreachableError) {
    if (error.cause === undefined || error.cause === null) return "";
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a verification failure into its reason + a human detail (#353). An
 * {@link SshUnreachableError} carries its own classified reason; an
 * {@link SshExecTimeoutError} (the box answered but `true` hung — practically
 * unreachable) is a `timeout`; any other {@link SshError} degrades to `unknown`.
 */
function describeFailure(error: SshError): { reason: SshUnreachableReason; detail: string } {
  const reason: SshUnreachableReason =
    error instanceof SshUnreachableError
      ? error.reason
      : error instanceof SshExecTimeoutError
        ? "timeout"
        : "unknown";
  const cause = causeText(error);
  const detail =
    cause === ""
      ? `SSH verification failed (${reason})`
      : `SSH verification failed (${reason}: ${cause})`;
  return { reason, detail };
}

/**
 * Verifies clients over the SSH facade. One instance is shared across the
 * dashboard (it reuses the transport's connection pool).
 */
export class SshClientConnectionVerifier implements ClientConnectionVerifier {
  readonly #transport: VerifyTransport;
  readonly #credentials: SshCredentials;
  readonly #execOptions: ExecOptions | undefined;
  readonly #now: () => Date;
  readonly #log: VerifyLogger | undefined;

  /**
   * @param transport the SSH transport (or a structural stand-in) to verify over.
   * @param credentials the dashboard's SSH key material (from #39's bootstrap).
   * @param options per-exec overrides, an injectable clock, and an optional logger.
   */
  constructor(
    transport: VerifyTransport,
    credentials: SshCredentials,
    options: SshClientConnectionVerifierOptions = {},
  ) {
    this.#transport = transport;
    this.#credentials = credentials;
    this.#execOptions = options.execOptions;
    this.#now = options.now ?? ((): Date => new Date());
    this.#log = options.log;
  }

  async verify(
    client: Pick<ClientRow, "hostname" | "sshUser"> & { readonly id?: number },
  ): Promise<ConnectionVerification> {
    const target = targetFromClient(client, this.#credentials);
    const at = this.#now();
    try {
      await this.#transport.exec(target, ["true"], this.#execOptions);
      return { reachable: true, reason: null, detail: "SSH round-trip succeeded", at };
    } catch (error) {
      // `exec` only rejects with the SSH error taxonomy (unreachable / timed
      // out); anything else is an unexpected bug and must surface, never
      // masquerade as "unreachable".
      if (error instanceof SshError) {
        const { reason, detail } = describeFailure(error);
        this.#log?.warn(
          {
            ...(client.id === undefined ? {} : { clientId: client.id }),
            host: target.host,
            port: target.port ?? 22,
            reason,
            ...(detail === "" ? {} : { detail }),
          },
          "client connectivity verification failed",
        );
        return { reachable: false, reason, detail, at };
      }
      throw error;
    }
  }
}
