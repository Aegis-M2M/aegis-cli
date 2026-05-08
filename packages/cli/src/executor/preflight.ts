import { AEGIS_ROUTER_BASE } from "../config.js";
import { userAccount } from "../crypto/identity.js";
import { getSecret } from "../crypto/vault.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";
import { executeAegisRequest } from "./router-client.js";

const MANIFEST_ARG_RESERVED = new Set([
  "endpoint_id",
  "endpoint",
  "capability_id",
  "_preflight",
  "_wallet_id",
  "service",
  "user_intent",
  "doc_url",
  "single_url",
  "search_query",
  "jit_search_query",
  "key_hints",
]);

const UNRESOLVED_PLACEHOLDER_VALUE = /^\{\{[a-zA-Z0-9_]+\}\}$/;

/**
 * After vault + user substitution, drop query params and headers that are still
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function substituteUserPlaceholders(
  s: string,
  args: Record<string, unknown>,
  reserved: Set<string>,
): string {
  let out = s.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  for (const [k, val] of Object.entries(args)) {
    if (reserved.has(k) || val === undefined || val === null) continue;
    const strVal =
      typeof val === "object" && val !== null
        ? JSON.stringify(val)
        : String(val);
    out = out.split(`{{${k}}}`).join(strVal);
    out = out.replace(new RegExp(`\\$\\{${escapeRegex(k)}\\}`, "g"), strVal);
  }
  return out;
}

function interpolateManifestUserArgs(
  tpl: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  },
  args: Record<string, unknown>,
  reserved: Set<string>,
): void {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return substituteUserPlaceholders(v, args, reserved);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        o[k] = walk(x);
      }
      return o;
    }
    if (Array.isArray(v)) return v.map(walk);
    return v;
  };

  tpl.url = substituteUserPlaceholders(tpl.url, args, reserved);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl.headers)) {
    headers[k] = substituteUserPlaceholders(v, args, reserved);
  }
  tpl.headers = headers;
  if (tpl.body !== undefined && tpl.body !== null) {
    tpl.body = walk(tpl.body);
  }
}

export function catalogEntryHasExecutableManifest(
  meta: Record<string, unknown> | undefined,
): boolean {
  if (!meta) return false;
  const m = meta.manifest;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  const endpoints = (m as Record<string, unknown>).endpoints;
  return Array.isArray(endpoints) && endpoints.length > 0;
}

function selectManifestEndpoint(
  manifest: Record<string, unknown>,
  args: Record<string, unknown>,
): {
  id: string;
  request_template: Record<string, unknown>;
} {
  const endpoints = manifest.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error("Capability manifest has no endpoints");
  }

  const rawId =
    typeof args.endpoint_id === "string"
      ? args.endpoint_id
      : typeof args.endpoint === "string"
        ? args.endpoint
        : null;

  let ep: Record<string, unknown> | null = null;
  if (rawId) {
    for (const e of endpoints) {
      if (
        e &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        (e as Record<string, unknown>).id === rawId
      ) {
        ep = e as Record<string, unknown>;
        break;
      }
    }
    if (!ep) {
      throw new Error(`Unknown manifest endpoint_id: "${rawId}"`);
    }
  } else if (endpoints.length === 1) {
    ep = endpoints[0] as Record<string, unknown>;
  } else {
    throw new Error(
      "Multiple capability endpoints — set `endpoint_id` (and parameters for that endpoint).",
    );
  }

  const rt = ep.request_template;
  if (!rt || typeof rt !== "object" || Array.isArray(rt)) {
    throw new Error(`Endpoint "${String(ep.id)}" has no request_template`);
  }
  return { id: String(ep.id), request_template: rt as Record<string, unknown> };
}

/**
 * Execute a hub-synced Capability Manifest locally: vault placeholders → user arg
 * substitution → outbound HTTP. Skips the proxy JIT/bridge round-trip.
 */
