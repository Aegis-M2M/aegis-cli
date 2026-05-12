// ════════════════════════════════════════════════════════════════════
//  Local Golden Path overrides
// ════════════════════════════════════════════════════════════════════
//
// LLMs occasionally hallucinate deep-link parameters or instructions.
// When the proxy's AuthResearcher returns a broken URL or unclear
// steps, the user needs an escape hatch — without having to wait for
// a global proxy-side fix.
//
// This store lives entirely on the user's machine
// (`~/.aegis/auth-overrides.json`) and is overlaid onto the proxy's
// `authorize_instructions` rows when the dashboard renders the Quick
// Connect strip or the AUTH_REQUIRED modal. The proxy is never
// mutated — overrides stay private to this node.

import fs from "node:fs";
import path from "node:path";
import { AUTH_OVERRIDES_PATH, CONFIG_DIR } from "../config.js";

export type AuthInstructionType = "PAT" | "OAUTH_PKCE" | "API_KEY";

export interface AuthInstructionsView {
  provider: string;
  auth_type: AuthInstructionType;
  authorize_url_template: string;
  instructions: string[];
  manifest?: Record<string, unknown>;
  last_verified?: string;
  /** Set when this view was assembled from a local override layer. */
  user_override?: boolean;
}

export interface AuthOverridePatch {
  auth_type?: AuthInstructionType;
  authorize_url_template?: string;
  instructions?: string[];
  manifest?: Record<string, unknown>;
}

interface OverrideStoreFile {
  /** ms since epoch when the patch was last touched, for diagnostics. */
  updated_at_ms: number;
  patch: AuthOverridePatch;
}

function ensureDir(): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
  } catch (err) {
    console.error("[AuthOverrides] Failed to ensure CONFIG_DIR:", err);
  }
}

function readStore(): Record<string, OverrideStoreFile> {
  try {
    if (!fs.existsSync(AUTH_OVERRIDES_PATH)) return {};
    const raw = fs.readFileSync(AUTH_OVERRIDES_PATH, "utf-8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, OverrideStoreFile> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const obj = v as Record<string, unknown>;
      const patch = obj.patch as AuthOverridePatch | undefined;
      if (!patch || typeof patch !== "object") continue;
      out[k] = {
        updated_at_ms:
          typeof obj.updated_at_ms === "number" ? obj.updated_at_ms : 0,
        patch,
      };
    }
    return out;
  } catch (err) {
    console.error("[AuthOverrides] readStore:", err);
    return {};
  }
}

function writeStore(store: Record<string, OverrideStoreFile>): void {
  ensureDir();
  fs.writeFileSync(
    AUTH_OVERRIDES_PATH,
    JSON.stringify(store, null, 2) + "\n",
    { mode: 0o600 },
  );
}

/** Public path for diagnostics. */
export function getAuthOverridesPath(): string {
  return path.resolve(AUTH_OVERRIDES_PATH);
}

export function listAuthOverrides(): Array<{
  provider: string;
  patch: AuthOverridePatch;
  updated_at_ms: number;
}> {
  const store = readStore();
  return Object.entries(store).map(([provider, row]) => ({
    provider,
    patch: row.patch,
    updated_at_ms: row.updated_at_ms,
  }));
}

export function getAuthOverride(provider: string): AuthOverridePatch | null {
  const store = readStore();
  return store[provider]?.patch ?? null;
}

export function setAuthOverride(
  provider: string,
  patch: AuthOverridePatch,
): AuthOverridePatch {
  if (!provider || typeof provider !== "string") {
    throw new Error("provider id is required");
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be an object");
  }
  const store = readStore();
  const cleaned: AuthOverridePatch = {};
  if (
    patch.auth_type === "PAT" ||
    patch.auth_type === "OAUTH_PKCE" ||
    patch.auth_type === "API_KEY"
  ) {
    cleaned.auth_type = patch.auth_type;
  }
  if (
    typeof patch.authorize_url_template === "string" &&
    patch.authorize_url_template.trim().length > 0
  ) {
    // Light URL sanity — refuse anything we can't parse.
    try {
      const u = new URL(patch.authorize_url_template.trim());
      if (u.protocol === "http:" || u.protocol === "https:") {
        cleaned.authorize_url_template = patch.authorize_url_template.trim();
      } else {
        throw new Error("authorize_url_template must use http(s)");
      }
    } catch (err) {
      throw new Error(
        `authorize_url_template is invalid: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (Array.isArray(patch.instructions)) {
    cleaned.instructions = patch.instructions
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 12);
  }
  if (
    patch.manifest &&
    typeof patch.manifest === "object" &&
    !Array.isArray(patch.manifest)
  ) {
    cleaned.manifest = patch.manifest as Record<string, unknown>;
  }
  store[provider] = { updated_at_ms: Date.now(), patch: cleaned };
  writeStore(store);
  return cleaned;
}

export function deleteAuthOverride(provider: string): boolean {
  const store = readStore();
  if (!(provider in store)) return false;
  delete store[provider];
  writeStore(store);
  return true;
}

/**
 * Overlay the local override (if any) on top of an upstream
 * `authorize_instructions` row. Returns the upstream value as-is when
 * no override exists. Sets `user_override: true` when at least one
 * field came from disk.
 */
export function applyOverride(
  upstream: AuthInstructionsView | null,
  provider: string,
): AuthInstructionsView | null {
  const patch = getAuthOverride(provider);
  if (!upstream && !patch) return null;
  if (!patch) return upstream;
  const merged: AuthInstructionsView = upstream
    ? { ...upstream }
    : {
        provider,
        auth_type: "API_KEY",
        authorize_url_template: "",
        instructions: [],
        manifest: {},
      };
  if (patch.auth_type) merged.auth_type = patch.auth_type;
  if (typeof patch.authorize_url_template === "string") {
    merged.authorize_url_template = patch.authorize_url_template;
  }
  if (Array.isArray(patch.instructions)) {
    merged.instructions = patch.instructions;
  }
  if (patch.manifest) merged.manifest = patch.manifest;
  merged.user_override = true;
  return merged;
}

/** Merge local-only overrides (no upstream row) into a list of providers. */
export function mergeListWithOverrides(
  upstream: AuthInstructionsView[],
): AuthInstructionsView[] {
  const byProvider = new Map<string, AuthInstructionsView>();
  for (const row of upstream) byProvider.set(row.provider, row);
  for (const ov of listAuthOverrides()) {
    const merged = applyOverride(byProvider.get(ov.provider) ?? null, ov.provider);
    if (merged) byProvider.set(ov.provider, merged);
  }
  return [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}
