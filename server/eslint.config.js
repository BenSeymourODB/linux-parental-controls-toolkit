import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "frontend/", "drizzle/"] },
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
    // #11: non-request log sources use a named child logger (componentLogger),
    // never console.*. Scoped to src/ so tests/config keep their console use.
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
);
