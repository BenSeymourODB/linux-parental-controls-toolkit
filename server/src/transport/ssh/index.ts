/**
 * SSH transport: opens key-authenticated `ssh2` sessions to enrolled clients
 * and execs commands as subprocesses on the remote box.
 *
 * License boundary: never link Timekpr-nExT (or any GPL tool) code
 * in-process — we only run the CLI over SSH and parse its stdout. See
 * `docs/licensing-analysis.md` and `./facade.ts`.
 */
export const moduleName = "transport/ssh";

export {
  SshError,
  SshUnreachableError,
  SshCommandError,
  SshParseError,
  SshExecTimeoutError,
  formatTarget,
  type SshTargetRef,
} from "./errors.js";
export {
  SshTransport,
  targetFromClient,
  type SshTarget,
  type SshCredentials,
  type ExecResult,
  type ExecOptions,
  type SshTransportOptions,
  type PortForwardTarget,
  type PortForwardOptions,
} from "./facade.js";
export { shellQuoteCommand } from "./shell-quote.js";
export { loadSshCredentials } from "./credentials.js";
