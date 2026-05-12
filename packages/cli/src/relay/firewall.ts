// ════════════════════════════════════════════════════════════════════
//  Relay Egress Firewall — Vault 2.0 sharing policy
// ════════════════════════════════════════════════════════════════════
//
// Sole authority on whether a vault entry may be advertised to the
// Community Pool or used to relay a remote caller's request.
//
// Two checks (both must pass):
//   1. Vault 2.0 metadata explicitly opts in (`shareable === true`)
//      and the secret type is not `pat` / `oauth`.
//   2. The key NAME doesn't match the egress blocklist regex.
//
// Even if the dashboard ingress somehow stored a PAT as
// `shareable: true`, this module refuses it. That's the defense-in-
// depth backstop for Phase 3.2 quarantine.

import {
  getVaultMetadata,
  listVaultMetadata,
  type VaultEntry,
} from "../crypto/vault.js";

/**
 * Substring blocklist applied to the vault KEY NAME. Even when an
 * entry is marked shareable, anything matching this pattern is
 * rejected at the relay boundary. Word-boundary aware so
 * `BIG_GIT_HUB_TOKEN` is matched but `MIGRATION` is not.
 */
export const EGRESS_BLOCKLIST_RE = /(GITHUB|GOOGLE|PAT|OAUTH)/i;

/** Returns true when the key name matches the egress blocklist substrings. */
export function nameLooksSensitive(name: string): boolean {
  return EGRESS_BLOCKLIST_RE.test(name);
}

/**
 * Authoritative shareability check. Used by the heartbeat publisher,
 * the `op:execute` quarantine, and the dashboard ingress enforcement.
 */
export function isEgressAllowed(
  name: string,
  meta: VaultEntry | null | undefined,
): boolean {
  if (!meta || !meta.shareable) return false;
  if (meta.type === "pat" || meta.type === "oauth") return false;
  if (EGRESS_BLOCKLIST_RE.test(name)) return false;
  return true;
}

/**
 * Names of every vault entry currently safe to advertise to peers.
 * Values are NEVER returned. Empty entries are skipped so we don't
 * advertise a slot we can't actually serve.
 */
export function getShareableKeys(): string[] {
  return listVaultMetadata()
    .filter((e) => e.has_value)
    .filter((e) => isEgressAllowed(e.key, getVaultMetadata(e.key)))
    .map((e) => e.key)
    .sort();
}
