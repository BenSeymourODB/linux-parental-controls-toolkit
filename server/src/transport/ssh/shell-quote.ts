/**
 * POSIX shell-quoting for argv vectors sent over SSH.
 *
 * SSH's "exec" request carries a single command *string* that the remote
 * login shell interprets — there is no argv-vector channel the way
 * `execFile` gives us locally. To honour the transport contract ("arguments
 * passed as a vector, no shell string interpolation"; see issue #82 and
 * `CLAUDE.md` → "License boundaries"), the facade never concatenates raw
 * argument text into the command line. Instead every element is wrapped in
 * single quotes here, so the remote shell performs **no** word-splitting,
 * globbing, variable/command substitution, or operator parsing on it.
 *
 * Single quotes disable every shell metacharacter except `'` itself, which
 * cannot appear inside a single-quoted string; the standard idiom closes the
 * quote, emits an escaped literal quote (`'\''`), and reopens — so a value
 * like `it's` becomes `'it'\''s'`. The result is a command string that is
 * safe to hand to `ssh2`'s `exec`, with each original argv element delivered
 * verbatim to the remote program.
 */

/** A single shell-safe token: `''` for empty, else a single-quoted literal. */
function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Render an argv vector as one POSIX-shell-safe command string.
 *
 * The first element is the executable; the rest are its positional
 * arguments. Each token is single-quoted ({@link quoteArg}) so the remote
 * shell cannot reinterpret spaces, `;`, `$(…)`, backticks, `&&`, redirections,
 * globs, or newlines embedded in any argument.
 *
 * @throws RangeError if `argv` is empty — there is no command to run.
 */
export function shellQuoteCommand(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new RangeError("shellQuoteCommand requires a non-empty argv (the command to run)");
  }
  return argv.map(quoteArg).join(" ");
}
