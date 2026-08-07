# Plan — #391: `PCT_TIMEKPR_MIRROR` mode + `/data/apt/timekpr` layout

Part of the server-hosted `timekpr-next` mirror epic (**#389**), the first
implementation slice after the accepted ADR
[`0011-server-hosted-upstream-package-mirror.md`](../adr/0011-server-hosted-upstream-package-mirror.md)
(#390/#396). Roadmap: `docs/roadmap.md` → Phase 14.

## Goal

Add the **config seam** for the mirror — a validated mode + its options + the
documented `/data` layout — with **no runtime behaviour yet**. This is the
contract the later slices build against: the fetch/refresh job (#392), the
signed-index/serve/advertise slice (#393), and the client baseline path (#394).

## Why now / why this shape

ADR 0011 models the mirror on the existing AdGuard Home
`disabled | external | managed` trichotomy (`config.ts` → `adguardSchema`,
ADR 0009). Mirroring that established pattern keeps the config surface
consistent and keeps the license boundary intact by construction: the mirror
lives in the `/data` volume, fetched at runtime, **never baked into the image**
— the same precedent that already lets managed-mode AdGuard Home live in
`/data`. `license-guard.yml` (which scans the image) is unaffected because this
slice ships no binary and no fetch behaviour.

The maintainer's recorded decisions (ADR 0011 → "Confirmed direction", and the
#391 thread) that this schema must honour:

- **Configurable package/channel** — stable `timekpr-next` or a beta variant
  (`timekpr-next-beta`), chosen on the server so a client never has to know
  which channel it gets.
- **Optional pinned version** — mirror the AdGuard `PCT_ADGUARD_VERSION`
  pattern.
- **`/data`-resident** default dir, overridable — mirror the AdGuard `dataDir`
  pattern.

## Design — `timekprMirrorSchema`

A `z.discriminatedUnion("mode", …)` added to `server/src/config.ts` beside
`adguardSchema`, and threaded into `settingsSchema` as `timekprMirror` +
assembled in `loadSettings`:

- **`disabled`** (default) — no fields. Today's behaviour (client installs from
  the distro repo; the PPA stays opt-in).
- **`external`** — `url: z.url()` (required, `PCT_TIMEKPR_MIRROR_URL`): point
  clients at an apt repo the homelab already hosts. Required-ness is enforced by
  `z.url()` on the branch (same as `adguardSchema`'s external `url`), so a
  missing URL fails fast at startup naming the field.
- **`managed`** — the dashboard maintains the mirror under:
  - `dataDir: z.string().min(1).default("/data/apt/timekpr")`
    (`PCT_TIMEKPR_MIRROR_DIR`) — mirrors AdGuard's `dataDir`.
  - `package: z.enum(["timekpr-next", "timekpr-next-beta"]).default("timekpr-next")`
    (`PCT_TIMEKPR_MIRROR_PACKAGE`) — the server-chosen channel.
  - `version: z.string().min(1).optional()` (`PCT_TIMEKPR_MIRROR_VERSION`) —
    optional pinned upstream version, mirrors AdGuard's `version`.

No `superRefine` is needed: the mirror's `external` mode carries no
credentials (unlike AdGuard), so `z.url()` alone covers its one required field.

### Env vars

| Var | Mode | Meaning | Default |
|---|---|---|---|
| `PCT_TIMEKPR_MIRROR` | all | `disabled` \| `external` \| `managed` | `disabled` |
| `PCT_TIMEKPR_MIRROR_URL` | external | apt repo URL the homelab hosts | — (required) |
| `PCT_TIMEKPR_MIRROR_DIR` | managed | `/data` dir the mirror lives under | `/data/apt/timekpr` |
| `PCT_TIMEKPR_MIRROR_PACKAGE` | managed | `timekpr-next` \| `timekpr-next-beta` | `timekpr-next` |
| `PCT_TIMEKPR_MIRROR_VERSION` | managed | optional pinned upstream version | unset |

## Docs

- `docs/server-deployment.md` → "Volume layout": add `apt/timekpr/` under
  `/data`.
- `docs/server-deployment.md`: a new "Timekpr-nExT package mirror deployment
  modes" section mirroring the AdGuard-modes section (modes table +
  configuration example + license posture note that this is the same
  `/data`-resident, image-GPL-free precedent).
- `.env.example`: a commented `PCT_TIMEKPR_MIRROR*` block after the AdGuard one.

## Tests (`server/tests/config.test.ts`)

Mirror the `adguardSchema` cases:

- Empty env → `timekprMirror` defaults to `{ mode: "disabled" }` (added to the
  existing "applies defaults" assertions).
- Unknown mode (`PCT_TIMEKPR_MIRROR=on`) → `SettingsError` naming `mode`.
- `external` with a URL → parsed; `external` without a URL → `SettingsError`;
  `external` with an invalid URL → `SettingsError`.
- `managed` defaults (dir `/data/apt/timekpr`, package `timekpr-next`, version
  unset); `managed` with explicit dir + pinned version + beta package; an
  invalid package value → `SettingsError`.

## Out of scope (tracked on #389)

- Scheduled upstream fetch/refresh job — **#392**.
- Signed apt index generation + serving `/apt/timekpr/*` + enrol advertisement —
  **#393**.
- Client `install-baseline-tools.sh` mirror repo path + orchestrator/enrol
  plumbing — **#394**.
- `licensing-analysis.md` note + `license-guard` confirmation — **#395**.

## License-boundary note

Config-only; no behaviour, no binary, no fetch. Pure TypeScript + zod. The
`/data`-resident approach is already blessed by ADR 0011 (same precedent as
managed-mode AdGuard Home). No GPL linkage, no image change, no new dependency.
