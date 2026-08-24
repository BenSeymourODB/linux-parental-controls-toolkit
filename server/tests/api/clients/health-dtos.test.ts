/**
 * Unit tests for the client health/status DTOs (#81): the `transport_queue`-row
 * → wire-summary mapper and the schema/contract invariants (enums derived from
 * the `transport/health` catalogue and the queue status enum).
 */
import { describe, expect, it } from "vitest";

import { clientComponentValues } from "../../../src/transport/health/index.js";
import type { QueuedActionRow } from "../../../src/transport/queue/index.js";
import {
  clientCapabilitySchema,
  clientHealthSchema,
  componentHealthSchema,
  toQueuedActionSummary,
} from "../../../src/api/clients/health-dtos.js";

const row: QueuedActionRow = {
  id: 7,
  clientId: 3,
  coalesceKey: "policy.push:user:1",
  kind: "policy.push",
  payload: { foo: "bar" },
  status: "failed",
  attempts: 2,
  lastError: "exit code 1",
  enqueuedAt: new Date("2026-06-19T10:00:00.000Z"),
  updatedAt: new Date("2026-06-19T10:05:00.000Z"),
};

describe("toQueuedActionSummary", () => {
  it("maps a queue row to its wire summary with ISO timestamps", () => {
    expect(toQueuedActionSummary(row)).toEqual({
      id: 7,
      kind: "policy.push",
      coalesceKey: "policy.push:user:1",
      status: "failed",
      attempts: 2,
      lastError: "exit code 1",
      enqueuedAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:05:00.000Z",
    });
  });

  it("preserves a null lastError", () => {
    expect(toQueuedActionSummary({ ...row, lastError: null }).lastError).toBeNull();
  });
});

describe("health DTO contract", () => {
  it("accepts every catalogue component name", () => {
    for (const component of clientComponentValues) {
      expect(
        componentHealthSchema.safeParse({ component, status: "ok", detail: "active" }).success,
      ).toBe(true);
    }
  });

  it("rejects an unknown component name", () => {
    expect(
      componentHealthSchema.safeParse({ component: "not-a-thing", status: "ok", detail: "" })
        .success,
    ).toBe(false);
  });

  it("round-trips a full client-health record", () => {
    const parsed = clientHealthSchema.safeParse({
      clientId: 3,
      hostname: "alice-pc.local",
      friendlyName: "kids' living-room PC",
      reportedIps: ["192.168.1.42", "fe80::1"],
      sourceIp: "192.168.1.42",
      reachability: "online",
      reachabilityReason: null,
      lastSeen: "2026-06-19T12:00:00.000Z",
      enrolledAt: "2026-06-01T00:00:00.000Z",
      probedAt: "2026-06-19T12:00:00.000Z",
      updateRequired: false,
      agentVersion: "0.1.0-alpha.5",
      versionsReportedAt: "2026-06-19T12:00:00.000Z",
      serverVersion: "0.1.0-alpha.5",
      versionStatus: "up_to_date",
      components: [{ component: "timekpr-next", status: "ok", detail: "active" }],
      capabilitiesReported: true,
      capabilities: [
        {
          capability: "per_app_close",
          label: "Per-app force-close",
          description: "Kills an app when its quota is exhausted.",
          supported: true,
        },
      ],
      queue: { pending: 1, failed: 0, actions: [toQueuedActionSummary(row)] },
    });
    expect(parsed.success).toBe(true);
  });

  it("allows null lastSeen / probedAt / versions (never-seen, un-probed client)", () => {
    const parsed = clientHealthSchema.safeParse({
      clientId: 3,
      hostname: "alice-pc.local",
      friendlyName: null,
      reportedIps: null,
      sourceIp: null,
      reachability: "unknown",
      reachabilityReason: null,
      lastSeen: null,
      enrolledAt: "2026-06-01T00:00:00.000Z",
      probedAt: null,
      updateRequired: true,
      agentVersion: null,
      versionsReportedAt: null,
      serverVersion: null,
      versionStatus: "unknown",
      components: [],
      capabilitiesReported: false,
      capabilities: [],
      queue: { pending: 0, failed: 0, actions: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a versionStatus outside the enum", () => {
    const parsed = clientHealthSchema.safeParse({
      clientId: 3,
      hostname: "alice-pc.local",
      friendlyName: null,
      reportedIps: null,
      sourceIp: null,
      reachability: "unknown",
      reachabilityReason: null,
      lastSeen: null,
      enrolledAt: "2026-06-01T00:00:00.000Z",
      probedAt: null,
      updateRequired: false,
      agentVersion: null,
      versionsReportedAt: null,
      serverVersion: null,
      versionStatus: "ancient",
      components: [],
      capabilitiesReported: false,
      capabilities: [],
      queue: { pending: 0, failed: 0, actions: [] },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("clientCapabilitySchema", () => {
  it("round-trips a capability matrix row", () => {
    const parsed = clientCapabilitySchema.safeParse({
      capability: "session_budget",
      label: "Session budget",
      description: "Locks the session when the overall budget runs out.",
      supported: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires the supported flag to be a boolean", () => {
    const parsed = clientCapabilitySchema.safeParse({
      capability: "session_budget",
      label: "Session budget",
      description: "Locks the session when the overall budget runs out.",
      supported: "yes",
    });
    expect(parsed.success).toBe(false);
  });
});
