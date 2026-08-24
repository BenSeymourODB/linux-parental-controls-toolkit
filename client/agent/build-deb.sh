#!/usr/bin/env bash
#
# build-deb.sh — build the pct-client Debian package (#106).
#
# What it produces
# ----------------
# A single `.deb` that installs the two supervised-client daemons and a Node.js
# runtime bundled just for them:
#
#   /usr/lib/pct-client/node/bin/node       bundled, pinned Node runtime
#   /usr/lib/pct-client/dist/main.js        pct-client-bridge entry point
#   /usr/lib/pct-client/dist/agent/main.js  pct-client-agent entry point
#   /usr/lib/pct-client/node_modules/       production deps (ws, zod)
#   /usr/lib/systemd/system/pct-client-bridge.service   system unit
#   /usr/lib/systemd/user/pct-client-agent.service      systemd --user unit
#   /usr/lib/tmpfiles.d/pct-client.conf                 /run/pct socket dir
#   /etc/default/pct-client-bridge                      bridge EnvironmentFile
#
# The bundled runtime is why this exists: the distro's Node packages lag behind
# what the agent needs, so the package ships its own (CLAUDE.md -> "Client
# agent"; docs/client-install.md step 5a; docs/client-notifications.md).
#
# License boundary (docs/licensing-analysis.md): this packages only this repo's
# own permissively-licensed TypeScript plus its MIT deps (ws, zod) and the
# official Node runtime (MIT/BSD/ASL-2.0). No GPL code is linked or vendored,
# and this touches the CLIENT package only — never the dashboard image, whose
# GPL-free invariant (license-guard.yml) is unaffected. GPL client tools
# (Timekpr-nExT, e2guardian) are installed separately from apt by the installer.
#
# Usage:
#   client/agent/build-deb.sh [--output PATH] [--version VER] [--arch ARCH]
#
#   --output PATH   Where to write the .deb
#                   (default: <script dir>/dist/pct-client_<version>_<arch>.deb).
#   --version VER   Package version (default: $PCT_DEB_VERSION, else the git
#                   tag via `git describe`, else 0.0.0).
#   --arch ARCH     Debian architecture: amd64 (default) or arm64.
#
# Environment (mainly for tests / offline builds):
#   PCT_NODE_TARBALL  Path to a pre-fetched node-vX-linux-ARCH.tar.xz; skips the
#                     download. Still SHA-256 verified (see PCT_NODE_SHA256).
#   PCT_NODE_SHA256   Override the expected tarball SHA-256 (defaults to the pin
#                     in ./NODE_VERSION). Lets a test inject a stub tarball.
#   PCT_DEB_VERSION   Default for --version.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DOWNLOAD_BASE="${PCT_NODE_DOWNLOAD_BASE:-https://nodejs.org/dist}"

die() {
	echo "build-deb.sh: $*" >&2
	exit 1
}

usage() {
	sed -n '/^# Usage:/,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- Parse arguments --------------------------------------------------------
OUTPUT=""
VERSION="${PCT_DEB_VERSION:-}"
ARCH="amd64"

while [ $# -gt 0 ]; do
	case "$1" in
	--output)
		OUTPUT="${2:?--output needs a path}"
		shift 2
		;;
	--version)
		VERSION="${2:?--version needs a value}"
		shift 2
		;;
	--arch)
		ARCH="${2:?--arch needs a value}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "unknown argument: $1 (try --help)"
		;;
	esac
done

# --- Resolve architecture ---------------------------------------------------
case "$ARCH" in
amd64) NODE_ARCH="x64" ;;
arm64) NODE_ARCH="arm64" ;;
*) die "unsupported --arch: $ARCH (want amd64 or arm64)" ;;
esac

# --- Load the pinned Node runtime descriptor --------------------------------
[ -f "${SCRIPT_DIR}/NODE_VERSION" ] || die "missing ${SCRIPT_DIR}/NODE_VERSION"
# shellcheck source=/dev/null
. "${SCRIPT_DIR}/NODE_VERSION"
[ -n "${NODE_VERSION:-}" ] || die "NODE_VERSION not set in NODE_VERSION file"

if [ "$NODE_ARCH" = "x64" ]; then
	EXPECTED_SHA="${PCT_NODE_SHA256:-${SHA256_LINUX_X64:-}}"
else
	EXPECTED_SHA="${PCT_NODE_SHA256:-${SHA256_LINUX_ARM64:-}}"
fi
[ -n "$EXPECTED_SHA" ] || die "no expected SHA-256 for arch $ARCH"

# --- Resolve version --------------------------------------------------------
if [ -z "$VERSION" ]; then
	VERSION="$(git -C "$SCRIPT_DIR" describe --tags --always 2>/dev/null || true)"
	VERSION="${VERSION#v}"
fi
# A Debian upstream version must start with a digit. `git describe --always`
# with no tags yields a bare commit hash (often letter-led), so fall back to a
# sortable dev version rather than emit a policy-nonconforming one. Releases
# pass --version explicitly (#168).
case "$VERSION" in
[0-9]*) : ;;
*) VERSION="0.0.0+${VERSION:-unknown}" ;;
esac

: "${OUTPUT:=${SCRIPT_DIR}/dist/pct-client_${VERSION}_${ARCH}.deb}"

echo "build-deb.sh: building pct-client ${VERSION} (${ARCH}) with Node ${NODE_VERSION}"

