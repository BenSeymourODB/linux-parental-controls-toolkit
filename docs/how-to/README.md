# How-to guides

Task-oriented guides for running the dashboard — the "how do I actually
_do_ X" companion to the design-doc set in [`docs/`](../). Each guide is a
numbered path through a single task and links to the design doc that
explains the underlying model.

| Guide | Do this when you want to… |
|---|---|
| [Enrol a client](enrol-a-client.md) | Turn a fresh Linux Mint machine into a managed client. |
| [Define a policy](define-a-policy.md) | Set up users, activities, budgets, and schedules (including group policy). |
| [Set up DNS filtering](set-up-dns-filtering.md) | Add network-level filtering with AdGuard Home (disabled / managed / external). |
| [Issue an integration API token](issue-an-integration-token.md) | Give an external system a scoped, revocable token for `/api/integrations/*`. |
| [Recover from a backup](recover-from-backup.md) | Restore the `/data` volume, or roll back a failed upgrade. |

These guides cover the features that have shipped. More are added as
features land (see the umbrella tracker
[#122](https://github.com/BenSeymourODB/linux-parental-controls-toolkit/issues/122)) —
planned next: granting reward time, reading the burndown views, and
editing per-client DNS blocklists.

## See also

- [`architecture.md`](../architecture.md) — components, data flow, and the
  policy model.
- [`server-deployment.md`](../server-deployment.md) — Docker image, the
  `/data` volume, AdGuard modes, backup/restore, retention, auth.
- [`client-install.md`](../client-install.md) — the client install script's
  design in full.
- [`roadmap.md`](../roadmap.md) — the phased delivery plan.
