/**
 * Component test for the Dashboard system-service status strip (#321).
 *
 * Drives the real `SystemStatusStrip` component against a mocked
 * `$lib/api/system` (no live backend), following the established
 * `tests/components/*` pattern. Exercises the behaviour the component owns:
 * loading both statuses on mount, mapping each service state to a colour tone,
 * hiding the AdGuard pill when managed mode is disabled, surfacing the `detail`
 * (plus a non-zero restart count) of non-green services on click, and showing a
 * red error pill when a status fetch fails.
 */
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdGuardManagedStatusResponse,
  AnsibleVenvStatusResponse,
} from "../../src/lib/api/contract.js";

const fetchAnsibleStatus = vi.fn<() => Promise<AnsibleVenvStatusResponse>>();
const fetchAdGuardManagedStatus = vi.fn<() => Promise<AdGuardManagedStatusResponse>>();

vi.mock("$lib/api/system", () => ({
  fetchAnsibleStatus: () => fetchAnsibleStatus(),
  fetchAdGuardManagedStatus: () => fetchAdGuardManagedStatus(),
}));

const { default: SystemStatusStrip } = await import(
  "../../src/lib/components/SystemStatusStrip.svelte"
);

function ansible(overrides: Partial<AnsibleVenvStatusResponse> = {}): AnsibleVenvStatusResponse {
  return {
    state: "ready",
    checkedAt: "2026-01-01T00:00:00.000Z",
    detail: null,
    ...overrides,
  } as AnsibleVenvStatusResponse;
}

function adguardDisabled(): AdGuardManagedStatusResponse {
  return {
    enabled: false,
    state: null,
    version: null,
    restarts: null,
    checkedAt: null,
    detail: null,
  } as AdGuardManagedStatusResponse;
}

function adguard(overrides: Partial<AdGuardManagedStatusResponse> = {}): AdGuardManagedStatusResponse {
  return {
    enabled: true,
    state: "running",
    version: "0.107.0",
    restarts: 0,
    checkedAt: "2026-01-01T00:00:00.000Z",
    detail: null,
    ...overrides,
  } as AdGuardManagedStatusResponse;
}

/** The `.pill` element that wraps a service label. */
function pillFor(label: string): HTMLElement {
  const name = screen.getByText(label);
  const pill = name.closest(".pill");
  if (!(pill instanceof HTMLElement)) {
    throw new Error(`no .pill ancestor for "${label}"`);
  }
  return pill;
}

beforeEach(() => {
  fetchAnsibleStatus.mockReset().mockResolvedValue(ansible());
  fetchAdGuardManagedStatus.mockReset().mockResolvedValue(adguardDisabled());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SystemStatusStrip (#321)", () => {
  it("shows Ansible ready as a green, non-interactive pill", async () => {
    render(SystemStatusStrip);

    const label = await screen.findByText("Ansible");
    expect(pillFor("Ansible")).toHaveClass("tone-green");
    // A green pill is not a button — nothing to expand.
    expect(label.closest("button")).toBeNull();
    // AdGuard managed mode is disabled → its pill is hidden entirely.
    expect(screen.queryByText("AdGuard Home")).not.toBeInTheDocument();
  });

  it("shows Ansible bootstrapping as amber", async () => {
    fetchAnsibleStatus.mockResolvedValue(ansible({ state: "bootstrapping" }));
    render(SystemStatusStrip);

    await screen.findByText("Ansible");
    expect(pillFor("Ansible")).toHaveClass("tone-amber");
    expect(screen.getByText("Bootstrapping")).toBeInTheDocument();
  });

  it("shows Ansible unavailable as red and expands its detail on click", async () => {
    fetchAnsibleStatus.mockResolvedValue(
      ansible({ state: "unavailable", detail: "pip install failed: no network" }),
    );
    render(SystemStatusStrip);

    const button = await screen.findByRole("button", { name: /Ansible/ });
    expect(pillFor("Ansible")).toHaveClass("tone-red");
    // Detail is collapsed until the pill is clicked.
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    await fireEvent.click(button);
    expect(screen.getByRole("note")).toHaveTextContent("pip install failed: no network");

    // Clicking again collapses it.
    await fireEvent.click(button);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("shows a running managed AdGuard as green", async () => {
    fetchAdGuardManagedStatus.mockResolvedValue(adguard({ state: "running" }));
    render(SystemStatusStrip);

    await screen.findByText("AdGuard Home");
    expect(pillFor("AdGuard Home")).toHaveClass("tone-green");
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("shows an in-progress AdGuard (fetching) as amber", async () => {
    fetchAdGuardManagedStatus.mockResolvedValue(adguard({ state: "fetching" }));
    render(SystemStatusStrip);

    await screen.findByText("AdGuard Home");
    expect(pillFor("AdGuard Home")).toHaveClass("tone-amber");
    expect(screen.getByText("Fetching")).toBeInTheDocument();
  });

  it("treats an enabled AdGuard with a null state as amber 'Unknown'", async () => {
    fetchAdGuardManagedStatus.mockResolvedValue(adguard({ state: null }));
    render(SystemStatusStrip);

    await screen.findByText("AdGuard Home");
    expect(pillFor("AdGuard Home")).toHaveClass("tone-amber");
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("shows a failed AdGuard as red with detail and a non-zero restart count", async () => {
    fetchAdGuardManagedStatus.mockResolvedValue(
      adguard({ state: "failed", restarts: 3, detail: "exited with code 1" }),
    );
    render(SystemStatusStrip);

    const button = await screen.findByRole("button", { name: /AdGuard Home/ });
    expect(pillFor("AdGuard Home")).toHaveClass("tone-red");

    await fireEvent.click(button);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("exited with code 1");
    expect(note).toHaveTextContent("3 restarts");
  });

  it("surfaces a status-fetch failure as a red error pill", async () => {
    fetchAnsibleStatus.mockRejectedValue(new Error("transport unavailable"));
    render(SystemStatusStrip);

    const button = await screen.findByRole("button", { name: /Ansible/ });
    expect(pillFor("Ansible")).toHaveClass("tone-red");
    expect(screen.getByText("Error")).toBeInTheDocument();

    await fireEvent.click(button);
    expect(screen.getByRole("note")).toHaveTextContent("transport unavailable");
  });
});
