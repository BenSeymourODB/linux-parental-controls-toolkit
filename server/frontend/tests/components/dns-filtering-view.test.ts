/**
 * Flow test for `DnsFilteringView` (#97). Renders the real component against a
 * mocked `$lib/api/dns` (no live backend) and exercises the highest-value flows:
 * the active-mode banner, the disabled empty state, the external-mode warning,
 * the per-device blocklist table + skipped devices, applying, and the error
 * surface.
 */
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DnsBlocklistApplyResponse,
  DnsBlocklistPreviewResponse,
  DnsStatusResponse,
} from "../../src/lib/api/contract.js";

const fetchDnsStatus = vi.fn<() => Promise<DnsStatusResponse>>();
const fetchDnsBlocklist = vi.fn<() => Promise<DnsBlocklistPreviewResponse>>();
const applyDnsBlocklist = vi.fn<() => Promise<DnsBlocklistApplyResponse>>();

vi.mock("$lib/api/dns", () => ({
  fetchDnsStatus: () => fetchDnsStatus(),
  fetchDnsBlocklist: () => fetchDnsBlocklist(),
  applyDnsBlocklist: () => applyDnsBlocklist(),
}));

const { default: DnsFilteringView } = await import("../../src/lib/views/DnsFilteringView.svelte");

function status(overrides: Partial<DnsStatusResponse> = {}): DnsStatusResponse {
  return {
    mode: "external",
    configured: true,
    health: "ok",
    baseUrl: "http://adguard.lan",
    checkedAt: "2026-08-23T00:00:00.000Z",
    detail: null,
    ...overrides,
  };
}

function preview(overrides: Partial<DnsBlocklistPreviewResponse> = {}): DnsBlocklistPreviewResponse {
  return {
    mode: "external",
    applyable: true,
    detail: null,
    clients: [],
    skipped: [],
    ...overrides,
  };
}

beforeEach(() => {
  fetchDnsStatus.mockReset();
  fetchDnsBlocklist.mockReset();
  applyDnsBlocklist.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DnsFilteringView", () => {
  it("shows the external active-mode banner with the confinement warning and the blocklist", async () => {
    fetchDnsStatus.mockResolvedValue(status());
    fetchDnsBlocklist.mockResolvedValue(
      preview({
        clients: [{ name: "pct:Alice", ids: ["192.168.1.50"], domains: ["tiktok.com", "youtube.com"] }],
      }),
    );

    render(DnsFilteringView);

    expect(await screen.findByText("External AdGuard Home")).toBeInTheDocument();
    const note = screen.getAllByRole("note")[0];
    expect(note).toHaveTextContent("healthy");
    // The external-mode confinement warning is shown.
    expect(screen.getByText(/only ever writes its own/i)).toBeInTheDocument();
    // The device row renders with its address and domains.
    const table = screen.getByRole("table");
    expect(within(table).getByText("pct:Alice")).toBeInTheDocument();
    expect(within(table).getByText("192.168.1.50")).toBeInTheDocument();
    expect(within(table).getByText("tiktok.com, youtube.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply DNS blocklists" })).not.toBeDisabled();
  });

  it("renders an explanatory empty state (no editor) when DNS is disabled", async () => {
    fetchDnsStatus.mockResolvedValue(status({ mode: "disabled", configured: false, health: "not_applicable", baseUrl: null, detail: null }));
    fetchDnsBlocklist.mockResolvedValue(preview({ mode: "disabled", applyable: false, detail: "DNS filtering is disabled." }));

    render(DnsFilteringView);

    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText(/DNS filtering is turned off/i)).toBeInTheDocument();
    // No apply button in the disabled empty state.
    expect(screen.queryByRole("button", { name: "Apply DNS blocklists" })).toBeNull();
  });

  it("disables Apply and explains why when not applyable", async () => {
    fetchDnsStatus.mockResolvedValue(status({ health: "unreachable", detail: "ECONNREFUSED" }));
    fetchDnsBlocklist.mockResolvedValue(
      preview({ applyable: false, detail: "the AdGuard instance is not reachable yet" }),
    );

    render(DnsFilteringView);

    await screen.findByText("External AdGuard Home");
    expect(screen.getByRole("button", { name: "Apply DNS blocklists" })).toBeDisabled();
    expect(screen.getByText("the AdGuard instance is not reachable yet")).toBeInTheDocument();
  });

  it("surfaces skipped devices (denies but no reported IP)", async () => {
    fetchDnsStatus.mockResolvedValue(status());
    fetchDnsBlocklist.mockResolvedValue(
      preview({
        skipped: [
          { clientId: 7, name: "pct:mint-03", label: "mint-03", reason: "no_reported_ips", domains: ["tiktok.com"] },
        ],
      }),
    );

    render(DnsFilteringView);

    expect(await screen.findByText("Not enforced")).toBeInTheDocument();
    expect(screen.getByText("mint-03")).toBeInTheDocument();
  });

  it("applies and shows a summary, then re-reads", async () => {
    fetchDnsStatus.mockResolvedValue(status());
    fetchDnsBlocklist.mockResolvedValue(
      preview({ clients: [{ name: "pct:Alice", ids: ["192.168.1.50"], domains: ["youtube.com"] }] }),
    );
    applyDnsBlocklist.mockResolvedValue({
      clientsManaged: 1,
      skipped: 0,
      ruleCount: 1,
      rulesChanged: true,
      clients: { added: 1, updated: 0, deleted: 0, unchanged: 0 },
    });

    render(DnsFilteringView);
    await screen.findByText("External AdGuard Home");

    await fireEvent.click(screen.getByRole("button", { name: "Apply DNS blocklists" }));

    expect(applyDnsBlocklist).toHaveBeenCalledOnce();
    const done = await screen.findByRole("status");
    expect(done).toHaveTextContent("Pushed 1 rule across 1 device");
    // It re-reads status + preview after applying (initial load + reload).
    expect(fetchDnsBlocklist).toHaveBeenCalledTimes(2);
  });

  it("surfaces a load error in the inline alert", async () => {
    const { ApiError } = await import("../../src/lib/api/client.js");
    fetchDnsStatus.mockRejectedValue(new ApiError(500, "internal", "The server exploded."));
    fetchDnsBlocklist.mockResolvedValue(preview());

    render(DnsFilteringView);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server exploded.");
  });
});
