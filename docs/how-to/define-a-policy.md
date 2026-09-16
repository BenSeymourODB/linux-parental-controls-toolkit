# How to define a policy

A **policy** is what the dashboard enforces on a supervised user: which
apps and sites they can use, and for how long. This guide walks the pieces
in the order you build them. The full policy model — entities, the
resolution engine, timezones — is in
[`architecture.md`](../architecture.md) → "Policy model"; this is the
task-oriented path through it.

Everything here is done from the dashboard's admin UI (a single `/admin`
shell that switches between views — Users, Clients, Activities, Budgets,
Schedules, and so on) or directly against the `/api/*` JSON contract the UI
calls. The API routes are given for each step as the authoritative
reference; all of them are admin-guarded.

> **A `User` is a supervised person, not a login.** The policy-model
> `User` is who you are limiting — it is not an account that can log in to
> the dashboard. There is one admin login for the whole dashboard (see
> [`server-deployment.md`](../server-deployment.md) → "Authentication").

## 1. Create the supervised users

Create one `User` per supervised person.

- `GET /api/users`, `POST /api/users` (`{ displayName, tz? }`),
  `GET`/`PATCH`/`DELETE /api/users/:id`.
- `tz` is an optional IANA timezone (e.g. `America/New_York`). Leave it
  unset to inherit the server default (`PCT_DEFAULT_TZ`). A user's
  effective timezone is what decides when their daily/weekly/monthly
  budgets **roll over** (see
  [`adr/0001-budget-timezone.md`](../adr/0001-budget-timezone.md)).

## 2. Register the clients and link OS logins

A `Client` is an enrolled machine. The usual way to create one is to
[enrol it](enrol-a-client.md) — enrolment creates the `Client` row and
links the supervised users' local logins for you. You can also manage
these directly:

- Clients: `GET /api/clients`, `POST /api/clients`
  (`{ hostname, sshUser, friendlyName? }`), `GET`/`PATCH`/`DELETE
  /api/clients/:id`.
- Link a user to a client (the local login they use on it):
  `GET /api/users/:userId/clients`,
  `PUT /api/users/:userId/clients/:clientId` (`{ osUsername, osUserRef }`),
  `DELETE /api/users/:userId/clients/:clientId`.

