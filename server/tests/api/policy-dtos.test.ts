/**
 * Unit tests for the policy-DTO response mappers (#51): the epoch-second `Date`
 * columns must serialize to ISO-8601 UTC strings, including the nullable
 * `Client.lastSeen` once a health probe has populated it (not reachable through
 * the CRUD routes yet, so covered directly here).
 */
import { describe, expect, it } from "vitest";

import { toClientResponse, toUserResponse } from "../../src/api/policy/dtos.js";
import type { ClientRow, UserRow } from "../../src/policy/repository.js";

describe("policy DTO mappers", () => {
  it("maps a user row, preserving a null tz", () => {
    const row: UserRow = {
      id: 1,
      displayName: "Alice",
      tz: null,
      createdAt: new Date("2026-06-17T00:00:00.000Z"),
    };
    expect(toUserResponse(row)).toEqual({
      id: 1,
      displayName: "Alice",
      tz: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    });
  });

  it("serializes a client's lastSeen when present", () => {
    const row: ClientRow = {
      id: 2,
      hostname: "mint-01",
      sshUser: "pct-agent",
      bearerTokenHash: null,
      enrolledAt: new Date("2026-06-17T00:00:00.000Z"),
      lastSeen: new Date("2026-06-17T08:30:00.000Z"),
    };
    expect(toClientResponse(row)).toEqual({
      id: 2,
      hostname: "mint-01",
      sshUser: "pct-agent",
      enrolledAt: "2026-06-17T00:00:00.000Z",
      lastSeen: "2026-06-17T08:30:00.000Z",
    });
  });

  it("maps a client's lastSeen of null to null", () => {
    const row: ClientRow = {
      id: 3,
      hostname: "mint-02",
      sshUser: "pct-agent",
      bearerTokenHash: null,
      enrolledAt: new Date("2026-06-17T00:00:00.000Z"),
      lastSeen: null,
    };
    expect(toClientResponse(row).lastSeen).toBeNull();
  });
});
