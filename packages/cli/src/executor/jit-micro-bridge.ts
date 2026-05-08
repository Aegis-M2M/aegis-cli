import { applyBridgeResponseToLocalCatalog } from "../services/catalog.js";
import { executeAegisRequest } from "./router-client.js";

const JIT_ARG_KEYS = new Set([
  "user_intent",
  "doc_url",
  "single_url",
  "search_query",
  "jit_search_query",
]);

export function stripJitKeysFromArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...args };
  for (const k of JIT_ARG_KEYS) delete out[k];
  return out;
}

/** True if tool args include enough context to run search and/or micro-bridge. */
export function canAttemptJitMicroBridge(args: Record<string, unknown>): boolean {
  const doc =
    (typeof args.doc_url === "string" && args.doc_url.trim().length > 0) ||
    (typeof args.single_url === "string" && args.single_url.trim().length > 0);
  const search =
    (typeof args.search_query === "string" &&
      args.search_query.trim().length > 0) ||
    (typeof args.jit_search_query === "string" &&
      args.jit_search_query.trim().length > 0);
  return doc === true || search === true;
}

function pickUrlFromSearchResults(raw: unknown): string | null {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (!o) return null;
  const results = o.results;
  if (!Array.isArray(results)) return null;
  const scored: { url: string; score: number }[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const url = (r as { url?: unknown }).url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    let score = 0;
    const u = url.toLowerCase();
    if (u.includes("docs.")) score += 4;
    if (u.includes("/docs")) score += 2;
    if (u.includes("developer")) score += 2;
    if (u.includes("api")) score += 2;
    if (u.includes("reference")) score += 1;
    scored.push({ url, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url ?? null;
}

/**
 * On-demand: optional web search → `aegis-bridge` micro call → merge into
 * `services.json` (router hub already stores per-doc_link slices).
 */
export async function runJitMicroBridgeAndMergeCatalog(params: {
  capabilityId: string;
  args: Record<string, unknown>;
}): Promise<{ docUrl: string }> {
  const { capabilityId, args } = params;
  let intent =
    typeof args.user_intent === "string" ? args.user_intent.trim() : "";
  if (!intent) {
    intent = `Extract the REST API operations needed for provider "${capabilityId}" from the documentation page.`;
  }

  let docUrl =
    (typeof args.doc_url === "string" && args.doc_url.trim()) ||
    (typeof args.single_url === "string" && args.single_url.trim()) ||
    "";

  const searchQ =
    (typeof args.search_query === "string" && args.search_query.trim()) ||
    (typeof args.jit_search_query === "string" &&
      args.jit_search_query.trim()) ||
    "";

  if (!docUrl && searchQ) {
    const searchRaw = await executeAegisRequest("aegis-search", {
      query: searchQ,
      max_results: 8,
      search_depth: "basic",
    });
    docUrl = pickUrlFromSearchResults(searchRaw) ?? "";
    if (!docUrl) {
      throw new Error(
        `aegis-search returned no URLs for query: ${searchQ.slice(0, 240)}`,
      );
    }
  }

  if (!docUrl) {
    throw new Error(
      "JIT micro-bridge requires doc_url or single_url, or search_query / jit_search_query to locate documentation.",
    );
  }

  const bridgeRaw = await executeAegisRequest("aegis-bridge", {
    single_url: docUrl,
    user_intent: intent,
    capability_id: capabilityId,
  });

  applyBridgeResponseToLocalCatalog(bridgeRaw);
  return { docUrl };
}
