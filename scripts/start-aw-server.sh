#!/usr/bin/env bash
#
# start-aw-server.sh — start a headless ActivityWatch aw-server for integration
# tests.
#
# ActivityWatch publishes no official Docker image (see issue #20), so instead
# of pulling a non-existent / community image we download the pinned upstream
# release bundle, verify its SHA-256, extract the headless aw-server-rust
# binary, launch it, and wait until its REST API answers. We only ever talk to
# aw-server over its REST API — no source-level or in-process integration — so
# no license boundary is crossed (it is a test-time external service, never
# bundled in the dashboard image).
#
# Everything is pinned and overridable via the environment:
#   AW_VERSION   upstream release tag                (default v0.13.2)
#   AW_SHA256    expected SHA-256 of the linux zip   (default matches v0.13.2)
#   AW_HOST      address aw-server binds to          (default 127.0.0.1)
#   AW_PORT      port aw-server listens on           (default 5600)
#   AW_CACHE     download/extract cache directory    (default $RUNNER_TEMP or /tmp/aw-cache)
#
# On success the script prints the base URL of the running server and leaves it
# running in the background. Intended to be sourced/called once per CI job step.

set -euo pipefail

AW_VERSION="${AW_VERSION:-v0.13.2}"
AW_SHA256="${AW_SHA256:-8f62b10babf8a8f108cbdf7267c02fbc1ce2a970fa9535f230b3416b803e3360}"
AW_HOST="${AW_HOST:-127.0.0.1}"
AW_PORT="${AW_PORT:-5600}"
AW_CACHE="${AW_CACHE:-${RUNNER_TEMP:-/tmp/aw-cache}}"

archive_name="activitywatch-${AW_VERSION}-linux-x86_64.zip"
download_url="https://github.com/ActivityWatch/activitywatch/releases/download/${AW_VERSION}/${archive_name}"
zip_path="${AW_CACHE}/${archive_name}"
extract_dir="${AW_CACHE}/${AW_VERSION}"
binary_path="${extract_dir}/activitywatch/aw-server-rust/aw-server-rust"
db_dir="${AW_CACHE}/db-${AW_VERSION}"

log() { printf '[start-aw-server] %s\n' "$*" >&2; }

mkdir -p "${AW_CACHE}"

# Download (cached): skip if a previously downloaded archive already matches the
# expected checksum, so re-runs on a warm cache don't re-fetch ~200 MB.
if [ -f "${zip_path}" ] && echo "${AW_SHA256}  ${zip_path}" | sha256sum --check --status; then
  log "Using cached archive ${zip_path}"
else
  log "Downloading ${download_url}"
  curl --fail --location --silent --show-error --output "${zip_path}" "${download_url}"
fi

# Verify checksum (always, even on a cache hit guard failure above).
log "Verifying SHA-256"
echo "${AW_SHA256}  ${zip_path}" | sha256sum --check --status

# Extract just the headless server binary.
log "Extracting aw-server-rust"
rm -rf "${extract_dir}"
mkdir -p "${extract_dir}"
unzip -q -o "${zip_path}" "activitywatch/aw-server-rust/aw-server-rust" -d "${extract_dir}"
chmod +x "${binary_path}"

# Launch headless. --no-legacy-import keeps it from probing for an
# aw-server-python database that does not exist on a CI runner.
rm -rf "${db_dir}"
mkdir -p "${db_dir}"
log "Starting aw-server-rust on ${AW_HOST}:${AW_PORT}"
"${binary_path}" \
  --host "${AW_HOST}" \
  --port "${AW_PORT}" \
  --dbpath "${db_dir}/db.sqlite" \
  --no-legacy-import \
  >"${AW_CACHE}/aw-server.log" 2>&1 &

# Health-poll the REST API.
base_url="http://${AW_HOST}:${AW_PORT}"
for _ in $(seq 1 30); do
  if curl --fail --silent "${base_url}/api/0/info" >/dev/null; then
    log "aw-server is up at ${base_url}"
    echo "${base_url}"
    exit 0
  fi
  sleep 1
done

log "aw-server did not become ready in time; last log lines:"
tail -n 20 "${AW_CACHE}/aw-server.log" >&2 || true
exit 1
