// Capture dashboard screenshots from a *running* instance and (re)generate the
// docs/screenshots gallery. Designed to run inside the official Playwright
// container (see run.sh), talking to the app over a shared Docker network, so
// no host browser install is needed.
//
// It is self-adapting: the admin nav is enumerated at runtime, so every
// implemented view is captured and a brand-new view shows up automatically
// (flagged in the manifest as "uncaptioned" so the operator wires it into the
// READMEs). Sample data (Alice / Bob / Chloe, mint-* clients) is seeded through
// the same /api the frontends use, via Playwright's request context — the login
// cookie is shared with the browser pages.
//
// Env:
//   APP_URL     base URL of the running dashboard (default http://pct-shots-app:8000)
//   ADMIN_USER  admin username (default "admin")
//   ADMIN_PASS  admin password (default "screenshot-demo-pw")
//   OUT         output directory (default /work)
// playwright-core (not "playwright") drives the browsers already baked into the
// official Playwright image; run.sh installs it at runtime.
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const APP_URL = process.env.APP_URL ?? "http://pct-shots-app:8000";
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "screenshot-demo-pw";
const OUT = process.env.OUT ?? "/work";

const ADMIN_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 414, height: 896 };

// Stable, human-readable captions keyed by the screenshot slug. New views that
// have no entry here are still captured — they just get a placeholder caption
// and are reported so a human can write a real one.
const CAPTIONS = {
  login: "Single-admin login (Argon2id, signed session cookie).",
  "admin-dashboard": "The landing view — a welcome panel today; KPI tiles and burndown rings are still on the roadmap.",
  "admin-users": "Supervised user accounts (display name + effective timezone) that limits attach to.",
  "admin-clients": "Basic CRUD for the enrolled Linux desktops (hostname + SSH user).",
  "admin-client-health": "Per-machine reachability and five-component health, plus queued-change state for offline clients.",
  "admin-client-health-enrol": "Minting an enrolment token produces the `curl … | sudo bash` install one-liner for a fresh Mint box.",
  "admin-user-client-links": "Maps a policy user to an OS account on a client, with a one-off \"Add time today\" lever.",
  "admin-activities": "App/domain matchers (exact/substring/glob/regex) that budgets and schedules target.",
  "admin-activity-groups": "Named bundles of activities so one limit can cover a whole set; expand to manage members.",
  "admin-budgets": "Time allowances per user and rollover window, scoped to overall time, an activity, or a group.",
  "admin-schedules": "Recurring allow/deny/extend rules (day/time windows and reordering are still to come).",
  "admin-exceptions": "One-off, date-boxed overrides — e.g. \"finished chores → bonus weekend time\".",
  "admin-integrations": "Scoped, revocable API tokens for external systems (e.g. the family calendar).",
  "admin-audit-log": "Newest-first record of every command issued to a client, filterable by client and outcome.",
  "app-pwa": "The installable mobile/PWA surface — currently the app shell; live status screens land later.",
};

// The handful of shots the root README embeds. Used only to warn if one stops
// being produced (e.g. a highlighted view was renamed/removed).
const ROOT_README_HIGHLIGHTS = [
  "admin-client-health",
  "admin-client-health-enrol",
  "admin-budgets",
  "admin-integrations",
  "app-pwa",
];

const slugify = (label) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function log(...a) {
  console.log("[capture]", ...a);
}

