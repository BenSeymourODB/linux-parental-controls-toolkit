/**
 * Smoke test for `ClientHealthView` — the operational view whose logic lives in
 * the enrol flow and the queue surface (#266): minting an enrolment token gates
 * on `enrolReady` (every supervised-user row complete + usernames distinct),
 * add/remove supervised-user rows, the install one-liner generated from the
 * minted token + the dashboard origin, the clipboard copy, and the collapsible
 * per-client queue. The health list itself is read-only. `$app/environment` is
 * mocked so `browser` is true (the view guards its fetches + clipboard on it),
 * and the three `$lib/api/*` wrappers are mocked — no live backend.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClientHealthResponse,
  EnrolmentTokenResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

vi.mock("$app/environment", () => ({ browser: true }));

const listClientHealth = vi.fn<() => Promise<ClientHealthResponse[]>>();
const mintEnrolmentToken = vi.fn<(input: unknown) => Promise<EnrolmentTokenResponse>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();

vi.mock("$lib/api/client-health", () => ({ listClientHealth: () => listClientHealth() }));
vi.mock("$lib/api/clients", () => ({
  mintEnrolmentToken: (input: unknown) => mintEnrolmentToken(input),
}));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));

const { default: ClientHealthView } = await import("../../src/lib/views/ClientHealthView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Chloe",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function health(overrides: Partial<ClientHealthResponse> = {}): ClientHealthResponse {
  return {
    clientId: 5,
    hostname: "mint-box",
    reachability: "online",
    lastSeen: "2026-06-20T10:00:00.000Z",
    enrolledAt: "2026-06-01T00:00:00.000Z",
    probedAt: "2026-06-20T10:00:00.000Z",
    components: [{ component: "timekpr-next", status: "ok", detail: "active" }],
    queue: { pending: 0, failed: 0, actions: [] },
    ...overrides,
  };
}

beforeEach(() => {
  listClientHealth.mockReset().mockResolvedValue([]);
  mintEnrolmentToken.mockReset();
  listUsers.mockReset().mockResolvedValue([user()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClientHealthView health list + queue", () => {
  it("renders a client card with reachability and component health", async () => {
    listClientHealth.mockResolvedValue([health()]);

    render(ClientHealthView);

    expect(await screen.findByText("mint-box")).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("Timekpr-nExT")).toBeInTheDocument(); // friendly label
  });

  it("expands and collapses the queued-actions detail", async () => {
    listClientHealth.mockResolvedValue([
      health({
        queue: {
          pending: 1,
          failed: 0,
          actions: [
            {
              id: 1,
              kind: "timekpra.settimeleft",
              coalesceKey: "k",
              status: "pending",
              attempts: 2,
              lastError: null,
              enqueuedAt: "2026-06-20T09:00:00.000Z",
              updatedAt: "2026-06-20T09:30:00.000Z",
            },
          ],
        },
      }),
    ]);

    render(ClientHealthView);
    await screen.findByText("mint-box");

    // Queue detail is collapsed until toggled.
    expect(screen.queryByText("timekpra.settimeleft")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Show queued actions/ }));
    expect(await screen.findByText("timekpra.settimeleft")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Hide queued actions/ }));
    await waitFor(() =>
      expect(screen.queryByText("timekpra.settimeleft")).not.toBeInTheDocument(),
    );
  });

  it("shows the empty state when no clients are enrolled", async () => {
    listClientHealth.mockResolvedValue([]);

    render(ClientHealthView);

    expect(
      await screen.findByText("No clients enrolled yet. Enrol one below."),
    ).toBeInTheDocument();
  });
});

describe("ClientHealthView enrol flow", () => {
  it("keeps mint disabled until every row is complete", async () => {
    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    const mint = screen.getByRole("button", { name: "Generate enrolment token" });
    expect(mint).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    // Username still blank → blocked.
    expect(mint).toBeDisabled();

    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    expect(mint).toBeEnabled();
  });

  it("blocks mint when two rows share an OS username", async () => {
    listUsers.mockResolvedValue([user({ id: 1, displayName: "Chloe" }), user({ id: 2, displayName: "Dana" })]);

    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    await fireEvent.click(screen.getByRole("button", { name: "+ Add another user" }));

    const userSelects = screen.getAllByLabelText("Supervised user");
    const usernameInputs = screen.getAllByLabelText("OS username");
    await fireEvent.change(userSelects[0], { target: { value: "1" } });
    await fireEvent.input(usernameInputs[0], { target: { value: "shared" } });
    await fireEvent.change(userSelects[1], { target: { value: "2" } });
    await fireEvent.input(usernameInputs[1], { target: { value: "shared" } }); // duplicate

    expect(screen.getByRole("button", { name: "Generate enrolment token" })).toBeDisabled();

    // Make the second username distinct → unblocked.
    await fireEvent.input(usernameInputs[1], { target: { value: "dana" } });
    expect(screen.getByRole("button", { name: "Generate enrolment token" })).toBeEnabled();
  });

  it("removes an added supervised-user row", async () => {
    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    await fireEvent.click(screen.getByRole("button", { name: "+ Add another user" }));
    expect(screen.getAllByLabelText("OS username")).toHaveLength(2);

    // With >1 row, every row shows its own Remove button — drop the first.
    await fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(screen.getAllByLabelText("OS username")).toHaveLength(1);
  });

  it("mints a token and renders the install one-liner with the token + supervised users", async () => {
    mintEnrolmentToken.mockResolvedValue({
      id: 1,
      token: "tok_secret123",
      expiresAt: "2026-06-23T12:00:00.000Z",
    });

    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    await fireEvent.click(screen.getByRole("button", { name: "Generate enrolment token" }));

    await waitFor(() => expect(mintEnrolmentToken).toHaveBeenCalledOnce());
    // Default TTL + a single supervised user; no hostname provided.
    expect(mintEnrolmentToken).toHaveBeenCalledWith({
      supervisedUsers: [{ userId: 1, osUsername: "chloe" }],
      ttlSeconds: 3600,
    });

    // The rendered command embeds the minted token, the server origin, and the
    // --supervised-user flag.
    const command = await screen.findByText(/install-client\.sh/);
    expect(command.textContent).toContain("--enrolment-token tok_secret123");
    expect(command.textContent).toContain("--supervised-user chloe");
    expect(command.textContent).toContain(window.location.origin);
  });

  it("includes the hostname flag when an expected hostname is given", async () => {
    mintEnrolmentToken.mockResolvedValue({
      id: 1,
      token: "tok_x",
      expiresAt: "2026-06-23T12:00:00.000Z",
    });

    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    await fireEvent.input(screen.getByLabelText("Expected hostname"), {
      target: { value: "kids-laptop" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Generate enrolment token" }));

    await waitFor(() =>
      expect(mintEnrolmentToken).toHaveBeenCalledWith({
        supervisedUsers: [{ userId: 1, osUsername: "chloe" }],
        ttlSeconds: 3600,
        hostname: "kids-laptop",
      }),
    );
  });

  it("copies the install command to the clipboard", async () => {
    mintEnrolmentToken.mockResolvedValue({
      id: 1,
      token: "tok_clip",
      expiresAt: "2026-06-23T12:00:00.000Z",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    await fireEvent.click(screen.getByRole("button", { name: "Generate enrolment token" }));

    const copy = await screen.findByRole("button", { name: "Copy command" });
    await fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("--enrolment-token tok_clip");
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("surfaces a mint error inline without leaving the form", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    mintEnrolmentToken.mockRejectedValue(new ApiError(409, "conflict", "Token mint failed."));

    render(ClientHealthView);
    await screen.findByRole("heading", { name: "Enrol a new client" });

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    await fireEvent.click(screen.getByRole("button", { name: "Generate enrolment token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Token mint failed.");
    // The form is still present (the minted panel never replaced it).
    expect(screen.getByRole("button", { name: "Generate enrolment token" })).toBeInTheDocument();
  });
});
