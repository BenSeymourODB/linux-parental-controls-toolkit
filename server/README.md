# `dashboard` — parental-controls server

This subdirectory holds the dashboard server: a Python 3.11+ FastAPI app
that orchestrates Timekpr-nExT, ActivityWatch, e2guardian, and (optionally)
AdGuard Home over SSH, Ansible, and REST.

See the repository root [`README.md`](../README.md) for the project overview
and [`../CLAUDE.md`](../CLAUDE.md) for the architecture and license-boundary
rules contributors must follow when working in here.

## Layout

- `src/dashboard/` — the package; submodules match the split documented in
  `CLAUDE.md` ("Code conventions"): `web`, `api`, `policy`, `events`,
  `integrations`, and `transport/{ssh,ansible,activitywatch,adguard}`.
- `tests/` — pytest tree mirroring the package layout.
- `pyproject.toml` — hatchling build; runtime + dev dependencies.
- `.dockerignore` — runtime image is Python-only; tests, caches, and
  secrets are excluded from the build context.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```