/** Seed illustrative data through /api. `req` carries the admin session cookie. */
async function seed(req) {
  const post = async (path, body) => {
    const r = await req.post(`/api${path}`, { data: body });
    if (!r.ok()) throw new Error(`POST ${path} -> ${r.status()} ${await r.text()}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };
  // Membership attach is an idempotent PUT with NO body — sending an empty JSON
  // body makes Fastify reject it, so pass none.
  const put = async (path) => {
    const r = await req.put(`/api${path}`);
    if (!r.ok()) throw new Error(`PUT ${path} -> ${r.status()} ${await r.text()}`);
  };
  const id = (o) => o.id;

  const alice = id(await post("/users", { displayName: "Alice", tz: "America/New_York" }));
  const bob = id(await post("/users", { displayName: "Bob", tz: "America/New_York" }));
  const chloe = id(await post("/users", { displayName: "Chloe", tz: null }));

  const liv = id(await post("/clients", { hostname: "mint-livingroom", sshUser: "pctadmin" }));
  const bed = id(await post("/clients", { hostname: "mint-bedroom", sshUser: "pctadmin" }));
  const stu = id(await post("/clients", { hostname: "mint-study", sshUser: "pctadmin" }));

  const act = async (kind, matcher, matchType) =>
    id(await post("/activities", { kind, matcher, matchType }));
  const minecraft = await act("app", "minecraft", "substring");
  const steam = await act("app", "steam", "substring");
  const youtube = await act("domain", "youtube.com", "substring");
  const tiktok = await act("domain", "tiktok.com", "substring");
  const khan = await act("domain", "khanacademy.org", "substring");
  const libre = await act("app", "libreoffice", "substring");

  const games = id(await post("/activity-groups", { name: "Games" }));
  const social = id(await post("/activity-groups", { name: "Social media" }));
  const school = id(await post("/activity-groups", { name: "School & homework" }));
  await put(`/activity-groups/${games}/activities/${minecraft}`);
  await put(`/activity-groups/${games}/activities/${steam}`);
  await put(`/activity-groups/${social}/activities/${tiktok}`);
  await put(`/activity-groups/${social}/activities/${youtube}`);
  await put(`/activity-groups/${school}/activities/${khan}`);
  await put(`/activity-groups/${school}/activities/${libre}`);

  await post("/budgets", { userId: alice, scope: "overall", window: "daily", secondsAllowed: 7200 });
  await post("/budgets", { userId: alice, scope: "group", targetId: games, window: "daily", secondsAllowed: 3600 });
  await post("/budgets", { userId: alice, scope: "activity", targetId: youtube, window: "daily", secondsAllowed: 2700 });
  await post("/budgets", { userId: bob, scope: "overall", window: "daily", secondsAllowed: 5400 });
  await post("/budgets", { userId: bob, scope: "group", targetId: social, window: "weekly", secondsAllowed: 10800 });
  await post("/budgets", { userId: chloe, scope: "overall", window: "daily", secondsAllowed: 9000 });

  await post("/schedules", { userId: alice, targetKind: "group", targetId: school, action: "allow" });
  await post("/schedules", { userId: alice, targetKind: "group", targetId: games, action: "deny" });
  await post("/schedules", { userId: bob, targetKind: "overall", action: "allow" });

  // 24h from now, expressed as a UTC instant. Date math is fine here (this
  // script is not a workflow); the value only affects the rendered "expires".
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await post("/exceptions", { userId: alice, targetKind: "overall", action: "extend", reason: "Finished chores - bonus weekend time", expiresAt: tomorrow });
  await post("/exceptions", { userId: bob, targetKind: "group", targetId: games, action: "deny", reason: "Exam week - games paused", expiresAt: tomorrow });

  // Links require osUsername/osUserRef, so they use a bodied PUT.
  const link = async (userId, clientId, osUsername, osUserRef) => {
    const r = await req.put(`/api/users/${userId}/clients/${clientId}`, {
      data: { osUsername, osUserRef },
    });
    if (!r.ok()) throw new Error(`link -> ${r.status()} ${await r.text()}`);
  };
  await link(alice, liv, "alice", "1001");
  await link(bob, bed, "bob", "1002");
  await link(chloe, stu, "chloe", "1003");

  await post("/integrations/tokens", { name: "family-calendar", scopes: ["grants:write", "policy:read"] });
  await post("/integrations/tokens", { name: "home-assistant", scopes: ["grants:write"] });

  log("seeded sample data");
}

/** Best-effort per-view interaction to make the shot richer. */
async function enhance(slug, page, shot) {
  if (slug === "admin-user-client-links") {
    try {
      await page.locator("select").first().selectOption({ label: "Alice" });
      await page.waitForTimeout(600);
    } catch (e) {
      log("links enhance skipped:", e.message);
    }
  }
  if (slug === "admin-activity-groups") {
    try {
      const members = page.getByRole("button", { name: /^Members$/ });
      if (await members.count()) {
        await members.first().click();
        await page.waitForTimeout(400);
      }
    } catch (e) {
      log("activity-groups enhance skipped:", e.message);
    }
  }
  if (slug === "admin-client-health") {
    // Capture the view first, then drive the enrol flow into its own shot.
    try {
      await page.locator("select").first().selectOption({ label: "Chloe" });
      await page.fill('input[placeholder*="OS username" i]', "chloe");
      await page.fill('input[placeholder*="hostname" i]', "mint-kitchen");
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: /Generate enrolment token/i }).first().click({ timeout: 5000 });
      await page.waitForTimeout(1000);
      await shot("admin-client-health-enrol");
    } catch (e) {
      log("enrol enhance skipped:", e.message);
    }
  }
}

function renderGallery(manifest) {
  const cap = (slug) => CAPTIONS[slug] ?? `_TODO: caption for \`${slug}\`._`;
  const section = (entries) =>
    entries
      .map((e) => `### ${e.label}\n${cap(e.slug)}\n\n![${e.label}](${e.file})`)
      .join("\n\n");

  // Login is the admin entry point, so render it at the top of the admin group.
  const admin = manifest.filter((e) => e.group === "login" || e.group === "admin");
  const app = manifest.filter((e) => e.group === "app");

  return `# Dashboard screenshots

> **Generated** by \`/update-screenshots\` (\`scripts/screenshots/\`). Do not edit
> by hand — re-run the command after a UI change. Captures come from a fresh,
> ephemeral instance seeded with illustrative data (Alice / Bob / Chloe,
> \`mint-*\` clients) via \`/api\`.

These reflect **what is built today**, not the full design vision in
[\`../../design/\`](../../design/); the [roadmap](../roadmap.md) tracks the gap.
The admin experience is one prerendered page that switches views with
client-side state.

## Admin surface

${section(admin)}

## App (PWA) surface

${section(app)}
`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // Start clean so removed views don't leave orphaned PNGs behind.
  for (const f of readdirSync(OUT)) {
    if (f.endsWith(".png")) rmSync(`${OUT}/${f}`);
  }

  const manifest = [];
  const browser = await chromium.launch();

  // --- Login screenshot (unauthenticated, fresh context) ---
  const anonCtx = await browser.newContext({ viewport: ADMIN_VIEWPORT, deviceScaleFactor: 2 });
  const anonPage = await anonCtx.newPage();
  await anonPage.goto(`${APP_URL}/admin`, { waitUntil: "networkidle" });
  await anonPage.waitForSelector("form.card h1", { timeout: 15000 });
  await anonPage.waitForTimeout(400);
  await anonPage.screenshot({ path: `${OUT}/login.png` });
  manifest.push({ slug: "login", label: "Sign in", file: "login.png", group: "login" });
  log("shot login");
  await anonCtx.close();

  // --- Authenticated context: log in + seed via request, screenshot via pages ---
  const ctx = await browser.newContext({ baseURL: APP_URL, viewport: ADMIN_VIEWPORT, deviceScaleFactor: 2 });
  const loginRes = await ctx.request.post("/api/auth/login", {
    data: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  if (!loginRes.ok()) throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`);
  await seed(ctx.request);

  const page = await ctx.newPage();
  await page.goto(`${APP_URL}/admin`, { waitUntil: "networkidle" });
  await page.waitForSelector("aside.sidebar", { timeout: 15000 });

  const shot = async (slug, label) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${slug}.png` });
    if (label) manifest.push({ slug, label, file: `${slug}.png`, group: "admin" });
    log("shot", slug);
  };

  // Enumerate the nav at runtime so every implemented view is captured.
  const labels = await page.$$eval("aside.sidebar nav button", (els) =>
    els.map((e) => e.textContent.trim()).filter(Boolean),
  );
  log("nav views:", labels.join(", "));

  for (const label of labels) {
    await page.click(`nav button:has-text("${label}")`);
    await page.waitForTimeout(700);
    const slug = `admin-${slugify(label)}`;
    await shot(slug, label);
    await enhance(slug, page, (s) => {
      manifest.push({ slug: s, label: `${label} — enrol a client`, file: `${s}.png`, group: "admin" });
      return shot(s);
    });
  }

  // --- PWA surface (mobile viewport) ---
  const mobCtx = await browser.newContext({ viewport: MOBILE_VIEWPORT, deviceScaleFactor: 2 });
  const mob = await mobCtx.newPage();
  await mob.goto(`${APP_URL}/app`, { waitUntil: "networkidle" });
  await mob.waitForTimeout(600);
  await mob.screenshot({ path: `${OUT}/app-pwa.png` });
  manifest.push({ slug: "app-pwa", label: "My Time (PWA shell)", file: "app-pwa.png", group: "app" });
  log("shot app-pwa");

  await browser.close();

  // --- Outputs: gallery README + manifest, with a report of anything new ---
  writeFileSync(`${OUT}/README.md`, renderGallery(manifest));
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");

  const uncaptioned = manifest.filter((e) => !CAPTIONS[e.slug]).map((e) => e.slug);
  const present = new Set(manifest.map((e) => e.slug));
  const missingHighlights = ROOT_README_HIGHLIGHTS.filter((s) => !present.has(s));

  log(`captured ${manifest.length} screenshots`);
  if (uncaptioned.length) log("NEW/UNCAPTIONED views (add a caption in capture.mjs + wire into READMEs):", uncaptioned.join(", "));
  if (missingHighlights.length) log("ROOT README highlight no longer produced (pick a replacement):", missingHighlights.join(", "));
  console.log(JSON.stringify({ captured: manifest.length, uncaptioned, missingHighlights }));
}

main().catch((e) => {
  console.error("[capture] FAILED:", e);
  process.exit(1);
});
