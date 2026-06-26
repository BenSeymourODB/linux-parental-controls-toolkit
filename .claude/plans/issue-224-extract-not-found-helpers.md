# Issue #224 — Extract repeated 404 "not found" checks (`api/policy/routes.ts`)

Code-review finding (separation-of-concerns, Medium). The 1017-line policy
routes module repeats the same `404 not_found` boilerplate across ~40 sites in
the GET/PATCH/DELETE/PUT/POST handlers for Users, Clients, links, Activities,
Activity Groups, User Groups, members, Budgets, Schedules, and Exceptions. If
the 404 shape ever changes it must be edited in ~40 places.

## Three recurring shapes

1. **get-returns-row → 404** — `const row = repo.getX(db, id); if (row === undefined) throw ApiError(404, "not_found", `X ${id} not found`); …`
   Appears in every `GET /:id`, and in PATCH/DELETE where the handler re-fetches
   `existing` (to validate or to resolve the affected clients before a push), and
   in PATCH where the row comes back from the `update*` call.
2. **referenced-entity existence guard → 404** — `if (repo.getUser(db, id) === undefined) throw 404` before creating a Budget/Schedule/Exception, before
   listing a user's links/groups, and at both ends of a link/membership PUT.
   The return value is discarded; only the guard matters.
3. **boolean delete/remove → 404** — `if (!repo.deleteX(db, id)) throw 404`.
   Most carry the standard `` `${entity} ${id} not found` `` message; three
   relational removals carry a custom message (link, activity↔group, user↔group).

`assertTarget` (lines 104–132) is **not** in scope: its activity/group checks
throw a **400 `validation_error`** target-coherence error, a different contract
from a 404 — it stays exactly as-is.

## Approach

Add three small helpers at the top of `routes.ts`, next to the existing
`asConflict` / `asValidated` / `assertTarget`, so the `(404, "not_found")` tuple
and the `=== undefined` / `!removed` checks live in one place:

```ts
/** Build the shared `404 not_found` envelope error. */
function notFound(message: string): ApiError {
  return new ApiError(404, "not_found", message);
}

/** Return `row` if present, else throw `404 not_found` naming the entity. */
function assertFound<T>(row: T | undefined, entity: string, id: number): T {
  if (row === undefined) {
    throw notFound(`${entity} ${id} not found`);
  }
  return row;
}

/** Throw `404 not_found` when a delete/remove reports the row was absent. */
function assertRemoved(removed: boolean, message: string): void {
  if (!removed) {
    throw notFound(message);
  }
}
```

- Shape 1 → `const row = assertFound(repo.getX(...), "X", id);` (and
  `assertFound(asConflict(() => repo.updateX(...), msg), "X", id)` where a write
  is conflict-mapped first).
- Shape 2 → `assertFound(repo.getUser(...), "User", userId);` (return discarded).
- Shape 3 → `assertRemoved(repo.deleteX(...), `X ${id} not found`);` and the
  three relational variants keep their custom message.

Messages are byte-for-byte identical to today, so observable behaviour does not
change. Helpers stay in `routes.ts` (not a new `service.ts`) to keep the PR
minimal and not pre-empt the file-decomposition decision tracked in #225.

## Tests

- `tests/api/policy.test.ts` already asserts `404` + `not_found` at every site
  (status/code, not message text) — the regression safety net. It must stay
  green unchanged (never weakened).
- New focused unit tests `tests/api/policy-not-found-helpers.test.ts` for the
  helpers themselves: `assertFound` returns the row when present and throws an
  `ApiError(404, "not_found", "<Entity> <id> not found")` when `undefined`;
  `assertRemoved` is a no-op when `true` and throws the supplied-message
  `ApiError(404, "not_found", …)` when `false`; assert `statusCode`/`code`/`message`.

## License-boundary note

None touched — plain TypeScript + zod + Drizzle. No transport, packaging, or
Docker image change; `license-guard` unaffected. No new dependency.

## Quality gate

`npm run format` → `lint:fix` → `typecheck` → `test` (coverage ≥ 80%) from
`server/`. The helper unit tests keep the new lines covered; the refactor only
moves existing covered lines.
