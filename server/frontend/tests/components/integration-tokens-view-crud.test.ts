/**
 * Flow test for `IntegrationTokensView` (#250).
 *
 * Mirrors `clients-view-crud.test.ts`: renders the real component against a
 * mocked `$lib/api/integration-tokens` (no live backend) and exercises the
 * highest-value flows — list, empty state, mint-with-once-only-secret, revoke
 * (confirmed + declined), and the inline error surfaces.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IntegrationTokenCreatedResponse,
  IntegrationTokenSummaryResponse,
} from "../../src/lib/api/contract.js";

const listIntegrationTokens = vi.fn<() => Promise<IntegrationTokenSummaryResponse[]>>();
const createIntegrationToken =
  vi.fn<(input: unknown) => Promise<IntegrationTokenCreatedResponse>>();
const revokeIntegrationToken =
  vi.fn<(id: number) => Promise<IntegrationTokenSummaryResponse>>();

vi.mock("$lib/api/integration-tokens", () => ({
  listIntegrationTokens: () => listIntegrationTokens(),
  createIntegrationToken: (input: unknown) => createIntegrationToken(input),
  revokeIntegrationToken: (id: number) => revokeIntegrationToken(id),
}));

const { default: IntegrationTokensView } = await import(
  "../../src/lib/views/IntegrationTokensView.svelte"
);

function summary(
  overrides: Partial<IntegrationTokenSummaryResponse> = {},
): IntegrationTokenSummaryResponse {
  return {
    id: 1,
    name: "calendar",
    scopes: ["grants:write"],
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  } as IntegrationTokenSummaryResponse;
}

beforeEach(() => {
  listIntegrationTokens.mockReset();
  createIntegrationToken.mockReset();
  revokeIntegrationToken.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IntegrationTokensView", () => {
  it("renders the tokens returned by the API", async () => {
    listIntegrationTokens.mockResolvedValue([summary({ id: 1, name: "calendar" })]);

    render(IntegrationTokensView);

    expect(await screen.findByText("calendar")).toBeInTheDocument();
    expect(listIntegrationTokens).toHaveBeenCalledOnce();
  });

  it("shows the empty state when there are no tokens", async () => {
    listIntegrationTokens.mockResolvedValue([]);

    render(IntegrationTokensView);

    expect(
      await screen.findByText("No integration tokens yet. Mint one above."),
    ).toBeInTheDocument();
  });

  it("mints a token, reveals the secret once, and appends the row", async () => {
    listIntegrationTokens.mockResolvedValue([]);
    createIntegrationToken.mockResolvedValue({
      id: 7,
      name: "home-assistant",
      scopes: ["policy:read"],
      secret: "PCT-secret-abcdef",
      createdAt: "2026-06-02T00:00:00.000Z",
    });

    render(IntegrationTokensView);
    await screen.findByText("No integration tokens yet. Mint one above.");

    await fireEvent.input(screen.getByLabelText("New token name"), {
      target: { value: "home-assistant" },
    });
    await fireEvent.click(screen.getByLabelText("Scope policy:read"));
    await fireEvent.click(screen.getByRole("button", { name: "Mint token" }));

    // The plaintext secret is shown once, with the "shown once" warning.
    expect(await screen.findByText("PCT-secret-abcdef")).toBeInTheDocument();
    expect(screen.getByText(/shown/i)).toBeInTheDocument();
    expect(createIntegrationToken).toHaveBeenCalledWith({
      name: "home-assistant",
      scopes: ["policy:read"],
    });
    // The new token also appears as a row.
    const table = screen.getByRole("table");
    expect(within(table).getByText("home-assistant")).toBeInTheDocument();
  });

  it("revokes a token after confirmation and shows the revoked badge", async () => {
    listIntegrationTokens.mockResolvedValue([summary({ id: 1, name: "calendar" })]);
    revokeIntegrationToken.mockResolvedValue(
      summary({ id: 1, name: "calendar", revokedAt: "2026-06-03T00:00:00.000Z" }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(IntegrationTokensView);
    await screen.findByText("calendar");

    await fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(revokeIntegrationToken).toHaveBeenCalledWith(1);
    // The revoke action is gone once revoked.
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("does not revoke when the confirmation is declined", async () => {
    listIntegrationTokens.mockResolvedValue([summary({ id: 1, name: "calendar" })]);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(IntegrationTokensView);
    await screen.findByText("calendar");

    await fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(revokeIntegrationToken).not.toHaveBeenCalled();
    expect(screen.getByText("calendar")).toBeInTheDocument();
  });

  it("surfaces an ApiError from the list load in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listIntegrationTokens.mockRejectedValue(new ApiError(500, "internal", "The server exploded."));

    render(IntegrationTokensView);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server exploded.");
  });

  it("keeps a mint error inline without losing the existing rows", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    listIntegrationTokens.mockResolvedValue([summary({ id: 1, name: "calendar" })]);
    createIntegrationToken.mockRejectedValue(new ApiError(409, "conflict", "That name is taken."));

    render(IntegrationTokensView);
    await screen.findByText("calendar");

    await fireEvent.input(screen.getByLabelText("New token name"), {
      target: { value: "calendar" },
    });
    await fireEvent.click(screen.getByLabelText("Scope grants:write"));
    await fireEvent.click(screen.getByRole("button", { name: "Mint token" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That name is taken.");
    const table = screen.getByRole("table");
    expect(within(table).getByText("calendar")).toBeInTheDocument();
  });
});
