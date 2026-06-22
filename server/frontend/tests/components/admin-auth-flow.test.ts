/**
 * Smoke test for the `/admin` auth flow (#53's last acceptance box).
 *
 * Renders the real admin page orchestrator (`routes/admin/+page.svelte`)
 * against a mocked `$lib/api/auth` (no live backend) and drives the full
 * login → authenticated shell → logout cycle, plus the unauthenticated-probe
 * redirect that stands in for the server's `requireAdmin` guard.
 *
 * `$app/environment` is mocked so `browser` is true — the page guards its
 * session probe and every `/api` call to the browser (it prerenders to a
 * static shell in Node), so without this the probe would short-circuit.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionResponse } from "../../src/lib/api/contract.js";

vi.mock("$app/environment", () => ({ browser: true }));

// The page imports these three from `$lib/api/auth`; the mock lets each test
// decide what the server "would" answer without any network.
const fetchSession = vi.fn<() => Promise<SessionResponse>>();
const login = vi.fn<(body: { username: string; password: string }) => Promise<SessionResponse>>();
const logout = vi.fn<() => Promise<SessionResponse>>();

vi.mock("$lib/api/auth", () => ({
  fetchSession: () => fetchSession(),
  login: (body: { username: string; password: string }) => login(body),
  logout: () => logout(),
}));

// Imported after the mocks are registered so the page picks up the mocked auth.
const { default: AdminPage } = await import("../../src/routes/admin/+page.svelte");

beforeEach(() => {
  fetchSession.mockReset();
  login.mockReset();
  logout.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/admin auth flow", () => {
  it("shows the login form when the session probe reports unauthenticated", async () => {
    fetchSession.mockResolvedValue({ authenticated: false });

    render(AdminPage);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to the admin dashboard")).toBeInTheDocument();
    // No authenticated shell controls are present.
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(fetchSession).toHaveBeenCalledOnce();
  });

  it("swaps to the authenticated shell after a successful login", async () => {
    fetchSession.mockResolvedValue({ authenticated: false });
    login.mockResolvedValue({ authenticated: true, username: "admin" });

    render(AdminPage);
    await screen.findByRole("button", { name: "Sign in" });

    await fireEvent.input(screen.getByLabelText("Username", { selector: "input" }), {
      target: { value: "admin" },
    });
    await fireEvent.input(screen.getByLabelText("Password", { selector: "input" }), {
      target: { value: "hunter2" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // The shell (sidebar logout + dashboard greeting) replaces the login form.
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByText("Welcome, admin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(login).toHaveBeenCalledWith({ username: "admin", password: "hunter2" });
  });

  it("surfaces a failed login inline and stays on the login form", async () => {
    fetchSession.mockResolvedValue({ authenticated: false });
    const { ApiError } = await import("../../src/lib/api/client.js");
    login.mockRejectedValue(new ApiError(401, "unauthorized", "Invalid credentials."));

    render(AdminPage);
    await screen.findByRole("button", { name: "Sign in" });

    await fireEvent.input(screen.getByLabelText("Username", { selector: "input" }), {
      target: { value: "admin" },
    });
    await fireEvent.input(screen.getByLabelText("Password", { selector: "input" }), {
      target: { value: "wrong" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid credentials.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("returns to the login form after logout", async () => {
    fetchSession.mockResolvedValue({ authenticated: true, username: "admin" });
    logout.mockResolvedValue({ authenticated: false });

    render(AdminPage);

    // Starts authenticated (probe reports a live session).
    await screen.findByRole("button", { name: "Sign out" });

    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(logout).toHaveBeenCalledOnce();
  });
});