# --- Staging area -----------------------------------------------------------
STAGE="$(mktemp -d)"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$STAGE" "$WORK"; }
trap cleanup EXIT

PKG_ROOT="${STAGE}/usr/lib/pct-client"
mkdir -p "$PKG_ROOT" \
	"${STAGE}/usr/lib/systemd/system" \
	"${STAGE}/usr/lib/systemd/user" \
	"${STAGE}/usr/lib/tmpfiles.d" \
	"${STAGE}/etc/default" \
	"${STAGE}/DEBIAN"

# --- Compile the TypeScript -------------------------------------------------
echo "build-deb.sh: compiling TypeScript -> dist/"
(cd "$SCRIPT_DIR" && npm run --silent build)
cp -r "${SCRIPT_DIR}/dist" "${PKG_ROOT}/dist"

# --- Stage production node_modules ------------------------------------------
# ws and zod are dependency-free, so copying the named production deps from the
# already-installed tree is correct and fully offline. If a future prod dep
# pulls transitive deps, switch this to `npm ci --omit=dev` into a staging dir.
echo "build-deb.sh: staging production node_modules"
mkdir -p "${PKG_ROOT}/node_modules"
PROD_DEPS="$(node -e 'const p=require(process.argv[1]);process.stdout.write(Object.keys(p.dependencies||{}).join("\n"))' "${SCRIPT_DIR}/package.json")"
while IFS= read -r dep; do
	[ -n "$dep" ] || continue
	src="${SCRIPT_DIR}/node_modules/${dep}"
	[ -d "$src" ] || die "production dependency '${dep}' not installed (run npm ci first)"
	cp -r "$src" "${PKG_ROOT}/node_modules/${dep}"
done <<EOF
$PROD_DEPS
EOF

# A minimal package.json so Node treats the bundle as ESM and resolves the
# bundled node_modules; the source uses "type": "module" + .js import specifiers.
cat >"${PKG_ROOT}/package.json" <<EOF
{
  "name": "pct-client",
  "version": "${VERSION}",
  "private": true,
  "type": "module"
}
EOF
printf '%s\n' "$VERSION" >"${PKG_ROOT}/VERSION"

# --- Bundle the Node runtime ------------------------------------------------
TARBALL_NAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
if [ -n "${PCT_NODE_TARBALL:-}" ]; then
	TARBALL="$PCT_NODE_TARBALL"
	[ -f "$TARBALL" ] || die "PCT_NODE_TARBALL not found: $TARBALL"
	echo "build-deb.sh: using provided Node tarball: $TARBALL"
else
	TARBALL="${WORK}/${TARBALL_NAME}"
	echo "build-deb.sh: downloading ${TARBALL_NAME}"
	curl -fsSL --retry 3 -o "$TARBALL" "${NODE_DOWNLOAD_BASE}/v${NODE_VERSION}/${TARBALL_NAME}" ||
		die "failed to download ${TARBALL_NAME}"
fi

echo "build-deb.sh: verifying Node tarball SHA-256"
ACTUAL_SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] ||
	die "Node tarball SHA-256 mismatch: got ${ACTUAL_SHA}, expected ${EXPECTED_SHA}"

echo "build-deb.sh: extracting Node runtime"
tar -xJf "$TARBALL" -C "$WORK"
NODE_SRC="${WORK}/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
[ -x "${NODE_SRC}/bin/node" ] || die "extracted tarball has no bin/node at ${NODE_SRC}"
mkdir -p "${PKG_ROOT}/node/bin"
cp "${NODE_SRC}/bin/node" "${PKG_ROOT}/node/bin/node"
[ -f "${NODE_SRC}/LICENSE" ] && cp "${NODE_SRC}/LICENSE" "${PKG_ROOT}/node/LICENSE"

# --- Static package files ---------------------------------------------------
PKG="${SCRIPT_DIR}/packaging"
cp "${PKG}/systemd/pct-client-bridge.service" "${STAGE}/usr/lib/systemd/system/"
cp "${PKG}/systemd/pct-client-agent.service" "${STAGE}/usr/lib/systemd/user/"
cp "${PKG}/tmpfiles.d/pct-client.conf" "${STAGE}/usr/lib/tmpfiles.d/"
cp "${PKG}/default/pct-client-bridge" "${STAGE}/etc/default/pct-client-bridge"

# --- DEBIAN control + maintainer scripts ------------------------------------
sed -e "s/@VERSION@/${VERSION}/" -e "s/@ARCH@/${ARCH}/" \
	"${PKG}/debian/control.in" >"${STAGE}/DEBIAN/control"
cp "${PKG}/debian/conffiles" "${STAGE}/DEBIAN/conffiles"
for script in postinst prerm postrm; do
	cp "${PKG}/debian/${script}" "${STAGE}/DEBIAN/${script}"
	chmod 0755 "${STAGE}/DEBIAN/${script}"
done

# Deterministic file modes: dirs 0755, files 0644, then re-arm executables.
find "$STAGE" -path "${STAGE}/DEBIAN" -prune -o -type d -exec chmod 0755 {} +
find "$STAGE" -path "${STAGE}/DEBIAN" -prune -o -type f -exec chmod 0644 {} +
chmod 0755 "${PKG_ROOT}/node/bin/node"

# --- Build the .deb ---------------------------------------------------------
mkdir -p "$(dirname "$OUTPUT")"
dpkg-deb --build --root-owner-group "$STAGE" "$OUTPUT" >/dev/null
echo "build-deb.sh: wrote $OUTPUT"
