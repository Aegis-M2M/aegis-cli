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
      const hint = name.replace(/_API_KEY$/i, "").trim();
      if (hint.length > 0) hints.add(hint.toUpperCase());
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
