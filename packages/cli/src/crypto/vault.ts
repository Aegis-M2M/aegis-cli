import fs from "fs";
import { CONFIG_DIR, VAULT_PATH } from "../config.js";

// ════════════════════════════════════════════════════════════════════
//  Vault 2.0 — metadata-tagged secret store
// ════════════════════════════════════════════════════════════════════
//
// On disk every entry is `{ value, type, shareable }`. The schema
// migration runs once at process boot and rewrites flat-string vaults
// in place, defaulting every legacy entry to `shareable: false` unless
// it appears in the small allowlist of well-known utility keys below.
//
// Public read APIs (`getSecret`, `resolveVaultSecret`) keep returning
// raw strings so the rest of the codebase (relay listener, omni-tool
// dispatcher, preflight) stays unchanged. The metadata is exposed via
// new helpers (`getVaultMetadata`, `listVaultMetadata`,
// `setVaultEntry`) used by the Egress firewall and ingress
// enforcement.

export type SecretType = "api_key" | "pat" | "oauth";

/**
 * Optional refresh material for OAuth entries. Without this block,
 * an OAuth access token will silently expire (typically after 1h)
 * and the agent would suddenly forget how to use the provider mid-
 * task. The CLI background refresher (`oauth-refresher.ts`) uses
 * this metadata to keep `value` alive.
 *
 * Public PKCE clients have no `client_secret`. Confidential clients
 * (server-side OAuth apps) may set it — but be aware those secrets
 * also live on disk under 0600 in the same vault file.
 */
export interface OAuthRefreshBlock {
  refresh_token: string;
  token_url: string;
  client_id: string;
  client_secret?: string;
  /** Wall-clock ms when `value` (the access token) becomes unusable. */
  expires_at_ms?: number;
  /** Last successful refresh wall-clock ms (for diagnostics). */
  last_refreshed_ms?: number;
  /** Set when the most recent refresh attempt failed (e.g. invalid_grant). */
  last_error?: string;
}

export interface VaultEntry {
  value: string;
  type: SecretType;
  shareable: boolean;
  /** Only meaningful when `type === "oauth"`. */
  refresh?: OAuthRefreshBlock;
}

/**
 * Utility-tier keys that are safe to default to `shareable: true`
 * during migration. Everything else migrates as `shareable: false`
 * — explicit opt-in only.
 */
const DEFAULT_SHAREABLE_KEYS = new Set<string>([
  "TAVILY_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "POLYGON_API_KEY",
  "MASSIVE_API_KEY",
  "NEWSAPI_API_KEY",
]);

/** Heuristic type inference for keys whose schema is implied by the name. */
function inferSecretType(name: string): SecretType {
  const upper = name.toUpperCase();
  if (upper.includes("OAUTH")) return "oauth";
  if (upper.endsWith("_TOKEN") || upper.endsWith("_PAT")) return "pat";
  return "api_key";
}

/** Create `~/.aegis/vault.json` with `{}` if missing so users have a stable place to add keys. */
function ensureVaultFileExists(): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(VAULT_PATH)) {
      fs.writeFileSync(VAULT_PATH, "{}\n", { mode: 0o600 });
    }
  } catch (err) {
    console.error("[Vault] Failed to ensure vault.json:", err);
  }
}

ensureVaultFileExists();
migrateVaultIfNeeded();

function isOAuthRefreshShape(v: unknown): v is OAuthRefreshBlock {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.refresh_token !== "string" || o.refresh_token.length === 0)
    return false;
  if (typeof o.token_url !== "string" || o.token_url.length === 0) return false;
  if (typeof o.client_id !== "string" || o.client_id.length === 0) return false;
  if (
    o.client_secret !== undefined &&
    typeof o.client_secret !== "string"
  )
    return false;
  if (
    o.expires_at_ms !== undefined &&
    (typeof o.expires_at_ms !== "number" || !Number.isFinite(o.expires_at_ms))
  )
    return false;
  if (
    o.last_refreshed_ms !== undefined &&
    (typeof o.last_refreshed_ms !== "number" ||
      !Number.isFinite(o.last_refreshed_ms))
  )
    return false;
  if (o.last_error !== undefined && typeof o.last_error !== "string")
    return false;
  return true;
}

/**
 * Returns true when `v` already has the Vault 2.0 metadata shape
 * (`{ value, type, shareable }`, with an optional `refresh` block
 * for OAuth entries).
 */
