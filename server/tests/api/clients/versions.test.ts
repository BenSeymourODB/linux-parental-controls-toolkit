/**
 * Unit tests for the version-reporting additions to the enrolment surface
 * (#164): the `componentVersionsSchema` / `enrolClientSchema` validation rules
 * and the `resolveReportedVersions` normalisation the service layer applies.
 */
import { describe, expect, it } from "vitest";

import { resolveReportedVersions } from "../../../src/api/clients/service.js";
import { componentVersionsSchema, enrolClientSchema } from "../../../src/api/clients/dtos.js";

describe("componentVersionsSchema (#164)", () => {
  it("accepts Debian-style version strings for the known components", () => {
    const parsed = componentVersionsSchema.parse({
      timekpr: "0.5.3",
      e2guardian: "5.5.8~git20230101-1",
      activitywatch: "0.13.2",
    });
    expect(parsed).toEqual({
      timekpr: "0.5.3",
      e2guardian: "5.5.8~git20230101-1",
      activitywatch: "0.13.2",
    });
  });

  it("accepts an empty object and any subset of the components", () => {
    expect(componentVersionsSchema.parse({})).toEqual({});
    expect(componentVersionsSchema.parse({ timekpr: "1.0.0" })).toEqual({ timekpr: "1.0.0" });
  });

  it("rejects an unknown component key (strict shape keeps the inventory typed)", () => {
    expect(() => componentVersionsSchema.parse({ chromium: "120" })).toThrow();
  });

  it("rejects a version string with characters that could break JSON or smuggle text", () => {
    expect(() => componentVersionsSchema.parse({ timekpr: 'evil"version' })).toThrow();
    expect(() => componentVersionsSchema.parse({ timekpr: "has space" })).toThrow();
    expect(() => componentVersionsSchema.parse({ timekpr: "" })).toThrow();
    expect(() => componentVersionsSchema.parse({ timekpr: "a".repeat(65) })).toThrow();
  });
});

describe("enrolClientSchema version fields (#164)", () => {
  const base = {
    hostname: "mint-01",
    sshUser: "pct-agent",
    supervisedUsers: [{ osUsername: "alice", osUserRef: "1000" }],
  };

  it("treats agentVersion and componentVersions as optional", () => {
    const parsed = enrolClientSchema.parse(base);
    expect(parsed.agentVersion).toBeUndefined();
    expect(parsed.componentVersions).toBeUndefined();
  });

  it("parses a reported agentVersion + componentVersions", () => {
    const parsed = enrolClientSchema.parse({
      ...base,
      agentVersion: "1.4.0",
      componentVersions: { timekpr: "0.5.3" },
    });
    expect(parsed.agentVersion).toBe("1.4.0");
    expect(parsed.componentVersions).toEqual({ timekpr: "0.5.3" });
  });

  it("rejects a malformed agentVersion", () => {
    expect(() => enrolClientSchema.parse({ ...base, agentVersion: "1.4.0; rm -rf /" })).toThrow();
  });
});

describe("resolveReportedVersions (#164)", () => {
  it("returns all-null and no timestamp when nothing is reported", () => {
    const result = resolveReportedVersions({});
    expect(result).toEqual({
      agentVersion: null,
      componentVersions: null,
      versionsReportedAt: null,
    });
  });

  it("sets versionsReportedAt when only the agent version is reported", () => {
    const result = resolveReportedVersions({ agentVersion: "1.4.0" });
    expect(result.agentVersion).toBe("1.4.0");
    expect(result.componentVersions).toBeNull();
    expect(result.versionsReportedAt).toBeInstanceOf(Date);
  });

  it("sets versionsReportedAt when only component versions are reported", () => {
    const result = resolveReportedVersions({ componentVersions: { timekpr: "0.5.3" } });
    expect(result.componentVersions).toEqual({ timekpr: "0.5.3" });
    expect(result.versionsReportedAt).toBeInstanceOf(Date);
  });

  it("treats an empty componentVersions object as nothing reported", () => {
    const result = resolveReportedVersions({ componentVersions: {} });
    expect(result.componentVersions).toBeNull();
    expect(result.versionsReportedAt).toBeNull();
  });

  it("ignores a componentVersions object whose only fields are undefined", () => {
    const result = resolveReportedVersions({ componentVersions: { timekpr: undefined } });
    expect(result.componentVersions).toBeNull();
    expect(result.versionsReportedAt).toBeNull();
  });
});
