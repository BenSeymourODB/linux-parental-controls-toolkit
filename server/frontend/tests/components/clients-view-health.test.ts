/**
 * Health-list + enrol-flow smoke test for `ClientsView` (#266, merged into the
 * single Clients surface in #305). The view joins the client inventory
 * (`listClients`) with health (`listClientHealth`) keyed by id, so a card only
 * renders when both an inventory row and — for health detail — a matching health
 * record are present. Minting an enrolment token gates on `enrolReady` (every
 * supervised-user row complete + usernames distinct), supports add/remove rows,
 * generates the install one-liner from the minted token + dashboard origin,
 * copies it, and the per-client queue is collapsible. `$app/environment` is
 * mocked so `browser` is true; the `$lib/api/*` wrappers are mocked — no live
 * backend. The CRUD half is covered by `clients-view-crud.test.ts`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClientResponse,
  ClientHealthResponse,
  EnrolmentTokenResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

vi.mock("$app/environment", () => ({ browser: true }));

const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const mintEnrolmentToken = vi.fn<(input: unknown) => Promise<EnrolmentTokenResponse>>();
const listClientHealth = vi.fn<() => Promise<ClientHealthResponse[]>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();

vi.mock("$lib/api/clients", () => ({
  listClients: () => listClients(),
  createClient: vi.fn(),
  updateClient: vi.fn(),
  deleteClient: vi.fn(),
  mintEnrolmentToken: (input: unknown) => mintEnrolmentToken(input),
}));
vi.mock("$lib/api/client-health", () => ({ listClientHealth: () => listClientHealth() }));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));

const { default: ClientsView } = await import("../../src/lib/views/ClientsView.svelte");

function user(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 1,
    displayName: "Chloe",
    tz: "Europe/London",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserResponse;
}

function client(overrides: Partial<ClientResponse> = {}): ClientResponse {
  return {
    id: 5,
    hostname: "mint-box",
    friendlyName: null,
    sshUser: "pct-agent",
    enrolledAt: "2026-06-01T00:00:00.000Z",
    lastSeen: "2026-06-20T10:00:00.000Z",
    reportedIps: null,
    sourceIp: null,
    enrolled: true,
    platform: "linux",
    ...overrides,
  } as ClientResponse;
}

function health(overrides: Partial<ClientHealthResponse> = {}): ClientHealthResponse {
  return {
    clientId: 5,
    hostname: "mint-box",
    friendlyName: null,
    reportedIps: null,
    sourceIp: null,
    reachability: "online",
    reachabilityReason: null,
    lastSeen: "2026-06-20T10:00:00.000Z",
    enrolledAt: "2026-06-01T00:00:00.000Z",
    probedAt: "2026-06-20T10:00:00.000Z",
    updateRequired: false,
    agentVersion: "0.1.0-alpha.5",
    versionsReportedAt: "2026-06-20T10:00:00.000Z",
    serverVersion: "0.1.0-alpha.5",
    versionStatus: "up_to_date",
    components: [{ component: "timekpr-next", status: "ok", detail: "active" }],
    queue: { pending: 0, failed: 0, actions: [] },
    ...overrides,
  };
}

beforeEach(() => {
  listClients.mockReset().mockResolvedValue([]);
  listClientHealth.mockReset().mockResolvedValue([]);
  mintEnrolmentToken.mockReset();
  listUsers.mockReset().mockResolvedValue([user()]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ClientsView health list + queue", () => {
  it("renders a client card with reachability and component health", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockResolvedValue([health()]);

    render(ClientsView);

    expect(await screen.findByText("mint-box")).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("Timekpr-nExT")).toBeInTheDocument(); // friendly label
    // Health loaded fine → no "unavailable" notice.
    expect(screen.queryByText(/Health data unavailable/)).not.toBeInTheDocument();
  });

  it("titles the card on the friendly name and shows hostname + IPs (#355)", async () => {
    listClients.mockResolvedValue([
      client({
        friendlyName: "kids' living-room PC",
        hostname: "omega-B85M-DS3H",
        reportedIps: ["192.168.1.42", "fe80::1"],
        sourceIp: "192.168.1.42",
      }),
    ]);
    listClientHealth.mockResolvedValue([health()]);

    render(ClientsView);

    // The friendly name is the card title; the raw hostname drops to secondary.
    expect(await screen.findByText("kids' living-room PC")).toBeInTheDocument();
    expect(screen.getByText("omega-B85M-DS3H")).toBeInTheDocument();
    // Both the self-reported IPs and the observed source IP are surfaced.
    expect(screen.getByText("192.168.1.42, fe80::1")).toBeInTheDocument();
    expect(screen.getByText("Source IP")).toBeInTheDocument();
  });

  it("falls back to the hostname as the title when no friendly name is set (#355)", async () => {
    listClients.mockResolvedValue([client({ friendlyName: null, hostname: "bare-host" })]);
    listClientHealth.mockResolvedValue([health()]);

    render(ClientsView);

    expect(await screen.findByText("bare-host")).toBeInTheDocument();
  });

  it("expands and collapses the queued-actions detail", async () => {
    listClients.mockResolvedValue([client()]);
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

    render(ClientsView);
    await screen.findByText("mint-box");

    // Queue detail is collapsed until toggled.
    expect(screen.queryByText("timekpra.settimeleft")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Show queued actions/ }));
    expect(await screen.findByText("timekpra.settimeleft")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Hide queued actions/ }));
    await waitFor(() => expect(screen.queryByText("timekpra.settimeleft")).not.toBeInTheDocument());
  });

  it("renders inventory even when the health fetch fails (degraded)", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockRejectedValue(new Error("probe unavailable"));

    render(ClientsView);

    expect(await screen.findByText("mint-box")).toBeInTheDocument();
    // No probe data → the card still renders, marked unknown / awaiting probe.
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("Awaiting first health probe.")).toBeInTheDocument();
    // The lost health signal is surfaced non-blockingly (#312 review).
    expect(screen.getByText(/Health data unavailable/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no clients", async () => {
    listClients.mockResolvedValue([]);

    render(ClientsView);

    expect(await screen.findByText("No clients yet. Enrol one below.")).toBeInTheDocument();
  });

  it("badges version drift and shows the reported vs server version (#352)", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockResolvedValue([
      health({
        agentVersion: "0.1.0-alpha.4",
        serverVersion: "0.1.0-alpha.5",
        versionStatus: "outdated",
      }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-box");

    expect(screen.getByText("update available")).toBeInTheDocument();
    // The reported version and the server version both surface on the card.
    expect(screen.getByText("0.1.0-alpha.4")).toBeInTheDocument();
    expect(screen.getByText(/server 0\.1\.0-alpha\.5/)).toBeInTheDocument();
  });

  it("shows 'update required' when the handshake flagged the client (#352)", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockResolvedValue([
      health({ updateRequired: true, versionStatus: "update_required" }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-box");

    expect(screen.getByText("update required")).toBeInTheDocument();
  });

  it("shows a remediation hint for an offline client's classified SSH cause (#353)", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockResolvedValue([
      health({
        reachability: "offline",
        reachabilityReason: "dns",
        components: [
          { component: "timekpr-next", status: "unknown", detail: "host unreachable (dns)" },
        ],
      }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-box");

    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText(/enrol the client by IP/i)).toBeInTheDocument();
  });

  it("shows no remediation hint when an offline cause is unknown (#353)", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockResolvedValue([
      health({ reachability: "offline", reachabilityReason: "unknown" }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-box");

    expect(screen.getByText("offline")).toBeInTheDocument();
    // `unknown` maps to no actionable hint — the detail line still carries context.
    expect(screen.queryByText(/enrol the client by IP/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/re-run the installer/i)).not.toBeInTheDocument();
  });

  it("shows 'version unknown' for a client that never reported one (#352)", async () => {
    listClients.mockResolvedValue([client()]);
    listClientHealth.mockResolvedValue([
      health({ agentVersion: null, versionsReportedAt: null, versionStatus: "unknown" }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-box");

    expect(screen.getByText("version unknown")).toBeInTheDocument();
    expect(screen.getByText("not reported")).toBeInTheDocument();
  });
});

describe("ClientsView enrol flow", () => {
  it("keeps mint disabled until every row is complete", async () => {
    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

    const mint = screen.getByRole("button", { name: "Generate enrolment token" });
    expect(mint).toBeDisabled();

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    // Username still blank → blocked.
    expect(mint).toBeDisabled();

    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    expect(mint).toBeEnabled();
  });

  it("blocks mint when two rows share an OS username", async () => {
    listUsers.mockResolvedValue([
      user({ id: 1, displayName: "Chloe" }),
      user({ id: 2, displayName: "Dana" }),
    ]);

    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

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
    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

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

    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

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

  it("includes the friendly-name field when one is given (#355)", async () => {
    mintEnrolmentToken.mockResolvedValue({
      id: 1,
      token: "tok_x",
      expiresAt: "2026-06-23T12:00:00.000Z",
    });

    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    await fireEvent.input(screen.getByLabelText("Friendly name"), {
      target: { value: "kids' living-room PC" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Generate enrolment token" }));

    await waitFor(() =>
      expect(mintEnrolmentToken).toHaveBeenCalledWith({
        supervisedUsers: [{ userId: 1, osUsername: "chloe" }],
        ttlSeconds: 3600,
        friendlyName: "kids' living-room PC",
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
    // `vi.stubGlobal` so `afterEach`'s `unstubAllGlobals` restores the original
    // `navigator` — a bare `Object.assign` would leak the stub into later tests.
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

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

    render(ClientsView);
    await screen.findByRole("heading", { name: "Enrol a client" });

    await fireEvent.change(screen.getByLabelText("Supervised user"), { target: { value: "1" } });
    await fireEvent.input(screen.getByLabelText("OS username"), { target: { value: "chloe" } });
    await fireEvent.click(screen.getByRole("button", { name: "Generate enrolment token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Token mint failed.");
    // The form is still present (the minted panel never replaced it).
    expect(screen.getByRole("button", { name: "Generate enrolment token" })).toBeInTheDocument();
  });
});