function isVaultEntryShape(v: unknown): v is VaultEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.value !== "string") return false;
  if (o.type !== "api_key" && o.type !== "pat" && o.type !== "oauth")
    return false;
  if (typeof o.shareable !== "boolean") return false;
  if (o.refresh !== undefined && !isOAuthRefreshShape(o.refresh)) return false;
  return true;
}

/**
 * One-shot migration from the legacy flat-string vault to the
 * metadata-tagged Vault 2.0 schema. Idempotent: when every entry is
 * already in the new shape, the file is left untouched.
 */
export function migrateVaultIfNeeded(): void {
  try {
    if (!fs.existsSync(VAULT_PATH)) return;
    const raw = fs.readFileSync(VAULT_PATH, "utf-8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    let dirty = false;
    const next: Record<string, VaultEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isVaultEntryShape(v)) {
        next[k] = v;
        continue;
      }
      if (typeof v === "string") {
        const type = inferSecretType(k);
        const shareable =
          type === "api_key" && DEFAULT_SHAREABLE_KEYS.has(k.toUpperCase());
        next[k] = { value: v, type, shareable };
        dirty = true;
        continue;
      }
      // Drop unrecognised shapes silently — they were never readable
      // by `getSecret` anyway.
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(VAULT_PATH, JSON.stringify(next, null, 2) + "\n", {
        mode: 0o600,
      });
      console.error(
        `[Vault] Migrated ${Object.keys(next).length} entr${
          Object.keys(next).length === 1 ? "y" : "ies"
        } to Vault 2.0 schema.`,
      );
    }
  } catch (err) {
    console.error("[Vault] migrateVaultIfNeeded failed:", err);
  }
}

/** Read the on-disk vault, tolerating missing/corrupt files. */
function readVault(): Record<string, VaultEntry> {
  try {
    if (!fs.existsSync(VAULT_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(VAULT_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    const out: Record<string, VaultEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isVaultEntryShape(v)) {
        out[k] = v;
      } else if (typeof v === "string") {
        // Defensive: a legacy entry that survived migration (e.g. file
        // edited externally between boot and read) is treated as
        // non-shareable.
        out[k] = { value: v, type: inferSecretType(k), shareable: false };
      }
    }
    return out;
  } catch (e) {
    console.error("[Vault] readVault:", e);
    return {};
  }
}

function writeVault(vault: Record<string, VaultEntry>): void {
  fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Absolute path to the JSON vault file consumed by {@link getSecret} / {@link setSecret}. */
export function getVaultJsonPath(): string {
  return VAULT_PATH;
}

/**
 * User-facing instructions: where to edit, JSON shape, and that key names MUST match catalog `optional_secrets` / registration.
 */
export function formatUserInstructionsForSecrets(secretKeyNames: string[]): string {
  const path = VAULT_PATH;
  const location =
    typeof process.env.AEGIS_HOME === "string" && process.env.AEGIS_HOME.length > 0
      ? `\`${path}\` (AEGIS_HOME is set)`
      : `\`${path}\` (default: \`~/.aegis/vault.json\` when AEGIS_HOME is unset)`;

  const namesLine =
    secretKeyNames.length > 0
      ? `Use these **exact** property names (they match the service registry / \`optional_secrets\`): ${secretKeyNames.map((k) => `\`${k}\``).join(", ")}.`
      : "The required property name(s) are listed in that service’s registration (`optional_secrets` in the catalog).";

  const exampleObj: Record<string, VaultEntry> = {};
  for (const k of secretKeyNames.length > 0 ? secretKeyNames : ["EXAMPLE_KEY_NAME"]) {
    exampleObj[k] = {
      value: "<paste value here>",
      type: inferSecretType(k),
      shareable: false,
    };
  }
  const example = JSON.stringify(exampleObj, null, 2);

  return [
    "### How the user adds the key",
    "",
    "1. **Name of each key** — " + namesLine,
    `2. **Where** — Edit the local vault file on disk: ${location}`,
    "3. **Format** — JSON object, one entry per key. Each value is `{ value, type, shareable }` (Vault 2.0 schema). Merge new keys into the existing object.",
    "",
    "Example file contents:",
    "",
    "```json",
    example,
    "```",
    "",
    "4. Save the file, then **retry** the tool. If the Aegis MCP / hub daemon was started before `vault.json` existed, restarting it ensures the vault is picked up.",
  ].join("\n");
}

