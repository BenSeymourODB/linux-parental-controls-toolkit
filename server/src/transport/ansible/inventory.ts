/**
 * Dynamic Ansible inventory generation from the dashboard's `Client` records.
 *
 * A run targets the set of enrolled clients; this module turns those records
 * into an Ansible **INI** inventory string. INI (rather than YAML) is a
 * deliberate choice: it is trivial to generate with no templating, easy to
 * eyeball, and — most importantly — lets us avoid adding a YAML serialiser to
 * the dashboard's *runtime* dependency tree just to emit a handful of lines.
 *
 * Inventory lines are assembled from values that originate in the policy store
 * (`clients.hostname`, `clients.ssh_user`). Even though those are not
 * end-user input, we still validate every token against a strict charset
 * before writing it: a hostname carrying a space, a newline, or `=` could
 * otherwise inject extra inventory tokens or host entries. A bad value is
 * rejected with {@link AnsibleInventoryError} rather than silently producing a
 * malformed file.
 *
 * License boundary: pure string assembly; nothing links Ansible in-process.
 */
import { AnsibleInventoryError } from "./errors.js";

/**
 * The slice of a `clients` row the inventory needs. A full Drizzle `clients`
 * select row is assignable to this shape, so callers can pass DB rows
 * directly once the Phase-2 CRUD (#51) loads them.
 */
export interface AnsibleHost {
  /** DNS hostname (or IP) Ansible connects to. */
  hostname: string;
  /** The `pct-agent` service account the dashboard authenticates as. */
  sshUser: string;
}

/** The inventory group every supervised client is placed in. */
export const INVENTORY_GROUP = "supervised";

/**
 * Hostnames/IPs: letters, digits, dot and hyphen (DNS labels) — no
 * whitespace, `=`, `:`, or `[` that would change the meaning of an INI line.
 */
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** POSIX-ish login name: starts with a letter/underscore, then word chars. */
const SSH_USER_PATTERN = /^[a-z_][a-z0-9_-]*$/;

function requireSafe(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new AnsibleInventoryError(
      `refusing to build an Ansible inventory: ${what} ${JSON.stringify(value)} ` +
        `contains characters that are not allowed in an inventory entry`,
    );
  }
  return value;
}

/**
 * Build an Ansible INI inventory string for the given hosts.
 *
 * The result always ends with a trailing newline. An empty host list still
 * produces a valid (empty) group header, so `ansible-playbook` runs cleanly
 * against zero hosts rather than erroring on a missing inventory.
 *
 * @throws {AnsibleInventoryError} if any hostname or SSH user contains a
 *   character that is unsafe in an inventory line.
 */
export function buildInventory(hosts: readonly AnsibleHost[]): string {
  const lines: string[] = [`[${INVENTORY_GROUP}]`];

  for (const host of hosts) {
    const hostname = requireSafe(host.hostname, HOSTNAME_PATTERN, "hostname");
    const sshUser = requireSafe(host.sshUser, SSH_USER_PATTERN, "ssh user");
    lines.push(`${hostname} ansible_user=${sshUser}`);
  }

  return `${lines.join("\n")}\n`;
}
