import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import {
  AEGIS_HUB_CATALOG_ENDPOINT,
  AEGIS_HUB_CATALOG_STUBS_ENDPOINT,
  AEGIS_HUB_MANIFEST_ENDPOINT,
  AEGIS_HUB_PROVIDER_MANIFEST_ENDPOINT,
  CONFIG_DIR,
  SERVICE_ID_RE,
  SERVICES_PATH,
} from "../config.js";
import { catalogEntryHasExecutableManifest } from "../executor/preflight.js";
import { userAccount } from "../crypto/identity.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";

export function loadServices(): Record<string, unknown> {
  if (!existsSync(SERVICES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SERVICES_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export function saveServices(data: Record<string, unknown>): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SERVICES_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Ensure config dir and empty `services.json`; catalog rows come from provider registration. */
export function ensureBuiltinServices(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(SERVICES_PATH)) saveServices({});
}

const IGNORED_SERVICES = ["aegis-claude", "aegis-openai", "aegis-perplexity"];

/** Service ids that may be invoked via MCP `aegis_hub` (same filter as legacy per-tool list). */
export function listDispatchableServiceIds(): string[] {
  const services = loadServices();
  const ids: string[] = [];
  for (const id of Object.keys(services)) {
    if (!SERVICE_ID_RE.test(id)) continue;
    if (IGNORED_SERVICES.includes(id)) continue;
    ids.push(id);
  }
  return ids.sort();
}

/** Hub lightweight row from `GET /v1/hub/catalog/stubs`. */
export interface HubCatalogStubRow {
  id: string;
  provider_name: string;
  auth_strategy: string;
  description: string;
  updated_at_ms: number;
}

function deriveDescriptionFromManifest(
  manifest: unknown,
  providerName: string,
): string {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return providerName;
  }
  const m = manifest as Record<string, unknown>;
  const provider =
    typeof m.provider === "string" ? m.provider : providerName;
  const endpoints = m.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return provider;
  }
  const parts: string[] = [];
  const max = 3;
  for (let i = 0; i < Math.min(endpoints.length, max); i++) {
    const ep = endpoints[i];
    if (!ep || typeof ep !== "object" || Array.isArray(ep)) continue;
    const e = ep as Record<string, unknown>;
    const label = typeof e.id === "string" ? e.id : `endpoint${i}`;
    const desc =
      typeof e.description === "string" ? e.description : "";
    parts.push(desc ? `${label}: ${desc}` : label);
  }
  const summary = parts.join(" · ") || `${endpoints.length} endpoint(s)`;
  const suffix =
    endpoints.length > max ? ` (+${endpoints.length - max} more)` : "";
  return `${provider}. ${summary}${suffix}`.slice(0, 2000);
}

function optionalSecretsFromManifest(manifest: unknown): string[] {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    return [];
  }
  const required = (manifest as Record<string, unknown>).required_secrets;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
}

function mergeHubRowIntoServices(params: {
  services: Record<string, unknown>;
  id: string;
  provider_name: string;
  auth_strategy: string;
  description: string;
  /** When set, persist full manifest + optional_secrets; otherwise stub merge. */
  manifest: unknown | undefined;
}): void {
  const { services, id, provider_name, auth_strategy, description, manifest } =
    params;

  const prev =
    typeof services[id] === "object" && services[id] !== null
      ? { ...(services[id] as Record<string, unknown>) }
      : {};

  const next: Record<string, unknown> = {
    ...prev,
    id,
    hub_provider_name: provider_name,
    auth_strategy,
    hub_stub_description: description,
    hub_synced_at: new Date().toISOString(),
  };

  if (
    manifest !== undefined &&
    manifest !== null &&
    catalogEntryHasExecutableManifest({ manifest })
  ) {
    next.manifest = manifest;
    next.optional_secrets = optionalSecretsFromManifest(manifest);
  } else if (catalogEntryHasExecutableManifest(prev)) {
    next.manifest = prev.manifest;
    if (prev.optional_secrets !== undefined)
      next.optional_secrets = prev.optional_secrets;
  } else {
    delete next.manifest;
    delete next.optional_secrets;
  }

  services[id] = next;
}

/**
 * Fetch hub capability stubs from the router (or full catalog fallback) and
 * merge into `services.json`. Does not overwrite a locally hydrated manifest.
 */