export function getSecret(key: string): string | null {
  const entry = readVault()[key];
  if (!entry) return null;
  return entry.value.length > 0 ? entry.value : null;
}

/** Full metadata for a single key (or null when missing). */
export function getVaultMetadata(key: string): VaultEntry | null {
  return readVault()[key] ?? null;
}

/** Top-level property names from `vault.json` (whether or not values are populated). */
export function getAllVaultKeys(): string[] {
  return Object.keys(readVault());
}

/**
 * Calculates the Levenshtein distance between two strings.
 * Returns the number of edits required to transform 'a' into 'b'.
 */
function getLevenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Strip repeated credential-style suffixes (with optional leading underscore) until stable.
 * Used to compare vault key names and catalog secret names on a common base.
 */
export function canonicalize(name: string): string {
  let current = name.toUpperCase();
  let previous: string;

  const noisePattern = /_?(API_KEY|API|KEY|SECRET|TOKEN)$/i;

  do {
    previous = current;
    current = current.replace(noisePattern, "");
  } while (current !== previous && current.length > 0);

  return current || previous;
}

/**
 * Resolve a manifest secret name (e.g. `POLYGON_API_KEY`) to a value
 * stored in the local vault only (no process.env).
 * Strategy: exact match → short form → standard suffixes → Levenshtein fuzzy match over vault keys.
 */
