import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Mirrors server/eslint.config.js — same strict TypeScript posture
// (CLAUDE.md → "Code conventions"). The bridge is a separate package
// (it ships in the .deb with its own bundled Node runtime) so it carries
// its own flat config rather than reaching across to the server's.
export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  eslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  {
    rules: {
      // CLAUDE.md: no `any`, no @ts-ignore (use @ts-expect-error with a reason).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description" },
      ],
    },
  },
  {
    // Daemon log output goes through the logger module (process.std{out,err},
    // captured by the systemd journal), never raw console.* — matching the
    // server's no-console-in-src discipline (#11). Tests/config keep console.
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
);