`osUsername` is the local login name; `osUserRef` is the account reference
(the Linux uid). Deleting a link pushes an **unrestricted** `timekpra`
config to that account so an unlinked user is not left enforced by stale
limits (see [`architecture.md`](../architecture.md) → "Outbound … policy
push").

## 3. Define the activities you want to limit

An `Activity` is a matcher for an app or a website; group related ones into
an `ActivityGroup` (e.g. "Games", "Social") to budget or schedule them
together.

- Activities: `GET`/`POST /api/activities`
  (`{ kind, matcher, matchType }`), `GET`/`PATCH`/`DELETE
  /api/activities/:id`.
  - `kind` is one of `app` / `app_group` / `domain` / `domain_group`.
  - `matchType` is `exact` (default) / `substring` / `glob` / `regex`; a
    `regex` matcher is validated to compile. The matcher grammar and its
    precedence are in
    [`adr/0006-activity-matcher-grammar.md`](../adr/0006-activity-matcher-grammar.md).
- Activity groups: `GET`/`POST /api/activity-groups`,
  `GET`/`PATCH`/`DELETE /api/activity-groups/:id`; add/remove members with
  `GET /api/activity-groups/:groupId/activities` and
  `PUT`/`DELETE /api/activity-groups/:groupId/activities/:activityId`.

## 4. Set the time budgets

A `Budget` caps how many seconds a user gets in a rolling window.

- `GET /api/budgets?userId=`, `POST /api/budgets`, `GET`/`PATCH`/`DELETE
  /api/budgets/:id`.
- Body: `{ userId, scope, targetId, window, secondsAllowed, recurrenceDays? }`.
  - `scope` is `overall` (the whole session), `activity`, or `group`
    (`targetId` points at the activity or group).
  - `window` is `daily` / `weekly` / `monthly`.
  - `recurrenceDays` (a 7-bit weekday mask, **daily budgets only**) lets a
    daily cap vary by weekday — e.g. more time at the weekend (see
    [`adr/0013-weekday-varying-budgets.md`](../adr/0013-weekday-varying-budgets.md)).

Budgets are the **baseline**; reward time added through
[grants](../architecture.md#external-integrations) is a separate additive
layer on top, never a replacement.

## 5. Add schedules (when things are allowed or denied)

A `Schedule` says when a target is allowed, denied, or extended. Rules are
evaluated **first-match-wins by `ordinal`**.

- `GET /api/schedules?userId=`, `POST /api/schedules`, `GET`/`PATCH`/`DELETE
  /api/schedules/:id`.
- Body: `{ userId, targetKind, targetId, action, ordinal? }` plus the
  recurrence fields (`recurrenceDays`, an intra-day start/end minute, and
  optional `effectiveFrom`/`effectiveTo` date bounds). A rule with no
  recurrence and no date window is the degenerate **always-on** case. The
  grammar is in
  [`adr/0005-recurrence-and-date-scoping.md`](../adr/0005-recurrence-and-date-scoping.md).
- Reorder a user's rules with `GET`/`PUT /api/users/:userId/schedules/order`
  (`{ orderedIds }`); precedence itself is
  [`adr/0004-schedule-precedence.md`](../adr/0004-schedule-precedence.md).

One-off, date-anchored overrides ("no screen time on the 30th", "extra hour
this Saturday") are `Exception`s: `GET /api/exceptions?userId=`,
`POST /api/exceptions`, `GET`/`PATCH`/`DELETE /api/exceptions/:id`.

## 6. (Optional) define policy once for a group of users

To set a rule once for several kids and let an individual's own rule
override it, use **user groups**.

- User groups: `GET`/`POST /api/user-groups`, `GET`/`PATCH`/`DELETE
  /api/user-groups/:id`; membership via
  `GET /api/user-groups/:groupId/members`,
  `GET /api/users/:userId/groups`.
- Group-level rules mirror the per-user ones, keyed on the group:
  `.../user-groups/:groupId/schedules`, `.../budgets`, `.../exceptions`
  (create + list), and `GET`/`PATCH`/`DELETE` on
  `/api/group-schedules/:id`, `/api/group-budgets/:id`,
  `/api/group-exceptions/:id`.

At resolution, **a member's own rule wins over an inherited group rule**;
group ties break by ascending group id. This is
[`adr/0007-group-targeted-policy-rules.md`](../adr/0007-group-targeted-policy-rules.md)
for schedules,
[`adr/0008-group-targeted-budgets.md`](../adr/0008-group-targeted-budgets.md)
for budgets, and
[`adr/0012-date-specific-override-composition.md`](../adr/0012-date-specific-override-composition.md)
for exceptions. (Two ADRs share the number 0007 — cite them by filename to
avoid confusion with the event-stream one.)

## 7. Preview and push

Before relying on a policy, check what it actually resolves to and push it
to the client(s):

- **Effective policy for a user:** `GET /api/users/:userId/effective` and
  `GET /api/users/:userId/budgets/resolved`.
- **Preview a change** without saving:
  `POST /api/users/:userId/policy-preview`.
- **Push now** to the linked client(s):
  `POST /api/users/:userId/policy-push` (`{ clientId? }`). Mutating policy
  writes already push in the background through the offline queue; this is
  the manual "apply now" lever.
- **Add time today** (a same-day, ephemeral nudge that does *not* change
  the standing budget): `POST /api/users/:userId/time-today` (exactly one
  of `deltaSeconds` / `setSeconds`, optional `clientId`). The durable,
  auditable path for bonus time is the grant ledger (see
  [`architecture.md`](../architecture.md) → "External integrations").

## Related how-tos

- [Enrol a client](enrol-a-client.md) — get a machine under management
  first.
- [Set up DNS filtering](set-up-dns-filtering.md) — add a network-level
  block on top of the client-side web filter.
