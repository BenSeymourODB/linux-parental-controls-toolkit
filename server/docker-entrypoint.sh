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
# Schema migration is deliberately NOT an entrypoint step: the Node server
# applies the committed migrations in-process on boot via drizzle-orm's
# better-sqlite3 migrator (#49), so the runtime image never ships drizzle-kit
# and the entrypoint and runtime can't double-migrate. See
# docs/server-deployment.md -> "First-run setup" step 1.
#
# The remaining heavier first-run steps each land with their roadmap phase and
# are tracked in the follow-up issue linked from the PR that introduced this
# script:
#   - Ansible venv bootstrap (pip install ansible-core)           [Phase 6]
#   - AdGuard Home fetch / supervise (managed mode)               [Phase 7]
#   - SSH key bootstrap (generate id_ed25519)                     [Phase 4]
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
