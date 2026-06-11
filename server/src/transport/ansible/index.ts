/**
 * Ansible transport: runs `ansible-playbook` as a subprocess
 * (node:child_process), from the venv bootstrapped into the data volume.
 *
 * License boundary: never link Ansible code in-process.
 * See docs/licensing-analysis.md.
 */
export const moduleName = "transport/ansible";
