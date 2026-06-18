/**
 * Direct coverage for the ActivityWatch response schemas — the validation
 * boundary that every `aw-server` payload crosses before it becomes typed
 * data (`CLAUDE.md` → "Validate all external input").
 */
import { describe, expect, it } from "vitest";
import {
  awAfkDataSchema,
  awBucketSchema,
  awEventSchema,
  awServerInfoSchema,
  awWindowDataSchema,
} from "../../../src/transport/activitywatch/index.js";

describe("awServerInfoSchema", () => {
  it("accepts info with an optional device_id omitted", () => {
    const parsed = awServerInfoSchema.parse({
      hostname: "host",
      version: "aw-server 0.13",
      testing: true,
    });
    expect(parsed.device_id).toBeUndefined();
  });

  it("rejects info missing required fields", () => {
    expect(awServerInfoSchema.safeParse({ hostname: "host" }).success).toBe(false);
  });
});

describe("awBucketSchema", () => {
  it("parses a bucket, allowing null name/last_updated and coercing created to a Date", () => {
    const parsed = awBucketSchema.parse({
      id: "b",
      created: "2024-01-01T00:00:00.000Z",
      name: null,
      type: "currentwindow",
      client: "aw-watcher-window",
      hostname: "host",
      last_updated: null,
    });
    expect(parsed.created).toBeInstanceOf(Date);
    expect(parsed.created.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(parsed.name).toBeNull();
  });

  it("rejects an unparseable created timestamp", () => {
    const result = awBucketSchema.safeParse({
      id: "b",
      created: "yesterday",
      type: "currentwindow",
      client: "c",
      hostname: "h",
    });
    expect(result.success).toBe(false);
  });
});

describe("awEventSchema", () => {
  it("coerces the timestamp to a Date and keeps duration", () => {
    const parsed = awEventSchema.parse({
      id: 1,
      timestamp: "2024-01-01T00:00:00.000Z",
      duration: 42.5,
      data: { app: "firefox", title: "x" },
    });
    expect(parsed.timestamp).toBeInstanceOf(Date);
    expect(parsed.duration).toBe(42.5);
  });

  it("rejects a negative duration", () => {
    const result = awEventSchema.safeParse({
      timestamp: "2024-01-01T00:00:00.000Z",
      duration: -1,
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("watcher data schemas", () => {
  it("accepts window data and rejects a missing title", () => {
    expect(awWindowDataSchema.safeParse({ app: "firefox", title: "x" }).success).toBe(true);
    expect(awWindowDataSchema.safeParse({ app: "firefox" }).success).toBe(false);
  });

  it("accepts the afk status enum and rejects anything else", () => {
    expect(awAfkDataSchema.safeParse({ status: "not-afk" }).success).toBe(true);
    expect(awAfkDataSchema.safeParse({ status: "sleeping" }).success).toBe(false);
  });
});
