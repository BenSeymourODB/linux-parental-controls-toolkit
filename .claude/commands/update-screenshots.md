---
description: Regenerate docs/screenshots and the README product shots from the current dashboard UI. Run after any significant UI change (new/removed admin view, nav restructure, login/app-shell or theme redesign).
---

# Update screenshots

Regenerate the product screenshots in [`docs/screenshots/`](../../docs/screenshots/)
and the curated highlights embedded in the **root README** so they reflect the
**current** state of the dashboard UI.

**When to run this:** after a *significant UI change* — a new or removed admin
view, a nav restructure, a redesign of the login screen / app shell / theme, or
anything else that changes what these screenshots show. Skip it for pure
backend, copy, or non-visual changes; the images don't need to churn for those.

Read `CLAUDE.md` first. This command only ever runs the dashboard and a browser
across process boundaries (Docker) and reads the JSON `/api` — it introduces no
GPL linkage and bundles no GPL binaries (the dashboard image is built from
`server/`; the Playwright image is pulled, never committed).

## How it works

Everything is driven by [`scripts/screenshots/`](../../scripts/screenshots/):

- **`run.sh`** — builds the dashboard image from `server/`, starts a
  **throwaway, freshly-seeded** instance on a private Docker network (your
  `./data` and any running `docker compose` are left untouched), drives headless
  Chromium via the official Playwright image, writes the output into
  `docs/screenshots/`, then tears everything down. **Docker is the only
  prerequisite** — no host browser install.
- **`capture.mjs`** — logs in, seeds illustrative data (Alice / Bob / Chloe,
  `mint-*` clients) through `/api` using Playwright's request context, then
  **enumerates the admin nav at runtime** and screenshots every view (plus the
  login screen, the client-enrolment one-liner, and the `/app` PWA shell). It
  writes the PNGs, a generated gallery `README.md`, and a `manifest.json`.

Because the nav is enumerated live, a newly-added view is captured
automatically — it just needs a caption (see below).

## Steps

1. **Run the capture:**
   ```bash
   scripts/screenshots/run.sh
   ```
   It prints a final JSON line, e.g.
   `{"captured":15,"uncaptioned":[],"missingHighlights":[]}`.

2. **Handle new/changed views** (`uncaptioned` non-empty): a view exists with no
   caption. Add a human-written caption for its slug to the `CAPTIONS` map in
   `scripts/screenshots/capture.mjs`, then re-run `run.sh`. Captions must stay
   **honest** — distinguish what's built from what's still on the
   [roadmap](../../docs/roadmap.md), matching the tone of the existing entries.

3. **Keep the root README in sync.** The root `README.md` "Screenshots" section
   embeds a curated few shots and links to the full
   [`docs/screenshots/`](../../docs/screenshots/) gallery. The gallery
   `README.md` is regenerated for you; you only need to touch the root README
   if:
   - a highlighted shot stopped being produced (`missingHighlights` non-empty) —
     pick a sensible replacement from the manifest; or
   - a change is significant enough that a different view is now the best
     "hero" shot.
   The current highlight set is: `admin-clients`,
   `admin-clients-enrol`, `admin-budgets`, `admin-integrations`,
   `app-pwa`.

4. **Review the images** before committing — open a couple (especially any new
   or changed view) and confirm they rendered with the seeded data and aren't
   blank or mid-load.

5. **Commit on a `claude/*` branch and open a PR** (per `CLAUDE.md` →
   "Working on this repo"). Stage `docs/screenshots/` and any README/caption
   edits; never stage `.env` or `./data`.

## Notes

- The captures are deterministic given the same UI + seed data, so re-running
  on an unchanged UI should produce a no-op diff (aside from any timestamps the
  views render).
- Filenames are stable slugs derived from the nav label
  (`admin-<view>.png`), so inserting a view in the middle of the nav does **not**
  renumber the others — only the new file appears.
- To preview against an instance you already have running instead of the
  throwaway one, run `capture.mjs` directly with `APP_URL`, `ADMIN_USER`,
  `ADMIN_PASS`, and `OUT` set (it needs `playwright-core` on the path; the
  Docker path in `run.sh` handles that for you).
- **Automating the trigger:** "significant UI change" is a judgment call, so
  this is intentionally a command rather than an unconditional hook. If you want
  a nudge, wire a CI job or a Claude Code `Stop`/`PostToolUse` hook that flags
  when files under `server/frontend/src/` changed and these screenshots didn't —
  but let a human decide whether to regenerate.
