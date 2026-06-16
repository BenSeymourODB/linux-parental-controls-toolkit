/**
 * Pins the policy enum tuples to their derived zod schemas. The schema's
 * SQLite `CHECK` constraints are built from these same tuples (see
 * `src/policy/schema.ts`), so this guards the single-source-of-truth promise:
 * if a value set changes, the zod enum, the DB constraint, and these
 * assertions move together.
 */
import { describe, expect, it } from "vitest";

import {
  activityKindSchema,
  activityKindValues,
  budgetWindowSchema,
  budgetWindowValues,
  scheduleActionSchema,
  scheduleActionValues,
  scopeSchema,
  scopeValues,
} from "../../src/policy/enums.js";

const cases = [
  { name: "scope", schema: scopeSchema, values: scopeValues },
  { name: "budgetWindow", schema: budgetWindowSchema, values: budgetWindowValues },
  { name: "activityKind", schema: activityKindSchema, values: activityKindValues },
  { name: "scheduleAction", schema: scheduleActionSchema, values: scheduleActionValues },
] as const;

describe("policy enums", () => {
  for (const { name, schema, values } of cases) {
    describe(name, () => {
      it("accepts exactly the declared tuple values", () => {
        for (const value of values) {
          expect(schema.parse(value)).toBe(value);
        }
        expect(schema.options).toStrictEqual([...values]);
      });

      it("rejects a value outside the tuple", () => {
        expect(schema.safeParse("definitely-not-a-member").success).toBe(false);
      });
    });
  }

  it("uses the documented value sets", () => {
    expect(scopeValues).toStrictEqual(["overall", "activity", "group"]);
    expect(budgetWindowValues).toStrictEqual(["daily", "weekly", "monthly"]);
    expect(activityKindValues).toStrictEqual(["app", "app_group", "domain", "domain_group"]);
    expect(scheduleActionValues).toStrictEqual(["allow", "deny", "extend"]);
  });
});
