/**
 * HTTP tests for the inbound integration grant endpoint (#113, ADR 0014),
 * driven through the real app via `app.inject()` — per `docs/testing.md` →
 * "HTTP routes". Covers the happy paths (overall / activity / group), the
 * idempotent `source_ref` replay, and the full failure matrix (auth, scope,
 * validation, unknown user / target).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../../src/auth/session.js";
import { loadSettings, type Settings } from "../../../src/config.js";
import { createActivity, createActivityGroup, createUser } from "../../../src/policy/repository.js";
import { grants } from "../../../src/policy/schema.js";
import { buildTestApp, type TestApp } from "../../helpers/app.js";

function settings(): Settings {
  return loadSettings({
    PCT_LOG_LEVEL: "silent",
    PCT_SECRET_KEY: "grants-test-secret",
    PCT_ADMIN_USERNAME: "ben",
    PCT_ADMIN_PASSWORD: "hunter2",
  });
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : [String(raw ?? "")];
  const match = headers.find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  if (match === undefined) throw new Error("no session cookie set");
  return match.split(";")[0] ?? "";
}

const FUTURE = "2999-01-01T00:00:00.000Z";

describe("integration grant endpoint", () => {
  let harness: TestApp;
  let cookie: string;
  let userId: number;
  let grantsWriteSecret: string;
  let readOnlySecret: string;

  beforeEach(async () => {
    harness = buildTestApp({ appOptions: { settings: settings() } });
    await harness.app.ready();

    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ben", password: "hunter2" },
    });
    cookie = sessionCookie(login);

    grantsWriteSecret = (await mintToken("calendar", ["grants:write"])).secret;
    readOnlySecret = (await mintToken("viewer", ["policy:read"])).secret;

    userId = createUser(harness.db, { displayName: "Alice" }).id;
  });

  afterEach(async () => {
    await harness.close();
  });

  async function mintToken(
    name: string,
    scopes: string[],
  ): Promise<{ id: number; secret: string }> {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/integrations/tokens",
      headers: { cookie },
      payload: { name, scopes },
    });
    if (res.statusCode !== 201) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
    const body = res.json();
    return { id: body.id as number, secret: body.secret as string };
  }

  /** POST a grant with the given bearer secret (default: the grants:write token). */
  function postGrant(payload: Record<string, unknown>, secret: string = grantsWriteSecret) {
    return harness.app.inject({
      method: "POST",
      url: "/api/integrations/grants",
      headers: { authorization: `Bearer ${secret}` },
      payload,
    });
  }

  function overallBody(overrides: Record<string, unknown> = {}) {
    return {
      user_ref: String(userId),
      scope: "overall",
      seconds: 1800,
      expires_at: FUTURE,
      source_ref: "calendar:chore:1",
      reason: "Cleaned room",
      ...overrides,
    };
  }

  function countGrants(): number {
    return harness.db.select().from(grants).all().length;
  }

  it("records an overall grant with a 201 and snake_case body", async () => {
    const res = await postGrant(overallBody());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.user_id).toBe(userId);
    expect(body.scope).toBe("overall");
    expect(body.target).toBeNull();
    expect(body.seconds).toBe(1800);
    expect(body.expires_at).toBe(FUTURE);
    expect(body.source).toBe("integration:calendar");
    expect(body.source_ref).toBe("calendar:chore:1");
    expect(body.reason).toBe("Cleaned room");
    expect(body.revoked_at).toBeNull();
    expect(typeof body.granted_at).toBe("string");
    expect(countGrants()).toBe(1);
  });

  it("defaults an omitted reason to null", async () => {
    const res = await postGrant(overallBody({ reason: undefined }));
    expect(res.statusCode).toBe(201);
    expect(res.json().reason).toBeNull();
  });

  it("accepts an expires_at carrying a timezone offset (the documented contract shape)", async () => {
    // ADR 0014 / docs/architecture.md show `...T23:59:59-04:00` (an offset, not
    // Z). The endpoint must accept it, not 400 it.
    const res = await postGrant(
      overallBody({ expires_at: "2999-06-05T23:59:59-04:00", source_ref: "calendar:offset:1" }),
    );
    expect(res.statusCode).toBe(201);
    // Echoed back normalised to UTC Z form (stored as a Unix timestamp).
    expect(res.json().expires_at).toBe(new Date("2999-06-05T23:59:59-04:00").toISOString());
  });

  it("records activity- and group-scoped grants against an existing target", async () => {
    const activityId = createActivity(harness.db, { kind: "app", matcher: "firefox" }).id;
    const groupId = createActivityGroup(harness.db, { name: "Games" }).id;

    const activity = await postGrant(
      overallBody({
        scope: "activity",
        target: activityId,
        source_ref: "calendar:activity:1",
      }),
    );
    expect(activity.statusCode).toBe(201);
    expect(activity.json().scope).toBe("activity");
    expect(activity.json().target).toBe(activityId);

    const group = await postGrant(
      overallBody({ scope: "group", target: groupId, source_ref: "calendar:group:1" }),
    );
    expect(group.statusCode).toBe(201);
    expect(group.json().target).toBe(groupId);
  });

  it("is idempotent on source_ref: a replay returns 200 with the original row, no new grant", async () => {
    const first = await postGrant(overallBody());
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id as number;

    // Replay with the same source_ref but a *different* seconds — the recorded
    // grant is returned unchanged (ADR 0014 §5: source_ref is the promise).
    const replay = await postGrant(overallBody({ seconds: 9999 }));
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(firstId);
    expect(replay.json().seconds).toBe(1800);
    expect(countGrants()).toBe(1);
  });

  it("401s an anonymous request (no bearer token)", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/integrations/grants",
      payload: overallBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(countGrants()).toBe(0);
  });

  it("401s an invalid bearer token", async () => {
    const res = await postGrant(overallBody(), "not-a-real-token");
    expect(res.statusCode).toBe(401);
  });

  it("403s a token lacking the grants:write scope", async () => {
    const res = await postGrant(overallBody(), readOnlySecret);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");
    expect(countGrants()).toBe(0);
  });

  it("400s a grant whose expires_at is in the past", async () => {
    const res = await postGrant(overallBody({ expires_at: "2000-01-01T00:00:00.000Z" }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect(countGrants()).toBe(0);
  });

  it("400s non-positive seconds", async () => {
    const res = await postGrant(overallBody({ seconds: 0 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("400s a target supplied for the overall scope", async () => {
    const res = await postGrant(overallBody({ target: 5 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("400s a missing target for the activity scope", async () => {
    const res = await postGrant(overallBody({ scope: "activity", source_ref: "x" }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("400s a malformed body (missing seconds)", async () => {
    const res = await postGrant(overallBody({ seconds: undefined }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("404s an unknown user_ref", async () => {
    const res = await postGrant(overallBody({ user_ref: "999999" }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(countGrants()).toBe(0);
  });

  it("404s a non-decimal user_ref (v1 accepts only the decimal id)", async () => {
    const res = await postGrant(overallBody({ user_ref: "alice" }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404s an unknown activity target", async () => {
    const res = await postGrant(
      overallBody({ scope: "activity", target: 999999, source_ref: "x" }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(countGrants()).toBe(0);
  });

  it("404s an unknown group target", async () => {
    const res = await postGrant(overallBody({ scope: "group", target: 999999, source_ref: "x" }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(countGrants()).toBe(0);
  });

  it("400s an unknown field in the body (strict)", async () => {
    const res = await postGrant(overallBody({ surprise: true }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
