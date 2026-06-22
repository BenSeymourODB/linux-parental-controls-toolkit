/**
 * Component-test setup: registers `@testing-library/jest-dom`'s custom
 * matchers (`toBeInTheDocument`, `toBeDisabled`, …) on Vitest's `expect`, and
 * pulls in `@testing-library/svelte/vitest` so each rendered component is
 * unmounted automatically after every test.
 */
import "@testing-library/jest-dom/vitest";
import "@testing-library/svelte/vitest";
