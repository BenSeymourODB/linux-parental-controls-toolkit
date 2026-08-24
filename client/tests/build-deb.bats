#!/usr/bin/env bats
#
# Tests for client/agent/build-deb.sh — the builder that produces the pct-client
# Debian package (#106): pct-client-bridge (system unit) + pct-client-agent
# (systemd --user unit), bundling their own Node runtime under
# /usr/lib/pct-client/node.
#
# The real Node runtime (~30 MB) is NOT downloaded here: setup_file synthesises
# a tiny STUB tarball with the expected `node-vX-linux-x64/bin/node` layout and
# passes it via PCT_NODE_TARBALL + PCT_NODE_SHA256, so the packaging is exercised
# fully offline and fast. The real download + SHA-256 pin is validated at release
# time (#168); a dedicated test below checks the mismatch path.

setup_file() {
	AGENT_DIR="$(cd "${BATS_TEST_DIRNAME}/../agent" && pwd)"
	export AGENT_DIR

	# The build compiles the agent TypeScript, so its devDeps must be present.
	# Self-provision (like build-install-bundle.bats builds within the test) so
	# this runs in the deps-free `client-tests` CI job without extra wiring.
	if [ ! -d "${AGENT_DIR}/node_modules" ]; then
		(cd "$AGENT_DIR" && npm ci --no-audit --no-fund) >/dev/null 2>&1
	fi

	WORKDIR="$(mktemp -d)"
	export WORKDIR

	# Pinned Node version drives the stub tarball's internal directory name.
	NODE_VER="$(. "${AGENT_DIR}/NODE_VERSION" && printf '%s' "$NODE_VERSION")"
	export NODE_VER
	local stubroot="${WORKDIR}/node-v${NODE_VER}-linux-x64"
	mkdir -p "${stubroot}/bin"
	printf '#!/bin/sh\necho stub-node\n' >"${stubroot}/bin/node"
	chmod +x "${stubroot}/bin/node"
	printf 'stub license\n' >"${stubroot}/LICENSE"
	STUB_TARBALL="${WORKDIR}/node-stub.tar.xz"
	export STUB_TARBALL
	tar -C "$WORKDIR" -cJf "$STUB_TARBALL" "node-v${NODE_VER}-linux-x64"
	STUB_SHA="$(sha256sum "$STUB_TARBALL" | cut -d' ' -f1)"
	export STUB_SHA

	DEB="${WORKDIR}/pct-client_9.9.9_amd64.deb"
	export DEB
	(cd "$AGENT_DIR" &&
		PCT_NODE_TARBALL="$STUB_TARBALL" PCT_NODE_SHA256="$STUB_SHA" \
			./build-deb.sh --output "$DEB" --version 9.9.9) >/dev/null

	EXTRACT="${WORKDIR}/extract"
	export EXTRACT
	mkdir -p "$EXTRACT"
	dpkg-deb -x "$DEB" "$EXTRACT"

	CTRL="${WORKDIR}/control"
	export CTRL
	mkdir -p "$CTRL"
	dpkg-deb -e "$DEB" "$CTRL"
}

