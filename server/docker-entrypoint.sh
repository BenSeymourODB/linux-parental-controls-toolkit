#!/bin/sh
# Dashboard container entrypoint — first-run setup, then launch the server.
#
# Runs on every container start and is idempotent (safe to re-run): the
# entire deployable state lives under /data (docs/server-deployment.md →
# "Backup and restore"), so setup only ever reconciles that volume.
#
# In scope today: ensure the documented /data volume layout exists, then
# exec the compiled Node server.
#
# Several first-run steps are deliberately NOT entrypoint steps: the Node server
# does them in-process on boot, so the runtime image ships no extra tooling:
#   - Schema migration via drizzle-orm's better-sqlite3 migrator (#49), so the
#     image never ships drizzle-kit and migrator/runtime can't double-migrate.
#   - SSH key bootstrap (generate id_ed25519 if absent) via node:crypto (#39),
#     so the image never ships an ssh-keygen binary.
#   - Ansible venv bootstrap (#39): the server spawns `python3 -m venv` +
#     `pip install ansible-core` as subprocesses in the background after listen,
#     so the image ships no Ansible binary (only a stock python3-venv) and a slow
#     pip install never blocks startup. Status is surfaced at GET /api/system/ansible.
# See docs/server-deployment.md -> "First-run setup" steps 1, 2, and 4.
#
# The remaining heavier first-run step lands with its roadmap phase, tracked in #39:
#   - AdGuard Home fetch / supervise (managed mode)               [Phase 7]
set -eu

DATA_DIR="${PCT_DATA_DIR:-/data}"

# Reconcile the documented volume layout (docs/server-deployment.md ->
# "Volume layout"). Cheap and idempotent; the subdirectories are where the
# deferred first-run steps above will write.
mkdir -p \
  "${DATA_DIR}/secrets/ssh" \
  "${DATA_DIR}/ansible/playbooks" \
  "${DATA_DIR}/adguard" \
  "${DATA_DIR}/logs"

echo "pct-dashboard: data volume ready at ${DATA_DIR}; starting server"

# exec so the Node process becomes PID 1 and receives signals directly.
exec node dist/main.js
