/**
 * Unit tests for the policy-DTO response mappers (#51): the epoch-second `Date`
 * columns must serialize to ISO-8601 UTC strings, including the nullable
 * `Client.lastSeen` once a health probe has populated it (not reachable through
 * the CRUD routes yet, so covered directly here).
 */
import { describe, expect, it } from "vitest";

import {
  toBudgetResponse,
  toClientResponse,
  toExceptionResponse,
  toScheduleResponse,
  toUserResponse,
} from "../../src/api/policy/dtos.js";
import type {
  BudgetRow,
  ClientRow,
  ExceptionRow,
  ScheduleRow,
  UserRow,
} from "../../src/policy/repository.js";

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

  it("serializes a client's lastSeen when present and flags it as enrolled", () => {
    const row: ClientRow = {
      id: 2,
      hostname: "mint-01",
      sshUser: "pct-agent",
      bearerTokenHash: "deadbeef",
      enrolledAt: new Date("2026-06-17T00:00:00.000Z"),
      lastSeen: new Date("2026-06-17T08:30:00.000Z"),
      agentVersion: null,
      componentVersions: null,
      friendlyName: "kids' living-room PC",
      reportedIps: ["192.168.1.42", "fe80::1"],
      sourceIp: "192.168.1.42",
      versionsReportedAt: null,
      lastTelemetryPullAt: null,
      platform: "linux",
      updateRequired: false,
      lastVerifiedAt: null,
      lastVerifyReachable: null,
      lastVerifyReason: null,
    };
    expect(toClientResponse(row)).toEqual({
      id: 2,
      hostname: "mint-01",
      friendlyName: "kids' living-room PC",
      sshUser: "pct-agent",
      enrolledAt: "2026-06-17T00:00:00.000Z",
      lastSeen: "2026-06-17T08:30:00.000Z",
      reportedIps: ["192.168.1.42", "fe80::1"],
      sourceIp: "192.168.1.42",
      enrolled: true,
      platform: "linux",
    });
  });

  it("flags a manual-CRUD client (no bearer token) as not enrolled", () => {
    const row: ClientRow = {
      id: 5,
      hostname: "mint-manual",
      sshUser: "pct-agent",
      bearerTokenHash: null,
      enrolledAt: new Date("2026-06-17T00:00:00.000Z"),
      lastSeen: null,
      agentVersion: null,
      componentVersions: null,
      friendlyName: null,
      reportedIps: null,
      sourceIp: null,
      versionsReportedAt: null,
      lastTelemetryPullAt: null,
      platform: "linux",
      updateRequired: false,
      lastVerifiedAt: null,
      lastVerifyReachable: null,
      lastVerifyReason: null,
    };
    expect(toClientResponse(row).enrolled).toBe(false);
  });

  it("maps a client's lastSeen of null to null", () => {
    const row: ClientRow = {
      id: 3,
      hostname: "mint-02",
      sshUser: "pct-agent",
      bearerTokenHash: null,
      enrolledAt: new Date("2026-06-17T00:00:00.000Z"),
      lastSeen: null,
      agentVersion: null,
      componentVersions: null,
      friendlyName: null,
      reportedIps: null,
      sourceIp: null,
      versionsReportedAt: null,
      lastTelemetryPullAt: null,
      platform: "linux",
      updateRequired: false,
      lastVerifiedAt: null,
      lastVerifyReachable: null,
      lastVerifyReason: null,
    };
    expect(toClientResponse(row).lastSeen).toBeNull();
  });

  it("surfaces the reserved platform discriminator on the wire (#229)", () => {
    const row: ClientRow = {
      id: 4,
      hostname: "win-01",
      sshUser: "pct-agent",
      bearerTokenHash: null,
      enrolledAt: new Date("2026-06-17T00:00:00.000Z"),
      lastSeen: null,
      agentVersion: null,
      componentVersions: null,
      friendlyName: null,
      reportedIps: null,
      sourceIp: null,
      versionsReportedAt: null,
      lastTelemetryPullAt: null,
      platform: "windows",
      updateRequired: false,
      lastVerifiedAt: null,
      lastVerifyReachable: null,
      lastVerifyReason: null,
    };
    expect(toClientResponse(row).platform).toBe("windows");
  });

  it("maps a budget row, preserving the polymorphic target", () => {
    const row: BudgetRow = {
      id: 4,
      userId: 1,
      scope: "activity",
      targetId: 9,
      window: "weekly",
      secondsAllowed: 3600,
      recurrenceDays: null,
    };
    expect(toBudgetResponse(row)).toEqual({
      id: 4,
      userId: 1,
      scope: "activity",
      targetId: 9,
      window: "weekly",
      secondsAllowed: 3600,
      recurrenceDays: null,
    });
  });

  it("maps a weekday-varying budget row, preserving the recurrence mask (#141)", () => {
    const row: BudgetRow = {
      id: 7,
      userId: 1,
      scope: "overall",
      targetId: null,
      window: "daily",
      secondsAllowed: 7200,
      // Mon..Fri = bits 0..4 = 0b0011111 = 31.
      recurrenceDays: 31,
    };
    expect(toBudgetResponse(row).recurrenceDays).toBe(31);
  });

  it("maps a schedule row, serializing the effective window and keeping null recurrence", () => {
    const row: ScheduleRow = {
      id: 5,
      userId: 1,
      targetKind: "overall",
      targetId: null,
      recurrenceDays: 31,
      recurrenceStartMinute: 540,
      recurrenceEndMinute: 1020,
      effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
      effectiveTo: null,
      action: "allow",
      ordinal: 2,
    };
    expect(toScheduleResponse(row)).toEqual({
      id: 5,
      userId: 1,
      targetKind: "overall",
      targetId: null,
      recurrenceDays: 31,
      recurrenceStartMinute: 540,
      recurrenceEndMinute: 1020,
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveTo: null,
      action: "allow",
      ordinal: 2,
    });
  });

  it("maps an exception row, serializing timestamps and a null effectiveFrom", () => {
    const row: ExceptionRow = {
      id: 6,
      userId: 1,
      targetKind: "overall",
      targetId: null,
      action: "allow",
      reason: "Birthday",
      effectiveFrom: null,
      expiresAt: new Date("2026-07-01T21:00:00.000Z"),
      createdAt: new Date("2026-06-30T10:00:00.000Z"),
    };
    expect(toExceptionResponse(row)).toEqual({
      id: 6,
      userId: 1,
      targetKind: "overall",
      targetId: null,
      action: "allow",
      reason: "Birthday",
      effectiveFrom: null,
      expiresAt: "2026-07-01T21:00:00.000Z",
      createdAt: "2026-06-30T10:00:00.000Z",
    });
  });
});
