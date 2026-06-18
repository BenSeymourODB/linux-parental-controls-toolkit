/**
 * Parser for `timekpra --userinfo USER` stdout.
 *
 * `timekpra` prints a user's configuration as a block of `KEY: VALUE` lines
 * (e.g. `TIME_LIMIT_PER_WEEK: 86400`). This module validates that shape with a
 * zod schema (so the facade's {@link ../ssh/facade.ts execAndParse} rejects
 * unparseable output as an `SshParseError` *before* it crosses into typed code,
 * per `CLAUDE.md` → "Validate all external input … subprocess stdout") and
 * exposes the parsed key/value pairs as a typed {@link TimekprUserInfo}.
 *
 * The parse is deliberately **key-agnostic**: it captures whatever `KEY: VALUE`
 * lines `timekpra` emits rather than asserting a fixed set of field names. The
 * exact key vocabulary is confirmed against the live CLI by the policy→Timekpr
 * mapping work (#140) when it reads specific fields back; until then this layer
 * guarantees only the line *grammar*, which is stable across the fields we set.
 *
 * License boundary: none touched — pure string parsing of subprocess stdout.
 */
import { z } from "zod";

/** A `KEY: VALUE` line: an uppercase/underscore/digit key, then the value. */
const KEY_VALUE_LINE = /^([A-Z0-9_]+):[ \t]?(.*)$/;

/**
 * The parsed result of `--userinfo`: the `KEY: VALUE` pairs `timekpra` printed.
 *
 * Immutable and key-agnostic — callers read fields by their `timekpra` key via
 * {@link get}. A later caller that depends on a specific field validates its
 * own value (e.g. parse a `;`-list of seconds); this type only guarantees the
 * key/value structure.
 */
export class TimekprUserInfo {
  readonly #fields: ReadonlyMap<string, string>;

  constructor(fields: ReadonlyMap<string, string>) {
    this.#fields = fields;
  }

  /** The raw string value for `key`, or `undefined` if `timekpra` omitted it. */
  get(key: string): string | undefined {
    return this.#fields.get(key);
  }

  /** Whether `timekpra` emitted a line for `key`. */
  has(key: string): boolean {
    return this.#fields.has(key);
  }

  /** Every key `timekpra` emitted, in the order encountered. */
  keys(): string[] {
    return [...this.#fields.keys()];
  }

  /** A plain snapshot of the parsed pairs (e.g. for logging or diffing). */
  toRecord(): Record<string, string> {
    return Object.fromEntries(this.#fields);
  }
}

/**
 * zod schema parsing raw `--userinfo` stdout into a {@link TimekprUserInfo}.
 *
 * Blank lines are ignored. At least one well-formed `KEY: VALUE` line must be
 * present, and a non-blank line that is *not* a `KEY: VALUE` pair fails the
 * parse — either signals output that isn't the userinfo block we expected
 * (so the caller gets an `SshParseError` rather than a half-empty struct).
 * A repeated key keeps the last value, matching how `timekpra` would emit it.
 */
export const timekprUserInfoSchema: z.ZodType<TimekprUserInfo, string> = z
  .string()
  .transform((raw, ctx) => {
    const fields = new Map<string, string>();
    let sawAny = false;
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim().length === 0) continue;
      const match = KEY_VALUE_LINE.exec(line);
      if (match === null) {
        ctx.addIssue({
          code: "custom",
          message: `timekpra --userinfo: expected "KEY: VALUE", got ${JSON.stringify(line)}`,
        });
        return z.NEVER;
      }
      sawAny = true;
      // Both capture groups are present whenever `exec` matched (group 2 is
      // `(.*)`, which always matches, possibly empty); the `?? ""` only
      // satisfies `noUncheckedIndexedAccess` and is never the value in practice.
      const [, key, value] = match;
      fields.set(key ?? "", value ?? "");
    }
    if (!sawAny) {
      ctx.addIssue({
        code: "custom",
        message: "timekpra --userinfo: no KEY: VALUE lines in output",
      });
      return z.NEVER;
    }
    return new TimekprUserInfo(fields);
  });
