/**
 * Smoke test for the `/app` per-user PIN login (#112).
 *
 * Renders the real `/app` page orchestrator (`routes/app/+page.svelte`) against
 * a mocked `$lib/api/app-session` (no live backend) and drives the
 * probe → PIN-entry → signed-in → sign-out cycle, plus the failed-PIN and
 * lockout paths.
 *
 * `$app/environment` is mocked so `browser` is true — the page guards its
 * session probe and every `/api` call to the browser, so without this the probe
 * would short-circuit.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/lib/api/client.js";
import type { PinLoginRequest, PinSessionResponse } from "../../src/lib/api/contract.js";

vi.mock("$app/environment", () => ({ browser: true }));

const fetchAppSession = vi.fn<() => Promise<PinSessionResponse>>();
const pinLogin = vi.fn<(body: PinLoginRequest) => Promise<PinSessionResponse>>();
const pinLogout = vi.fn<() => Promise<PinSessionResponse>>();

vi.mock("$lib/api/app-session", () => ({
  fetchAppSession: () => fetchAppSession(),
  pinLogin: (body: PinLoginRequest) => pinLogin(body),
  pinLogout: () => pinLogout(),
}));

// The signed-in state renders `AppStatusView` (#110), which fetches its own
// status. Stub it so this page-orchestrator test stays about the session cycle,
// not the status content (that has its own component test). A never-resolving
// stub keeps the child in its harmless loading state.
vi.mock("$lib/api/app-status", () => ({
  fetchAppStatus: () => new Promise(() => {}),
}));

// Imported after the mocks are registered so the page picks up the mocked client.
const { default: AppPage } = await import("../../src/routes/app/+page.svelte");

beforeEach(() => {
  fetchAppSession.mockReset();
  pinLogin.mockReset();
  pinLogout.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/app PIN login", () => {
  it("shows the PIN form when the session probe reports unauthenticated", async () => {
    fetchAppSession.mockResolvedValue({ authenticated: false });

    render(AppPage);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("User number")).toBeInTheDocument();
    expect(screen.getByLabelText("PIN")).toBeInTheDocument();
    expect(fetchAppSession).toHaveBeenCalledOnce();
  });

  it("stays signed in (skips the form) when the probe finds a valid session", async () => {
    fetchAppSession.mockResolvedValue({ authenticated: true, user: { id: 7, displayName: "Alice" } });

    render(AppPage);

    // Signed-in state is the page's own "Sign out" control (the greeting now
    // lives inside AppStatusView, covered by its own test).
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("swaps to the signed-in state after a correct PIN, sending userId as a number", async () => {
    fetchAppSession.mockResolvedValue({ authenticated: false });
    pinLogin.mockResolvedValue({ authenticated: true, user: { id: 7, displayName: "Alice" } });

    render(AppPage);
    await screen.findByRole("button", { name: "Sign in" });

    await fireEvent.input(screen.getByLabelText("User number"), { target: { value: "7" } });
    await fireEvent.input(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(pinLogin).toHaveBeenCalledWith({ userId: 7, pin: "1234" });
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("surfaces a wrong PIN inline and stays on the form", async () => {
    fetchAppSession.mockResolvedValue({ authenticated: false });
    pinLogin.mockRejectedValue(new ApiError(401, "invalid_credentials", "Invalid user or PIN"));

    render(AppPage);
    await screen.findByRole("button", { name: "Sign in" });

    await fireEvent.input(screen.getByLabelText("User number"), { target: { value: "7" } });
    await fireEvent.input(screen.getByLabelText("PIN"), { target: { value: "0000" } });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("didn't match");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows a wait-and-retry message when locked out (429)", async () => {
    fetchAppSession.mockResolvedValue({ authenticated: false });
    pinLogin.mockRejectedValue(new ApiError(429, "too_many_requests", "Too many failed PIN attempts"));

    render(AppPage);
    await screen.findByRole("button", { name: "Sign in" });

    await fireEvent.input(screen.getByLabelText("User number"), { target: { value: "7" } });
    await fireEvent.input(screen.getByLabelText("PIN"), { target: { value: "0000" } });
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tries");
  });

  it("returns to the PIN form after signing out", async () => {
    fetchAppSession.mockResolvedValue({ authenticated: true, user: { id: 7, displayName: "Alice" } });
    pinLogout.mockResolvedValue({ authenticated: false });

    render(AppPage);
    await screen.findByRole("button", { name: "Sign out" });

    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument());
    expect(pinLogout).toHaveBeenCalledOnce();
  });
});
