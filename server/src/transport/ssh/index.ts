/**
 * SSH transport: invokes `timekpra` as a subprocess on each client
 * (node:child_process locally, ssh2 exec remotely).
 *
 * License boundary: never link Timekpr-nExT code in-process — CLI
 * invocation and stdout parsing only. See docs/licensing-analysis.md.
 */
export const moduleName = "transport/ssh";
