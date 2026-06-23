/**
 * Seed `AdGuardHome.yaml` for managed mode (#96).
 *
 * AdGuard Home serves a first-run *installation wizard* when it boots with no
 * config file. To run it headless under supervision we write a minimal,
 * dashboard-owned seed config the first time — binding AdGuard's own web UI to
 * `127.0.0.1:<adminPort>` (container-local; only the co-located dashboard
 * reaches it) and DNS to `PCT_ADGUARD_BIND_ADDR`. AdGuard rewrites and expands
 * this file on first boot (filters, schema migration, etc.); we therefore write
 * it **only when absent** and never clobber the admin's / AdGuard's own edits on
 * subsequent runs (`docs/server-deployment.md` → "managed … owns the config
 * under `/data/adguard/`").
 *
 * The field set is modelled from upstream AdGuard Home docs (the live schema is
 * verified against the real binary separately — no Docker in the scheduled-run
 * sandbox; see the ADR). It is deliberately minimal: enough to boot headless,
 * leaving everything else to AdGuard's defaults.
 *
 * License boundary: none touched — we write a YAML file AdGuard reads; no
 * AdGuard code is linked (`CLAUDE.md` → "License boundaries").
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Inputs to {@link renderSeedConfig}, derived from the managed-mode settings. */
export interface SeedConfigOptions {
  /** Port AdGuard's web UI binds on (`PCT_ADGUARD_ADMIN_PORT`); bound to localhost. */
  adminPort: number;
  /** `host:port` AdGuard's DNS server listens on (`PCT_ADGUARD_BIND_ADDR`). */
  bindAddr: string;
}

/** A DNS `host` + numeric `port`, split from a `host:port` bind address. */
interface HostPort {
  host: string;
  port: number;
}

/**
 * Split a `host:port` bind address on its final colon (so an IPv6 host keeps its
 * inner colons). Falls back to port 53 when no parseable port is present.
 */
function splitBindAddr(bindAddr: string): HostPort {
  const lastColon = bindAddr.lastIndexOf(":");
  if (lastColon === -1) return { host: bindAddr, port: 53 };
  const host = bindAddr.slice(0, lastColon);
  const port = Number.parseInt(bindAddr.slice(lastColon + 1), 10);
  return { host: host === "" ? "0.0.0.0" : host, port: Number.isNaN(port) ? 53 : port };
}

/** Render the minimal seed `AdGuardHome.yaml` body. */
export function renderSeedConfig(options: SeedConfigOptions): string {
  const dns = splitBindAddr(options.bindAddr);
  return [
    "# Managed by linux-parental-controls-toolkit (PCT_ADGUARD_MODE=managed).",
    "# Minimal seed so AdGuard Home boots headless instead of its install wizard;",
    "# AdGuard rewrites/expands this on first boot and the dashboard never",
    "# clobbers it afterwards (#96).",
    "http:",
    `  address: 127.0.0.1:${options.adminPort}`,
    "users: []",
    "dns:",
    "  bind_hosts:",
    `    - ${dns.host}`,
    `  port: ${dns.port}`,
    "",
  ].join("\n");
}

/** Injectable seams so tests do not touch the real filesystem. */
export interface SeedConfigDeps {
  fileExists?: (path: string) => boolean;
  makeDir?: (path: string) => void;
  writeFile?: (path: string, contents: string) => void;
}

/**
 * Write the seed config at {@link configPath} only when it does not already
 * exist. Returns `true` when a file was written, `false` when one was already
 * present (the no-clobber case).
 */
export function writeSeedConfigIfAbsent(
  configPath: string,
  options: SeedConfigOptions,
  deps: SeedConfigDeps = {},
): boolean {
  const fileExists = deps.fileExists ?? existsSync;
  if (fileExists(configPath)) return false;

  const makeDir = deps.makeDir ?? ((path) => void mkdirSync(path, { recursive: true }));
  const writeFile = deps.writeFile ?? ((path, contents) => writeFileSync(path, contents));
  makeDir(dirname(configPath));
  writeFile(configPath, renderSeedConfig(options));
  return true;
}
