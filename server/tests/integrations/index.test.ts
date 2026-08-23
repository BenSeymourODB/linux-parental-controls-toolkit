/**
 * The `integrations` barrel re-exports the module's public surface (the scope
 * vocabulary, the token lifecycle/auth service, and the guard factory) and tags
 * the module name. This guards that the intended API stays exported (a rename
 * or accidental drop fails here) and that the barrel matches the source
 * modules' own exports (identity, not a stale copy).
 */
import { describe, expect, it } from "vitest";

import * as integrations from "../../src/integrations/index.js";
import * as scopes from "../../src/integrations/scopes.js";
import * as guard from "../../src/integrations/guard.js";
import * as tokens from "../../src/integrations/tokens.js";

describe("integrations index", () => {
  it("tags the module name", () => {
    expect(integrations.moduleName).toBe("integrations");
  });

  it("re-exports the scope vocabulary", () => {
    expect(integrations.INTEGRATION_SCOPES).toBe(scopes.INTEGRATION_SCOPES);
    expect(integrations.INTEGRATION_SCOPES).toContain("grants:write");
    expect(integrations.INTEGRATION_SCOPES).toContain("policy:read");
  });

  it("re-exports the guard factory", () => {
    expect(integrations.makeRequireIntegrationToken).toBe(guard.makeRequireIntegrationToken);
    expect(integrations.makeRequireIntegrationToken).toBeTypeOf("function");
  });

  it("re-exports the token lifecycle + authentication service", () => {
    expect(integrations.issueIntegrationToken).toBe(tokens.issueIntegrationToken);
    expect(integrations.listIntegrationTokenSummaries).toBe(tokens.listIntegrationTokenSummaries);
    expect(integrations.revokeIntegrationToken).toBe(tokens.revokeIntegrationToken);
    expect(integrations.authenticateIntegrationToken).toBe(tokens.authenticateIntegrationToken);
    for (const fn of [
      integrations.issueIntegrationToken,
      integrations.listIntegrationTokenSummaries,
      integrations.revokeIntegrationToken,
      integrations.authenticateIntegrationToken,
    ]) {
      expect(fn).toBeTypeOf("function");
    }
  });
});
