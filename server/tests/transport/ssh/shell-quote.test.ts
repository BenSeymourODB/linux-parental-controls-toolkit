/**
 * The SSH facade builds the command string SSH carries by single-quoting every
 * argv element. These tests pin that quoting so a future "optimisation" can't
 * silently reintroduce shell interpretation of argument text (the license- and
 * safety-critical seam — see `src/transport/ssh/shell-quote.ts`).
 */
import { describe, expect, it } from "vitest";

import { shellQuoteCommand } from "../../../src/transport/ssh/shell-quote.js";

describe("shellQuoteCommand", () => {
  it("quotes a bare command with no arguments", () => {
    expect(shellQuoteCommand(["timekpra"])).toBe("'timekpra'");
  });

  it("quotes each argument independently", () => {
    expect(shellQuoteCommand(["timekpra", "--gettimelimits", "alice"])).toBe(
      "'timekpra' '--gettimelimits' 'alice'",
    );
  });

  it("keeps whitespace inside a single argument as one token", () => {
    expect(shellQuoteCommand(["echo", "a b\tc"])).toBe("'echo' 'a b\tc'");
  });

  it("escapes embedded single quotes with the close/escape/reopen idiom", () => {
    // x'y -> 'x'\''y'
    expect(shellQuoteCommand(["echo", "x'y"])).toBe("'echo' 'x'\\''y'");
  });

  it("renders an empty-string argument as an empty quoted token", () => {
    expect(shellQuoteCommand(["echo", ""])).toBe("'echo' ''");
  });

  it("neutralises shell metacharacters so they reach the program literally", () => {
    const argv = ["sh", "-c", "x; rm -rf / && $(whoami) `id` | tee /etc/x"];
    const quoted = shellQuoteCommand(argv);
    // The whole dangerous payload lands inside one single-quoted token, so the
    // remote shell sees it as a literal argument to `sh`, not as operators.
    expect(quoted).toBe("'sh' '-c' 'x; rm -rf / && $(whoami) `id` | tee /etc/x'");
  });

  it("keeps a newline inside the quoted token rather than splitting commands", () => {
    expect(shellQuoteCommand(["printf", "line1\nline2"])).toBe("'printf' 'line1\nline2'");
  });

  it("throws on an empty argv (no command to run)", () => {
    expect(() => shellQuoteCommand([])).toThrow(RangeError);
  });
});
