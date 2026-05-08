// ════════════════════════════════════════════════════════════════════
//  Local-execution helpers: vault injection + placeholder cleanup
// ════════════════════════════════════════════════════════════════════
//
// Both consumers (`run-catalog-tool.ts` for `aegis-omni-tool`'s
// "local" branch, and `relay/listener.ts` for inbound relay calls)
// receive a compiled HTTP request — `{ url, method, headers, body }` —
// where credentials are still `{{NAME}}` placeholders. The proxy/relay
// chose user-key delegation, so the actual secret value lives in the
// caller's vault, not on the server.
//
// `injectSecretsIntoCompiled` walks the request and substitutes every
// `{{NAME}}` for the matching vault entry; `cleanupCompiledRequestPlaceholders`
// then strips any remaining unresolved placeholders (optional fields
// that weren't filled in) so the wire payload doesn't leak template
// syntax to the upstream API.
//
// The richer JIT / capability-manifest helpers that used to live here
// (executeCapabilityManifestLocal, executeLocalPreflight, etc.) were
// removed: third-party tools no longer self-register, so the daemon
// has no manifests to interpret.

import { resolveVaultSecret } from "../crypto/vault.js";

const UNRESOLVED_PLACEHOLDER_VALUE = /^\{\{[a-zA-Z0-9_]+\}\}$/;

/**
 * After vault substitution, drop query params and headers that are still
 * a bare `{{NAME}}` so optional manifest fields do not leak to the wire.
 */
function cleanupUnusedPlaceholdersInUrl(url: string): string {
  try {
    const u = new URL(url);
    const drop: string[] = [];
    u.searchParams.forEach((val, key) => {
      if (UNRESOLVED_PLACEHOLDER_VALUE.test(val.trim())) drop.push(key);
    });
    for (const k of drop) u.searchParams.delete(k);
    const result = u.toString();
    return result.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  } catch {
    return url
      .replace(/[&?][^&?#]+=\{\{[^}]+\}\}/g, "")
      .replace(/\?&/g, "?")
      .replace(/&&+/g, "&")
      .replace(/[&?]$/, "");
  }
}

function cleanupUnresolvedPlaceholdersInHeaders(
  headers: Record<string, string>,
): void {
  for (const [k, v] of Object.entries({ ...headers })) {
    if (UNRESOLVED_PLACEHOLDER_VALUE.test(v.trim())) {
      delete headers[k];
    }
  }
}

export function cleanupCompiledRequestPlaceholders(compiled: {
  url: string;
  headers: Record<string, string>;
}): void {
  compiled.url = cleanupUnusedPlaceholdersInUrl(compiled.url);
  cleanupUnresolvedPlaceholdersInHeaders(compiled.headers);
}

function interpolateVaultPlaceholders(
  tpl: unknown,
  secrets: Record<string, string>,
): unknown {
  const re = /\{\{([a-zA-Z0-9_]+)\}\}/g;
  if (typeof tpl === "string") {
    return tpl.replace(re, (_, name: string) => secrets[name] ?? `{{${name}}}`);
  }
  if (tpl && typeof tpl === "object" && !Array.isArray(tpl)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tpl as Record<string, unknown>)) {
      o[k] = interpolateVaultPlaceholders(v, secrets);
    }
    return o;
  }
  if (Array.isArray(tpl)) {
    return tpl.map((x) => interpolateVaultPlaceholders(x, secrets));
  }
  return tpl;
}

export function injectSecretsIntoCompiled(
  compiled: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  },
  secretKeys: string[],
): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
} {
  const secrets: Record<string, string> = {};
  for (const secretName of secretKeys) {
    const v = resolveVaultSecret(secretName);
    console.error(
      `[Hub] Attempting to inject ${secretName}... (Found: ${!!v})`,
    );
    if (!v) throw new Error(`Missing vault key: ${secretName}`);
    secrets[secretName] = v;
  }
  return {
    url: interpolateVaultPlaceholders(compiled.url, secrets) as string,
    method: compiled.method,
    headers: interpolateVaultPlaceholders(compiled.headers, secrets) as Record<
      string,
      string
    >,
    body:
      compiled.body !== undefined
        ? interpolateVaultPlaceholders(compiled.body, secrets)
        : undefined,
  };
}
