# Plan — #309: Extract `buildAppServices` composition root from `buildApp`

**Issue:** [#309](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/309)
(code-review / complexity / Medium, tracking epic #308)
**Roadmap:** N/A (code-quality cleanup); target `server/src/web/app.ts`.
**Branch:** `claude/youthful-allen-ds7elx`

## Problem

`buildApp` (`server/src/web/app.ts`) has grown to ~150 lines. Beyond building
the Fastify instance and registering routes it now also *constructs and owns*
seven independent subsystems — the policy DB, the policy-push transport, the
event hub, the managed-AdGuard supervisor, the AdGuard service, the AdGuard
health-poll teardown, and the Ansible venv supervisor — each with a
`??`-injection seam and conditional (`managed`-mode) init. Each new
transport/supervisor adds more construction noise before the reader reaches the
route wiring.

## Goal

Extract a **composition root** `server/src/web/app-services.ts` exposing:

```ts
buildAppServices(options, settings, log) -> AppServices
```

where `AppServices` carries the constructed services plus a single `teardown()`
that disposes exactly the resources the composition root *owns*. `buildApp` then
reads top-down: build Fastify → build services → decorate → register teardown /
ready hooks → register routes.

**This is a pure, behaviour-preserving refactor.** No public surface changes:
`buildApp` and `BuildAppOptions` keep their exact signatures and semantics
(they are consumed by `main.ts`, `tests/helpers/app.ts`, and ~10 test files).
Every decorator (`db`, `eventHub`, `adguard`, `adguardManaged`,
`adguardHealthPoll`, `ansibleVenv`) stays present and identical, because
`main.ts` reads them after `listen`.

## Behaviour that MUST be preserved (verified against current `app.ts`)

- **Injection seams** (`options.db/adguard/ansibleVenv/adguardManaged/policyPush`):
  `??`/explicit-`undefined` semantics unchanged. `adguardManaged` honours an
  explicitly-injected `null`.
- **Ownership → teardown:**
  - `policyPush.dispose()` only when `buildApp` created it (`ownsPolicyPush`),
    and it must run **before** the db is closed (it reads the db).
  - `db.$client.close()` only when `buildApp` created it (`ownsDb`).
  - `adguardManaged.stop()` whenever it is non-null — **regardless of ownership**
    (current code stops an injected supervisor too).
  - `adguardHealthPoll?.stop()` reads the *decorator* at close time (assigned by
    `main.ts` after `listen`) — stays a `buildApp` hook, not folded into
    `teardown()`.
- **Ready hook:** `adguard.runPreflight(app.log)` on `onReady` (disabled mode =
  no-op).
- **`managed`-mode ordering:** the supervisor is built **before** the AdGuard
  service so it can be wired in as the service's `managed` source (#283).
- **Logger threading:** `createDb`, `createPolicyPushTransport`, and
  `runPreflight` all receive `app.log` — so the composition root takes the
  logger as a parameter (Fastify must exist first).
- Independent resources (`adguardManaged` vs `policyPush`/`db`) tear down in an
  order that does not matter; `adguardHealthPoll` still stops first (its hook is
  registered last → Fastify LIFO).

## Design

`AppServices`:

```ts
export interface AppServices {
  db: PolicyDb;
  policyPush: PolicyPushTransport;
  eventHub: EventHub;
  adguard: AdGuardService;
  adguardManaged: AdGuardManagedSupervisor | null;
  ansibleVenv: AnsibleVenvSupervisor;
  /** Dispose only the resources buildAppServices created (+ stop a non-null
   *  managed supervisor). Registered as buildApp's owned-resource onClose. */
  teardown: () => Promise<void>;
}
```

`buildAppServices(options, settings, log)` moves the db/policyPush/eventHub/
adguardManaged/adguard/ansibleVenv construction verbatim, captures
`ownsDb`/`ownsPolicyPush` in the closure, and returns the services + a
`teardown` closure implementing the ownership rules above.

`buildApp` shrinks to: derive `settings`, build Fastify, `buildAppServices`,
`app.decorate(...)` ×6, `onClose(services.teardown)`, `onClose` for
`adguardHealthPoll`, `onReady` preflight, then `registerApi` /
`registerInstallScript` / `registerFrontend`.

`BuildAppOptions` + the `declare module "fastify"` decorator augmentation stay
in `app.ts`; `app-services.ts` uses a **type-only** import of `BuildAppOptions`
— type-only imports are erased, so there is no runtime import cycle.

## Tests

- **Existing suite is the primary safety net** — every route/app test builds via
  `buildApp`/`buildTestApp`, so a behavioural regression fails loudly. Run the
  full gate.
- **New `tests/web/app-services.test.ts`** (the finding's "independently
  testable" win):
  - builds all six services from default (disabled) settings + injected db;
  - honours each injection seam (injected db/adguard/ansibleVenv/policyPush/
    adguardManaged=null returned as-is);
  - `managed` mode builds a non-null `adguardManaged`;
  - `teardown()`: disposes an owned policyPush + closes an owned db, in that
    order; does **not** dispose injected ones; stops a non-null (even injected)
    `adguardManaged`. Use spy fakes.

## Quality gate (from `server/`)

`npm run format` · `npm run lint:fix` · `npm run typecheck` · `npm test`
(coverage ≥ 80%). No frontend change. No new dependency. No license-boundary
impact (pure internal TS re-org; AdGuard stays REST-only, Ansible/timekpra stay
subprocess).

## Phases

1. Create `app-services.ts` (move construction + teardown); rewrite `buildApp`
   to consume it. Run gate.
2. Add `app-services.test.ts`; run gate; commit; push (opens draft PR).
