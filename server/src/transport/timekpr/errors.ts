/**
 * Builder-side error for the `timekpra` command layer.
 *
 * This is distinct from the SSH facade's runtime taxonomy
 * (`SshUnreachableError` / `SshCommandError` / `SshParseError` /
 * `SshExecTimeoutError`, see `../ssh/errors.ts`): those describe what happened
 * when a command *ran* over SSH, and the `timekpra` client lets them propagate
 * unchanged. {@link TimekprArgumentError}, by contrast, is raised
 * **synchronously, before any SSH call**, when a caller hands a builder a value
 * the `timekpra` CLI grammar cannot represent (a negative duration, an
 * out-of-range weekday/hour/minute, an empty PlayTime mask, …). Catching it
 * early keeps a malformed invocation from ever reaching a client.
 *
 * License boundary: none touched — plain TypeScript; no GPL code is linked.
 */

/** A value handed to a `timekpra` command builder is outside the CLI grammar. */
export class TimekprArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimekprArgumentError";
  }
}
