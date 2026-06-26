#!/usr/bin/env bash
# Regenerate docs/screenshots/ from the *current* repo state.
#
# Spins up a throwaway, freshly-seeded dashboard on a private Docker network,
# drives headless Chromium (the official Playwright image — no host browser
# install needed) to capture every implemented view, writes the PNGs + a
# generated gallery README + a manifest.json into docs/screenshots/, then tears
# everything down. The user's ./data and any running `docker compose` instance
# are left untouched.
#
# Requirements: Docker only. Usage: scripts/screenshots/run.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/docs/screenshots"
HERE="${REPO_ROOT}/scripts/screenshots"

APP_IMAGE="linux-parental-controls-toolkit:shots"
PW_IMAGE="mcr.microsoft.com/playwright:v1.61.0-noble"
NET="pct-shots-net-$$"
APP_NAME="pct-shots-app-$$"
# Presentable network alias: the enrol one-liner is built from the page origin
# (window.location.origin), so Playwright reaches the app via this name and the
# install command in the screenshot reads as a clear example rather than the
# ephemeral container name.
APP_ALIAS="dashboard.example.com"
APP_PORT="8000"
ADMIN_USER="admin"
ADMIN_PASS="screenshot-demo-pw"
SECRET_KEY="local-dev-screenshot-secret-key-do-not-use-in-prod-0123456789"

DATA_DIR="$(mktemp -d)"
cleanup() {
  echo "[run] cleaning up"
  docker rm -f "${APP_NAME}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  # The dashboard bootstraps a root-owned Ansible venv into the data volume, so
  # remove it from inside a container (as root) before dropping the temp dir.
  # --entrypoint sh is required: the image's entrypoint launches the server.
  docker run --rm --entrypoint sh -v "${DATA_DIR}:/d" "${APP_IMAGE}" \
    -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null || true' >/dev/null 2>&1 || true
  rm -rf "${DATA_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

echo "[run] building dashboard image from ./server"
docker build -t "${APP_IMAGE}" "${REPO_ROOT}/server"

echo "[run] ensuring Playwright image is present (${PW_IMAGE})"
docker image inspect "${PW_IMAGE}" >/dev/null 2>&1 || docker pull "${PW_IMAGE}"

echo "[run] starting isolated dashboard (${APP_NAME})"
docker network create "${NET}" >/dev/null
docker run -d --name "${APP_NAME}" --network "${NET}" --network-alias "${APP_ALIAS}" \
  -e "PCT_SECRET_KEY=${SECRET_KEY}" \
  -e "PCT_ADMIN_USERNAME=${ADMIN_USER}" \
  -e "PCT_ADMIN_PASSWORD=${ADMIN_PASS}" \
  -e "PCT_DEFAULT_TZ=America/New_York" \
  -v "${DATA_DIR}:/data" \
  "${APP_IMAGE}" >/dev/null

echo "[run] waiting for dashboard health"
ready=""
for _ in $(seq 1 60); do
  if docker exec "${APP_NAME}" node -e \
    "fetch('http://localhost:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "${ready}" ]; then
  echo "[run] dashboard did not become healthy; logs:" >&2
  docker logs "${APP_NAME}" >&2 || true
  exit 1
fi

mkdir -p "${OUT_DIR}"
echo "[run] capturing screenshots into ${OUT_DIR}"
# The official Playwright image ships the browsers but not the playwright npm
# package, so install playwright-core (matched to the image tag) at runtime.
# ESM ignores NODE_PATH, so run the script from where node_modules lives.
docker run --rm --network "${NET}" --ipc=host \
  -v "${HERE}:/scripts:ro" \
  -v "${OUT_DIR}:/work" \
  -e "APP_URL=http://${APP_ALIAS}:${APP_PORT}" \
  -e "ADMIN_USER=${ADMIN_USER}" \
  -e "ADMIN_PASS=${ADMIN_PASS}" \
  -e "OUT=/work" \
  -e "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright" \
  "${PW_IMAGE}" sh -c '
    set -e
    cp /scripts/capture.mjs /tmp/capture.mjs
    cd /tmp
    npm init -y >/dev/null 2>&1
    npm install playwright-core@1.61.0 --no-audit --no-fund --silent
    node capture.mjs
  '

echo "[run] done — see ${OUT_DIR}/ (PNGs, README.md, manifest.json)"
