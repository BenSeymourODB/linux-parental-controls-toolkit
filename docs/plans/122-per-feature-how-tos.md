# Plan — #122: Documentation pass — per-feature how-tos (Slice 1)

Umbrella tracker [#122](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/122)
(Phase 11 in [`docs/roadmap.md`](../roadmap.md)) asks for task-oriented
how-to guides "once the features they describe have landed", worked
**incrementally** as each feature merges. This plan scopes the **first
slice**: create a `docs/how-to/` directory of guides for the features that
are **fully merged on `main`**, link them from `README.md`, and keep them
consistent with the authoritative design-doc set in `docs/`.

## Why a slice, not the whole issue

The issue is explicitly the umbrella tracker ("best filed/worked
incrementally"). Three of its listed how-tos describe features that are
still in flight on open PRs and so cannot be documented accurately yet:

- **Grant time** — the idempotent grant endpoint (#113) is on open PR #422.
- **Read the burndown views** — usage views into `/admin` user-detail are
  still landing (#280).
- **Per-client DNS blocklists** — #97 is on open PR #424 (the AdGuard
  _modes_ setup, which this slice covers, is already merged; the per-client
  blocklist editor is not).

Those get their own how-to as each feature lands; #122 stays open as the
umbrella. This slice ships the guides whose features are on `main` today.

## Scope — how-tos in this slice

Each guide is task-oriented (numbered steps a real admin follows), grounded
in the shipped API/admin UI/install scripts, and cross-links the design doc
that already covers the underlying design rather than duplicating it.

1. **`docs/how-to/enrol-a-client.md`** — generate an enrolment token in the
   dashboard, run the client install one-liner (`install-client.sh` +
   `install-baseline-tools.sh`), what the end-of-install self-test checks,
   and how to confirm the client is healthy. Cross-links
   `docs/client-install.md`.
2. **`docs/how-to/define-a-policy.md`** — create users and clients, link
   OS logins, define activities and activity groups, set daily/weekly/
   monthly budgets and schedules, and use group schedules with per-user
   override precedence. Cross-links `docs/architecture.md` (policy model)
   and the relevant ADRs (0001 timezone, 0005 recurrence, 0007 precedence).
3. **`docs/how-to/set-up-dns-filtering.md`** — configure AdGuard Home in
   each of the three modes (`disabled` / `managed` / `external`) via the
   `PCT_ADGUARD_*` env vars. Cross-links `docs/server-deployment.md`.
4. **`docs/how-to/issue-an-integration-token.md`** — create a scoped,
   revocable integration API token for an external integrator (the family
   calendar being the first). Cross-links `docs/architecture.md`
   ("External integrations").
5. **`docs/how-to/recover-from-backup.md`** — the `/data` volume layout,
   the automatic pre-migration backup, and how to restore. Cross-links
   `docs/server-deployment.md`.

Plus a **`docs/how-to/README.md`** index, and a **README.md** link into the
how-to set.

## Ground rules

- **Accuracy over completeness.** Every route path, env var, config key and
  script name is verified against the code before it is written down. If a
  step can't be verified as shipped, it isn't documented in this slice.
- **No new decisions.** How-tos describe existing behaviour; they never
  introduce policy the design docs don't already record. If a doc gap forces
  a decision, stop and raise it in the issue instead.
- **Consistency.** Terminology and structure match the existing `docs/`
  set; links are relative and resolve within the repo.

## Validation

- `cd server && npm run format:check` (Prettier formats `.md`) must pass;
  run `npm run format` first to normalise.
- `npm run lint`, `npm run typecheck`, `npm test` are unaffected (docs-only,
  no source change) but are run as the standard gate before marking ready.
- Manual link check: every relative link in the new files resolves to a
  real path in the repo.

## License / tamper-resistance

N/A — documentation only. No transport, packaging, or Docker-image change;
no GPL linkage; nothing touching the tamper-resistance ceiling.

## Deferred (tracked, keeps #122 open)

- Grant-time how-to → after #113 (PR #422) merges.
- Burndown/usage-views how-to → after #280.
- Per-client DNS blocklist how-to → after #97 (PR #424) merges.
