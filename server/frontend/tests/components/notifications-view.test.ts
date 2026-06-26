/**
 * Smoke test for `NotificationsView` (#105). The CRUD-skeleton shape is proven
 * elsewhere; this suite targets the logic this view adds: pick-a-user →
 * load-and-hydrate the effective policy, the dirty-gating on Save, the
 * grace-bound validation, Save sending the three knobs, Reset → DELETE +
 * reload, and the custom-cadence surface (indicator + clear). The
 * `$lib/api/notifications` + `$lib/api/users` wrappers are mocked; the real
 * `ApiError` is used so the "already at defaults" 404 path is exercised.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/lib/api/client.js";
import type { NotificationPolicyResponse, UserResponse } from "../../src/lib/api/contract.js";

const listUsers = vi.fn<() => Promise<UserResponse[]>>();
const getNotificationPolicy = vi.fn<(userId: number) => Promise<NotificationPolicyResponse>>();
const upsertNotificationPolicy =
  vi.fn<(userId: number, input: unknown) => Promise<NotificationPolicyResponse>>();
const deleteNotificationPolicy = vi.fn<(userId: number) => Promise<void>>();

vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));
vi.mock("$lib/api/notifications", () => ({
  getNotificationPolicy: (userId: number) => getNotificationPolicy(userId),
  upsertNotificationPolicy: (userId: number, input: unknown) =>
    upsertNotificationPolicy(userId, input),
  deleteNotificationPolicy: (userId: number) => deleteNotificationPolicy(userId),
}));

const { default: NotificationsView } = await import(
  "../../src/lib/views/NotificationsView.svelte"
);

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Alice",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function policy(overrides: Partial<NotificationPolicyResponse> = {}): NotificationPolicyResponse {
  return {
    userId: 1,
    enabled: true,
    soundProfile: "subtle",
    graceSeconds: 15,
    cadenceOverrides: null,
    ...overrides,
  };
}

beforeEach(() => {
  listUsers.mockReset().mockResolvedValue([user()]);
  getNotificationPolicy.mockReset().mockResolvedValue(policy());
  upsertNotificationPolicy.mockReset().mockResolvedValue(policy());
  deleteNotificationPolicy.mockReset().mockResolvedValue();
  vi.spyOn(globalThis, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function selectUser(value = "1"): Promise<void> {
  await fireEvent.change(await screen.findByLabelText("User"), { target: { value } });
}

describe("NotificationsView", () => {
  it("prompts to add a user first when none exist", async () => {
    listUsers.mockResolvedValue([]);

    render(NotificationsView);

    expect(
      await screen.findByText(
        "Add a user first — notification settings always belong to a user.",
      ),
    ).toBeInTheDocument();
  });

  it("loads and hydrates the selected user's policy", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ enabled: false, soundProfile: "prominent", graceSeconds: 30 }),
    );

    render(NotificationsView);
    await selectUser();

    await waitFor(() => expect(getNotificationPolicy).toHaveBeenCalledWith(1));
    const enabled = (await screen.findByLabelText(
      "Notifications enabled",
    )) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect((screen.getByLabelText("Sound profile") as HTMLSelectElement).value).toBe("prominent");
    expect((screen.getByLabelText("Grace period seconds") as HTMLInputElement).value).toBe("30");
  });

  it("keeps Save disabled until a field changes, then PUTs the three knobs", async () => {
    upsertNotificationPolicy.mockResolvedValue(
      policy({ soundProfile: "prominent", graceSeconds: 30 }),
    );

    render(NotificationsView);
    await selectUser();

    const save = await screen.findByRole("button", { name: "Save" });
    // Unchanged form → no-op PUT is gated.
    expect(save).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Sound profile"), {
      target: { value: "prominent" },
    });
    await fireEvent.input(screen.getByLabelText("Grace period seconds"), {
      target: { value: "30" },
    });
    expect(save).toBeEnabled();

    await fireEvent.click(save);

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, {
      enabled: true,
      soundProfile: "prominent",
      graceSeconds: 30,
    });
    expect(await screen.findByText("Saved notification settings for Alice.")).toBeInTheDocument();
  });

  it("blocks Save and warns when the grace period is out of bounds", async () => {
    render(NotificationsView);
    await selectUser();
    await screen.findByLabelText("Grace period seconds");

    await fireEvent.input(screen.getByLabelText("Grace period seconds"), {
      target: { value: "999" },
    });

    expect(
      screen.getByText("Grace period must be a whole number between 0 and 60."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(upsertNotificationPolicy).not.toHaveBeenCalled();
  });

  it("resets to defaults via DELETE and reloads the effective policy", async () => {
    render(NotificationsView);
    await selectUser();
    await screen.findByRole("button", { name: "Reset to defaults" });

    getNotificationPolicy.mockClear();
    await fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    await waitFor(() => expect(deleteNotificationPolicy).toHaveBeenCalledWith(1));
    // The view reloads the now-default policy after a reset.
    expect(getNotificationPolicy).toHaveBeenCalledWith(1);
    expect(
      await screen.findByText("Reset Alice to the default notification settings."),
    ).toBeInTheDocument();
  });

  it("treats a 404 on reset as 'already at defaults' rather than an error", async () => {
    deleteNotificationPolicy.mockRejectedValue(
      new ApiError(404, "not_found", "no custom policy"),
    );

    render(NotificationsView);
    await selectUser();
    await fireEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));

    expect(
      await screen.findByText("Alice was already using the default settings."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a custom cadence and clears it with an explicit null", async () => {
    getNotificationPolicy.mockResolvedValue(
      policy({ cadenceOverrides: { "budget:1": { warnAt: [10] } } }),
    );
    upsertNotificationPolicy.mockResolvedValue(policy({ cadenceOverrides: null }));

    render(NotificationsView);
    await selectUser();

    const clear = await screen.findByRole("button", { name: "Clear custom cadence" });
    await fireEvent.click(clear);

    expect(upsertNotificationPolicy).toHaveBeenCalledWith(1, { cadenceOverrides: null });
    expect(
      await screen.findByText("Using the built-in 15/5/1-minute warning cadence."),
    ).toBeInTheDocument();
  });
});