export async function syncWithHub(): Promise<{
  merged: number;
  skipped: number;
}> {
  const headers = {
    ...(await signAegisRequestHeaders(userAccount)),
  };

  let r = await fetch(AEGIS_HUB_CATALOG_STUBS_ENDPOINT, { headers });
  let usedFullCatalogFallback = false;
  if (!r.ok && r.status === 404) {
    r = await fetch(AEGIS_HUB_CATALOG_ENDPOINT, { headers });
    usedFullCatalogFallback = true;
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `Hub catalog sync failed (${r.status}): ${t.slice(0, 800)}`,
    );
  }

  const raw = (await r.json()) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Hub catalog response must be a JSON object");
  }

  const services = loadServices();
  let merged = 0;
  let skipped = 0;

  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!SERVICE_ID_RE.test(id)) {
      skipped++;
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      skipped++;
      continue;
    }
    const row = entry as Record<string, unknown>;

    const provider_name =
      typeof row.provider_name === "string" ? row.provider_name : id;
    const auth_strategy =
      typeof row.auth_strategy === "string" ? row.auth_strategy : "user";

    if (!usedFullCatalogFallback) {
      const description =
        typeof row.description === "string" ? row.description : provider_name;
      mergeHubRowIntoServices({
        services,
        id,
        provider_name,
        auth_strategy,
        description,
        manifest: undefined,
      });
      merged++;
      continue;
    }

    mergeHubRowIntoServices({
      services,
      id,
      provider_name,
      auth_strategy,
      description: deriveDescriptionFromManifest(
        row.manifest,
        provider_name,
      ),
      manifest: undefined,
    });
    merged++;
  }

  saveServices(services);
  return { merged, skipped };
}

/** Hub-synced stub: needs merged Virtual SDK (`GET /v1/hub/provider/:id/manifest`) before execution. */
export function catalogEntryNeedsHubHydration(
  meta: Record<string, unknown> | undefined,
): boolean {
  if (!meta) return false;
  if (catalogEntryHasExecutableManifest(meta)) return false;
  return typeof meta.hub_synced_at === "string";
}

/**
 * Fetch full manifest from the router and persist into `services.json`
 * (idempotent after first write).
 */
export async function hydrateHubCapabilityManifest(
  serviceId: string,
): Promise<void> {
  if (!SERVICE_ID_RE.test(serviceId)) {
    throw new Error(`Invalid capability id: ${serviceId}`);
  }

  const headers = {
    ...(await signAegisRequestHeaders(userAccount)),
  };
  let r = await fetch(AEGIS_HUB_PROVIDER_MANIFEST_ENDPOINT(serviceId), {
    headers,
  });
  if (r.status === 404) {
    r = await fetch(AEGIS_HUB_MANIFEST_ENDPOINT(serviceId), { headers });
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `Hub manifest fetch failed (${r.status}): ${t.slice(0, 800)}`,
    );
  }

  const body = (await r.json()) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Hub manifest response must be a JSON object");
  }
  const row = body as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : serviceId;
  if (id !== serviceId) {
    throw new Error(`Manifest id mismatch: expected ${serviceId}, got ${id}`);
  }
  const provider_name =
    typeof row.provider_name === "string" ? row.provider_name : serviceId;
  const auth_strategy =
    typeof row.auth_strategy === "string" ? row.auth_strategy : "user";
  const manifest = row.manifest;
  const description = deriveDescriptionFromManifest(manifest, provider_name);

  const services = loadServices();
  mergeHubRowIntoServices({
    services,
    id: serviceId,
    provider_name,
    auth_strategy,
    description,
    manifest,
  });
  saveServices(services);
}

/**
 * Persist a successful `/api/bridge` JSON body into `services.json` so the CLI
 * can use the manifest immediately without waiting for a `syncWithHub()` pull.
 */
export function applyBridgeResponseToLocalCatalog(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Bridge response must be a JSON object");
  }
  const o = body as Record<string, unknown>;
  if (o.success !== true) {
    throw new Error("Bridge response must have success: true");
  }
  const manifest = o.manifest;
  const capabilityId =
    typeof o.hub_capability_id === "string"
      ? o.hub_capability_id.trim()
      : typeof o.capability_id === "string"
        ? o.capability_id.trim()
        : "";
  if (!capabilityId) {
    throw new Error("Bridge response missing hub_capability_id");
  }
  if (!catalogEntryHasExecutableManifest({ manifest })) {
    throw new Error("Bridge response missing a usable capability manifest");
  }
  const m = manifest as Record<string, unknown>;
  const provider =
    typeof m.provider === "string" ? m.provider : capabilityId;
  const auth_strategy =
    typeof o.auth_strategy === "string"
      ? o.auth_strategy
      : typeof m.auth_strategy === "string"
        ? (m.auth_strategy as string)
        : "user";
  const description = deriveDescriptionFromManifest(manifest, provider);
  const services = loadServices();
  mergeHubRowIntoServices({
    services,
    id: capabilityId,
    provider_name: provider,
    auth_strategy,
    description,
    manifest,
  });
  saveServices(services);
  return capabilityId;
}

/**
 * After a successful router `/v1/execute` for `aegis-bridge`, merge the payload
 * into `services.json` so later turns see the new capability without a hub sync.
 * Safe no-op for other services or non-bridge-shaped JSON.
 */
export function tryApplyBridgeResponseFromRouterResult(
  serviceId: string,
  routerJson: unknown,
): void {
  if (serviceId !== "aegis-bridge") return;
  if (
    routerJson === null ||
    typeof routerJson !== "object" ||
    Array.isArray(routerJson)
  ) {
    return;
  }
  const o = routerJson as Record<string, unknown>;
  if (o.success !== true || o.manifest == null) return;
  try {
    applyBridgeResponseToLocalCatalog(routerJson);
  } catch {
    /* not a mergeable bridge body */
  }
}

export { SERVICE_ID_RE };