teardown_file() {
	[ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"
}

# --- Build + control metadata ----------------------------------------------

@test "produces a .deb" {
	[ -f "$DEB" ]
}

@test "control declares package name, version, and architecture" {
	run dpkg-deb --field "$DEB" Package Version Architecture
	[ "$status" -eq 0 ]
	[[ "$output" == *"pct-client"* ]]
	[[ "$output" == *"9.9.9"* ]]
	[[ "$output" == *"amd64"* ]]
}

@test "control depends on systemd and recommends the desktop stack" {
	run dpkg-deb --field "$DEB" Depends
	[[ "$output" == *"systemd"* ]]
	run dpkg-deb --field "$DEB" Recommends
	[[ "$output" == *"libnotify-bin"* ]]
	[[ "$output" == *"libcanberra-gtk3-module"* ]]
}

# --- Payload layout ---------------------------------------------------------

@test "bundles both daemon entry points" {
	[ -f "${EXTRACT}/usr/lib/pct-client/dist/main.js" ]
	[ -f "${EXTRACT}/usr/lib/pct-client/dist/agent/main.js" ]
}

@test "bundles the Node runtime binary and its LICENSE" {
	[ -x "${EXTRACT}/usr/lib/pct-client/node/bin/node" ]
	[ -f "${EXTRACT}/usr/lib/pct-client/node/LICENSE" ]
}

@test "bundles the production dependencies (ws, zod)" {
	[ -d "${EXTRACT}/usr/lib/pct-client/node_modules/ws" ]
	[ -d "${EXTRACT}/usr/lib/pct-client/node_modules/zod" ]
}

@test "bundle package.json marks the tree as ESM" {
	run cat "${EXTRACT}/usr/lib/pct-client/package.json"
	[[ "$output" == *'"type": "module"'* ]]
	[[ "$output" == *'"version": "9.9.9"'* ]]
}

# --- systemd units ----------------------------------------------------------

@test "ships the bridge as a system unit wired to the bundled runtime" {
	local unit="${EXTRACT}/usr/lib/systemd/system/pct-client-bridge.service"
	[ -f "$unit" ]
	run cat "$unit"
	[[ "$output" == *"User=pct-agent"* ]]
	[[ "$output" == *"EnvironmentFile=/etc/default/pct-client-bridge"* ]]
	[[ "$output" == *"ExecStart=/usr/lib/pct-client/node/bin/node /usr/lib/pct-client/dist/main.js"* ]]
	[[ "$output" == *"WantedBy=multi-user.target"* ]]
}

@test "ships the agent as a systemd --user unit with a uid-derived socket" {
	local unit="${EXTRACT}/usr/lib/systemd/user/pct-client-agent.service"
	[ -f "$unit" ]
	run cat "$unit"
	[[ "$output" == *"ExecStart=/usr/lib/pct-client/node/bin/node /usr/lib/pct-client/dist/agent/main.js"* ]]
	[[ "$output" == *"PCT_AGENT_SOCKET=/run/pct/%U.sock"* ]]
	[[ "$output" == *"WantedBy=default.target"* ]]
}

@test "ships a tmpfiles.d entry creating /run/pct for pct-agent" {
	local conf="${EXTRACT}/usr/lib/tmpfiles.d/pct-client.conf"
	[ -f "$conf" ]
	run cat "$conf"
	[[ "$output" == *"/run/pct"* ]]
	[[ "$output" == *"pct-agent pct-agent"* ]]
}

# --- Config / conffiles -----------------------------------------------------

@test "ships the bridge EnvironmentFile as a conffile" {
	[ -f "${EXTRACT}/etc/default/pct-client-bridge" ]
	run cat "${CTRL}/conffiles"
	[[ "$output" == *"/etc/default/pct-client-bridge"* ]]
}

# --- Maintainer scripts -----------------------------------------------------

@test "maintainer scripts are present, executable, and syntactically valid" {
	for script in postinst prerm postrm; do
		[ -x "${CTRL}/${script}" ]
		run sh -n "${CTRL}/${script}"
		[ "$status" -eq 0 ]
	done
}

@test "postinst creates pct-agent with an SSH-capable shell and home" {
	# Must match client/lib/provision-agent-user.sh: pct-agent is the SSH
	# principal the dashboard execs timekpra as, so it needs /bin/bash + a home.
	run cat "${CTRL}/postinst"
	[[ "$output" == *"useradd --system --create-home --shell /bin/bash pct-agent"* ]]
	[[ "$output" != *"nologin"* ]]
}

@test "postinst enables and (on upgrade) restarts the bridge via systemd" {
	run cat "${CTRL}/postinst"
	[[ "$output" == *"systemd-tmpfiles --create"* ]]
	[[ "$output" == *"systemctl daemon-reload"* ]]
	[[ "$output" == *"systemctl enable pct-client-bridge.service"* ]]
	[[ "$output" == *"systemctl try-restart pct-client-bridge.service"* ]]
}

@test "prerm stops and disables the bridge on removal" {
	run cat "${CTRL}/prerm"
	[[ "$output" == *"systemctl disable --now pct-client-bridge.service"* ]]
}

@test "postrm removes the config conffile on purge" {
	run cat "${CTRL}/postrm"
	[[ "$output" == *"purge"* ]]
	[[ "$output" == *"rm -f /etc/default/pct-client-bridge"* ]]
}

# --- Guard rails ------------------------------------------------------------

@test "rejects a Node tarball whose SHA-256 does not match" {
	run env PCT_NODE_TARBALL="$STUB_TARBALL" PCT_NODE_SHA256="deadbeef" \
		bash "${AGENT_DIR}/build-deb.sh" --output "${WORKDIR}/bad.deb" --version 0.0.1
	[ "$status" -ne 0 ]
	[[ "$output" == *"SHA-256 mismatch"* ]]
}

@test "rejects an unsupported architecture" {
	run bash "${AGENT_DIR}/build-deb.sh" --arch ppc64 --output "${WORKDIR}/bad.deb"
	[ "$status" -ne 0 ]
	[[ "$output" == *"unsupported --arch"* ]]
}

@test "--help prints usage and exits 0" {
	run bash "${AGENT_DIR}/build-deb.sh" --help
	[ "$status" -eq 0 ]
	[[ "$output" == *"build-deb.sh"* ]]
	[[ "$output" == *"--output"* ]]
}

@test "builds an arm64 package from the arm64 stub + SHA" {
	# Exercises the arch -> NODE_ARCH mapping and the SHA256_LINUX_ARM64 branch.
	local root="${WORKDIR}/arm64/node-v${NODE_VER}-linux-arm64"
	mkdir -p "${root}/bin"
	printf '#!/bin/sh\necho stub-node\n' >"${root}/bin/node"
	chmod +x "${root}/bin/node"
	printf 'stub license\n' >"${root}/LICENSE"
	local tarball="${WORKDIR}/arm64/node-arm64.tar.xz"
	tar -C "${WORKDIR}/arm64" -cJf "$tarball" "node-v${NODE_VER}-linux-arm64"
	local sha
	sha="$(sha256sum "$tarball" | cut -d' ' -f1)"
	local deb="${WORKDIR}/pct-client_9.9.9_arm64.deb"

	run env PCT_NODE_TARBALL="$tarball" PCT_NODE_SHA256="$sha" \
		bash "${AGENT_DIR}/build-deb.sh" --arch arm64 --version 9.9.9 --output "$deb"
	[ "$status" -eq 0 ]
	run dpkg-deb --field "$deb" Architecture
	[[ "$output" == *"arm64"* ]]
}
