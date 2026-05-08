import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "../config.js";

// ════════════════════════════════════════════════════════════════════
//  ~/.aegis/relay.json — daemon-side directory of relay opt-ins
// ════════════════════════════════════════════════════════════════════
//
// Each entry says: "I, the user, am willing to relay calls for
// `provider_slug` using the value of `vault_key_name` in my vault. I
// charge `fee_per_call` credits per relayed call and won't process
// more than `rate_limit_max` calls per rolling 24-hour window."
//
// Secrets never leave this machine — only the slug + fee + limit are
// uploaded to the Router during /v1/relay/nodes.

export const RELAY_CONFIG_PATH = path.join(CONFIG_DIR, "relay.json");

export interface RelayNodeConfig {
  provider_slug: string;
  vault_key_name: string;
  fee_per_call: number;
  rate_limit_max: number;
}

export interface RelayConfig {
  nodes: RelayNodeConfig[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function emptyConfig(): RelayConfig {
  return { nodes: [] };
}

export function loadRelayConfig(): RelayConfig {
  try {
    if (!fs.existsSync(RELAY_CONFIG_PATH)) return emptyConfig();
    const raw = fs.readFileSync(RELAY_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RelayConfig>;
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const cleaned: RelayNodeConfig[] = [];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const node = n as unknown as Record<string, unknown>;
      const slug = node.provider_slug;
      const vault = node.vault_key_name;
      const fee = node.fee_per_call;
      const rate = node.rate_limit_max;
      if (
        typeof slug !== "string" ||
        !SLUG_RE.test(slug) ||
        typeof vault !== "string" ||
        vault.length === 0 ||
        typeof fee !== "number" ||
        !Number.isInteger(fee) ||
        fee < 0 ||
        typeof rate !== "number" ||
        !Number.isInteger(rate) ||
        rate <= 0
      ) {
        console.warn(
          `[Relay] Skipping malformed entry in relay.json: ${JSON.stringify(node)}`,
        );
        continue;
      }
      cleaned.push({
        provider_slug: slug.toLowerCase(),
        vault_key_name: vault,
        fee_per_call: fee,
        rate_limit_max: rate,
      });
    }
    return { nodes: cleaned };
  } catch (err) {
    console.error("[Relay] Failed to read relay.json:", err);
    return emptyConfig();
  }
}

export function saveRelayConfig(cfg: RelayConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(RELAY_CONFIG_PATH, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}

/** Upsert by `provider_slug`. Returns the new config. */
export function upsertRelayNodeConfig(node: RelayNodeConfig): RelayConfig {
  const cfg = loadRelayConfig();
  const slug = node.provider_slug.toLowerCase();
  const without = cfg.nodes.filter((n) => n.provider_slug !== slug);
  without.push({ ...node, provider_slug: slug });
  const next: RelayConfig = { nodes: without };
  saveRelayConfig(next);
  return next;
}

export function removeRelayNodeConfig(providerSlug: string): RelayConfig {
  const cfg = loadRelayConfig();
  const slug = providerSlug.toLowerCase();
  const next: RelayConfig = {
    nodes: cfg.nodes.filter((n) => n.provider_slug !== slug),
  };
  saveRelayConfig(next);
  return next;
}