export function resolveVaultSecret(secretName: string): string | null {
  const direct = getSecret(secretName);
  if (direct) return direct;

  const targetShort = canonicalize(secretName);

  const shortMatch = getSecret(targetShort);
  if (shortMatch) return shortMatch;

  const suffixes = ["_API_KEY", "_KEY", "_SECRET", "_TOKEN"];
  for (const sfx of suffixes) {
    const match = getSecret(targetShort + sfx);
    if (match) return match;
  }

  const vaultKeys = getAllVaultKeys();
  const candidateKeys = vaultKeys.filter((k) => /KEY|SECRET|TOKEN|API/i.test(k));

  let bestMatch: string | null = null;
  let highestSimilarity = 0;
  const SIMILARITY_THRESHOLD = 0.8;

  for (const candidate of candidateKeys) {
    const candidateShort = canonicalize(candidate);
    const distance = getLevenshteinDistance(targetShort, candidateShort);
    const maxLen = Math.max(targetShort.length, candidateShort.length);
    const similarity = maxLen === 0 ? 1 : 1 - distance / maxLen;

    if (similarity > highestSimilarity && similarity >= SIMILARITY_THRESHOLD) {
      highestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (bestMatch) {
    console.error(
      `[Vault] 🪄 Fuzzy matched requested secret '${secretName}' to vault key '${bestMatch}' (Similarity: ${(highestSimilarity * 100).toFixed(1)}%)`,
    );
    return getSecret(bestMatch);
  }

  return null;
}

/** Vault key names that imply a provider-scoped credential (omni `key_hints`). */
const VAULT_KEY_HINT_SUFFIX = /_(API_KEY|TOKEN|SECRET|KEY)$/i;

/**
 * For each vault key that looks like a provider credential (suffix
 * `_API_KEY`, `_TOKEN`, `_SECRET`, or `_KEY`) with a non-empty value, returns
 * the onion-peel brand (e.g. `POLYGON_API_KEY` → `POLYGON`).
 *
 * Only entries with {@link SecretType} `"api_key"` are included. PATs,
 * OAuth access tokens, and other user-scoped secrets must not leak into omni
 * `key_hints` — they skew bridge search and doc URL selection toward the
 * wrong provider (e.g. GitHub for a LinkedIn intent). Local delegation still
 * resolves those secrets by name when a manifest actually requires them.
 */
export function listApiKeyProviderHintsFromVault(): string[] {
  const vault = readVault();
  const hints = new Set<string>();
  for (const [name, entry] of Object.entries(vault)) {
    if (entry.type !== "api_key") continue;
    if (!VAULT_KEY_HINT_SUFFIX.test(name)) continue;
    if (typeof entry.value !== "string" || entry.value.trim().length === 0)
      continue;
    const hint = canonicalize(name);
    if (hint.length > 0) hints.add(hint);
  }
  return [...hints].sort();
}

/**
 * Persist a secret value while preserving (or inferring) its metadata.
 * Used by code paths that don't care about `type` / `shareable`. Prefer
 * {@link setVaultEntry} when you have an explicit policy decision.
 */
export function setSecret(key: string, value: string): void {
  const vault = readVault();
  const existing = vault[key];
  vault[key] = existing
    ? { ...existing, value }
    : {
        value,
        type: inferSecretType(key),
        shareable:
          inferSecretType(key) === "api_key" &&
          DEFAULT_SHAREABLE_KEYS.has(key.toUpperCase()),
      };
  writeVault(vault);
}

/** Persist a fully-specified Vault 2.0 entry. Used by ingress enforcement. */
export function setVaultEntry(key: string, entry: VaultEntry): void {
  const vault = readVault();
  vault[key] = entry;
  writeVault(vault);
}

/**
 * Update only the `value` (and optionally the refresh block) of an
 * existing entry. Used by the OAuth refresher daemon to rotate
 * access tokens without disturbing `type` / `shareable`.
 *
 * Returns false when the key doesn't exist.
 */
export function rotateOAuthAccessToken(
  key: string,
  newValue: string,
  refreshPatch: Partial<OAuthRefreshBlock>,
): boolean {
  const vault = readVault();
  const existing = vault[key];
  if (!existing) return false;
  const merged: VaultEntry = {
    ...existing,
    value: newValue,
    refresh: existing.refresh
      ? { ...existing.refresh, ...refreshPatch }
      : undefined,
  };
  vault[key] = merged;
  writeVault(vault);
  return true;
}

/**
 * Record a refresh failure (e.g. invalid_grant) without rotating
 * the access token. Lets the dashboard surface the error and the
 * AUTH_REQUIRED modal trigger a re-auth flow.
 */
export function recordOAuthRefreshError(key: string, message: string): boolean {
  const vault = readVault();
  const existing = vault[key];
  if (!existing || !existing.refresh) return false;
  vault[key] = {
    ...existing,
    refresh: { ...existing.refresh, last_error: message },
  };
  writeVault(vault);
  return true;
}

/** Snapshot of every OAuth entry that has a usable refresh block. */
export function listOAuthEntries(): Array<{ key: string; entry: VaultEntry }> {
  const vault = readVault();
  const out: Array<{ key: string; entry: VaultEntry }> = [];
  for (const [k, e] of Object.entries(vault)) {
    if (e.type === "oauth" && e.refresh) {
      out.push({ key: k, entry: e });
    }
  }
  return out;
}

/** Vault keys must look like env-style identifiers (ASCII). */
export const VAULT_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface VaultEntrySummary {
  key: string;
  /** True when the stored string is non-empty after trim. */
  has_value: boolean;
  type: SecretType;
  shareable: boolean;
  /** True when an OAuth refresh block is present. */
  has_refresh: boolean;
  /** OAuth access-token expiry (ms since epoch) when known. */
  expires_at_ms: number | null;
  /** Surface a recent refresher error so the dashboard can warn. */
  refresh_error: string | null;
}

/**
 * List vault keys for dashboards — never returns secret values.
 * Includes the Vault 2.0 metadata (`type`, `shareable`) so the UI can
 * render badges and disable share toggles for PAT/OAUTH entries.
 */
export function listVaultSummary(): VaultEntrySummary[] {
  const vault = readVault();
  const out: VaultEntrySummary[] = [];
  for (const [k, entry] of Object.entries(vault)) {
    out.push({
      key: k,
      has_value: entry.value.trim().length > 0,
      type: entry.type,
      shareable: entry.shareable,
      has_refresh: !!entry.refresh,
      expires_at_ms:
        typeof entry.refresh?.expires_at_ms === "number"
          ? entry.refresh.expires_at_ms
          : null,
      refresh_error: entry.refresh?.last_error ?? null,
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Same as {@link listVaultSummary} but typed for downstream callers
 * that want the structural metadata (egress firewall, dashboard).
 */
export function listVaultMetadata(): VaultEntrySummary[] {
  return listVaultSummary();
}

/** Remove a key from `vault.json`. Returns false if the key did not exist. */
export function deleteVaultKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 128) {
    return false;
  }
  const vault = readVault();
  if (!(key in vault)) return false;
  delete vault[key];
  writeVault(vault);
  return true;
}
