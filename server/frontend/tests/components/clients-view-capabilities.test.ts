/**
 * `ClientsView` per-client capability matrix (#400).
 *
 * The Clients cards surface each client's advertised capabilities and grey out
 * the controls it can't honour (the `docs/windows-client-support.md` modularity
 * seam). This asserts the three states the DTO expresses: a supported control
 * renders enabled, an unsupported one renders greyed (`aria-disabled`), and a
 * client that hasn't handshaked shows the "not reported yet" empty state.
 *
 * Same harness as the other `ClientsView` component tests: `$app/environment`
 * is mocked so `browser` is true, and the `$lib/api/*` wrappers are mocked — no
 * live backend.
 */
import { render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClientResponse,
  ClientHealthResponse,
  UserResponse,
} from "../../src/lib/api/contract.js";

vi.mock("$app/environment", () => ({ browser: true }));

const listClients = vi.fn<() => Promise<ClientResponse[]>>();
const updateClient = vi.fn<(id: number, input: unknown) => Promise<ClientResponse>>();
const deleteClient = vi.fn<(id: number) => Promise<void>>();
const mintEnrolmentToken = vi.fn<(input: unknown) => Promise<unknown>>();
const listClientHealth = vi.fn<() => Promise<ClientHealthResponse[]>>();
const listUsers = vi.fn<() => Promise<UserResponse[]>>();

vi.mock("$lib/api/clients", () => ({
  listClients: () => listClients(),
  updateClient: (id: number, input: unknown) => updateClient(id, input),
  deleteClient: (id: number) => deleteClient(id),
  mintEnrolmentToken: (input: unknown) => mintEnrolmentToken(input),
}));
vi.mock("$lib/api/client-health", () => ({ listClientHealth: () => listClientHealth() }));
vi.mock("$lib/api/users", () => ({ listUsers: () => listUsers() }));

const { default: ClientsView } = await import("../../src/lib/views/ClientsView.svelte");

function client(overrides: Partial<ClientResponse> = {}): ClientResponse {
  return {
    id: 1,
    hostname: "mint-01",
    sshUser: "pct-agent",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastSeen: null,
    enrolled: true,
    platform: "linux",
    ...overrides,
  } as ClientResponse;
}

function health(overrides: Partial<ClientHealthResponse> = {}): ClientHealthResponse {
  return {
    clientId: 1,
    hostname: "mint-01",
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
    capabilitiesReported: false,
    capabilities: [],
    queue: { pending: 0, failed: 0, actions: [] },
    ...overrides,
  };
}

beforeEach(() => {
  listClients.mockReset().mockResolvedValue([client()]);
  updateClient.mockReset();
  deleteClient.mockReset();
  mintEnrolmentToken.mockReset();
  listClientHealth.mockReset().mockResolvedValue([]);
  listUsers.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClientsView capability matrix (#400)", () => {
  it("shows 'not reported yet' before the client has handshaked", async () => {
    listClientHealth.mockResolvedValue([health({ capabilitiesReported: false, capabilities: [] })]);

    render(ClientsView);

    await screen.findByText("mint-01");
    expect(screen.getByText(/Not reported yet/i)).toBeInTheDocument();
  });

  it("renders a supported capability enabled and an unsupported one greyed", async () => {
    listClientHealth.mockResolvedValue([
      health({
        capabilitiesReported: true,
        capabilities: [
          {
            capability: "session_budget",
            label: "Session budget",
            description: "Locks the session when the overall budget runs out.",
            supported: true,
          },
          {
            capability: "per_app_close",
            label: "Per-app force-close",
            description: "Kills an app when its quota is exhausted.",
            supported: false,
          },
        ],
      }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-01");

    // Both controls render; the "not reported" empty state is gone.
    expect(screen.queryByText(/Not reported yet/i)).not.toBeInTheDocument();

    const supported = screen.getByText("Session budget").closest("li");
    const unsupported = screen.getByText("Per-app force-close").closest("li");
    expect(supported).not.toBeNull();
    expect(unsupported).not.toBeNull();

    // The unsupported control is greyed out; the supported one is not.
    expect(supported).toHaveAttribute("data-supported", "true");
    expect(supported).not.toHaveClass("unsupported");
    expect(unsupported).toHaveAttribute("data-supported", "false");
    expect(unsupported).toHaveClass("unsupported");
    expect(within(supported as HTMLElement).getByText("supported")).toBeInTheDocument();
    expect(within(unsupported as HTMLElement).getByText("unsupported")).toBeInTheDocument();
  });

  it("greys out every control when the client handshaked advertising nothing", async () => {
    listClientHealth.mockResolvedValue([
      health({
        capabilitiesReported: true,
        capabilities: [
          {
            capability: "session_budget",
            label: "Session budget",
            description: "Locks the session when the overall budget runs out.",
            supported: false,
          },
          {
            capability: "per_app_close",
            label: "Per-app force-close",
            description: "Kills an app when its quota is exhausted.",
            supported: false,
          },
        ],
      }),
    ]);

    render(ClientsView);
    await screen.findByText("mint-01");

    await waitFor(() => expect(screen.getByText("Session budget")).toBeInTheDocument());
    expect(screen.getByText("Session budget").closest("li")).toHaveAttribute(
      "data-supported",
      "false",
    );
    expect(screen.getByText("Per-app force-close").closest("li")).toHaveAttribute(
      "data-supported",
      "false",
    );
    // No "supported" pill anywhere in the matrix.
    expect(screen.queryByText("supported")).not.toBeInTheDocument();
  });
});
