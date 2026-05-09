import fs from "fs";
import { CONFIG_DIR, VAULT_PATH } from "../config.js";

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

  const exampleObj: Record<string, string> = {};
  for (const k of secretKeyNames.length > 0 ? secretKeyNames : ["EXAMPLE_KEY_NAME"]) {
    exampleObj[k] = "<paste value here>";
  }
  const example = JSON.stringify(exampleObj, null, 2);

  return [
    "### How the user adds the key",
    "",
    "1. **Name of each key** — " + namesLine,
    `2. **Where** — Edit the local vault file on disk: ${location}`,
    "3. **Format** — Plain JSON object. Merge new keys into the existing object if `vault.json` already has entries.",
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
  try {
    if (!fs.existsSync(VAULT_PATH)) return null;
    const vault = JSON.parse(fs.readFileSync(VAULT_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    const value = vault[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    console.error(`[Vault] Error reading secret ${key}:`, error);
    return null;
  }
}

/** Top-level property names from `vault.json` (whether or not values are populated). */
export function getAllVaultKeys(): string[] {
  try {
    if (!fs.existsSync(VAULT_PATH)) return [];
    const vault = JSON.parse(fs.readFileSync(VAULT_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    return Object.keys(vault);
  } catch (e) {
    console.error("[Vault] getAllVaultKeys:", e);
    return [];
  }
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

/**
 * For each vault key matching `*_API_KEY` with a non-empty value, returns the
 * provider-style prefix (e.g. POLYGON_API_KEY → POLYGON). Used as Router `key_hints`.
 */
export function listApiKeyProviderHintsFromVault(): string[] {
  try {
    if (!fs.existsSync(VAULT_PATH)) return [];
    const vault = JSON.parse(fs.readFileSync(VAULT_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    const hints = new Set<string>();
    for (const [name, val] of Object.entries(vault)) {
      if (!/_API_KEY$/i.test(name)) continue;
      if (typeof val !== "string" || val.trim().length === 0) continue;
      const hint = canonicalize(name);
      if (hint.length > 0) hints.add(hint);
    }
    return [...hints].sort();
  } catch (e) {
    console.error("[Vault] listApiKeyProviderHintsFromVault:", e);
    return [];
  }
}

export function setSecret(key: string, value: string): void {
  let vault: Record<string, string> = {};
  if (fs.existsSync(VAULT_PATH)) {
    vault = JSON.parse(fs.readFileSync(VAULT_PATH, "utf-8")) as Record<
      string,
      string
    >;
  }
  vault[key] = value;
  fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 });
}