export async function executeCapabilityManifestLocal(
  _service: string,
  args: Record<string, unknown>,
  secretKeys: string[],
  meta: Record<string, unknown>,
): Promise<unknown> {
  const manifest = meta.manifest as Record<string, unknown>;
  const { request_template } = selectManifestEndpoint(manifest, args);

  const tmpl = JSON.parse(JSON.stringify(request_template)) as {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  };

  if (typeof tmpl.url !== "string" || typeof tmpl.method !== "string") {
    throw new Error("request_template must include string url and method");
  }
  if (
    typeof tmpl.headers !== "object" ||
    tmpl.headers === null ||
    Array.isArray(tmpl.headers)
  ) {
    throw new Error("request_template.headers must be an object");
  }

  const injected = injectSecretsIntoCompiled(
    {
      url: tmpl.url,
      method: String(tmpl.method).toUpperCase(),
      headers: tmpl.headers as Record<string, string>,
      body: tmpl.body,
    },
    secretKeys,
  );

  interpolateManifestUserArgs(injected, args, MANIFEST_ARG_RESERVED);
  cleanupCompiledRequestPlaceholders(injected);

  const methodUpper = injected.method.toUpperCase();
  const init: RequestInit = {
    method: injected.method,
    headers: injected.headers,
    signal: AbortSignal.timeout(120_000),
  };
  const mayHaveBody = methodUpper !== "GET" && methodUpper !== "HEAD";
  if (
    mayHaveBody &&
    injected.body !== undefined &&
    injected.body !== null
  ) {
    init.body =
      typeof injected.body === "string"
        ? injected.body
        : JSON.stringify(injected.body);
  }

  const r = await fetch(injected.url, init);
  const text = await r.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  if (!r.ok) {
    const snippet = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(
      `Local capability fetch failed (${r.status}): ${snippet.slice(0, 1200)}`,
    );
  }
  return data;
}

export function interpolateVaultPlaceholders(
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
    const keyVal = process.env[secretName];
    console.error(
      `[Hub] Attempting to inject ${secretName}... (Found: ${!!keyVal})`,
    );
    const v = getSecret(secretName);
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

export function buildInjectedSecretsMap(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = getSecret(k);
    if (v) out[k] = v;
  }
  return out;
}

export async function sendLocalExecutorTelemetry(
  service: string,
): Promise<void> {
  try {
    await fetch(`${AEGIS_ROUTER_BASE}/v1/telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await signAegisRequestHeaders(userAccount)),
      },
      body: JSON.stringify({
        type: "telemetry",
        phase: "local_executor",
        service,
      }),
    });
  } catch {
    /* optional ping */
  }
}

/** Router preflight → substitute vault → HTTP on user machine. */
export async function executeLocalPreflight(
  service: string,
  args: Record<string, unknown>,
  secretKeys: string[],
): Promise<unknown> {
  const preflightPayload = { ...args, _preflight: true };
  const raw = await executeAegisRequest(service, preflightPayload);
  const payload = (raw as { data?: unknown })?.data ?? raw;
  const compiled = (payload as { _compiled_request?: unknown })?._compiled_request as
    | {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        body?: unknown;
      }
    | undefined;
  if (
    !compiled ||
    typeof compiled.url !== "string" ||
    typeof compiled.method !== "string" ||
    typeof compiled.headers !== "object" ||
    compiled.headers === null ||
    Array.isArray(compiled.headers)
  ) {
    throw new Error(
      "Preflight response did not include a valid _compiled_request (url, method, headers).",
    );
  }
  const injected = injectSecretsIntoCompiled(
    {
      url: compiled.url,
      method: String(compiled.method).toUpperCase(),
      headers: compiled.headers as Record<string, string>,
      body: compiled.body,
    },
    secretKeys,
  );

  cleanupCompiledRequestPlaceholders(injected);

  const methodUpper = injected.method.toUpperCase();
  const init: RequestInit = {
    method: injected.method,
    headers: injected.headers,
    signal: AbortSignal.timeout(120_000),
  };
  const mayHaveBody = methodUpper !== "GET" && methodUpper !== "HEAD";
  if (
    mayHaveBody &&
    injected.body !== undefined &&
    injected.body !== null
  ) {
    init.body =
      typeof injected.body === "string"
        ? injected.body
        : JSON.stringify(injected.body);
  }

  const r = await fetch(injected.url, init);
  const text = await r.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  if (!r.ok) {
    const snippet = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(
      `Local fetch failed (${r.status}): ${snippet.slice(0, 1200)}`,
    );
  }
  return data;
}
