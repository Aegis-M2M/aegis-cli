import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { catalogEntryHasExecutableManifest } from "../executor/preflight.js";
import { catalogEntryNeedsHubHydration, listDispatchableServiceIds, loadServices, syncWithHub } from "../services/catalog.js";
import { runCatalogToolCall } from "../executor/run-catalog-tool.js";

export const sseSessions = new Map<string, SSEServerTransport>();

let hubSyncForSseSessionDone = false;

/** Shallow hub sync: refresh local `services.json` stubs from the router. */
export async function syncHubOnMcpBoot(): Promise<void> {
  console.error("[MCP] Initializing Aegis Hub...");
  try {
    const stats = await syncWithHub();
    console.error(
      `[MCP] Hub Sync Complete: Merged ${stats.merged} service stub(s) (${stats.skipped} skipped).`,
    );
  } catch (e) {
    console.error("[MCP] Initial Hub sync failed (offline mode):", e);
  }
}

/** First SSE MCP connection in this process pulls hub stubs (stdio always calls `syncHubOnMcpBoot` separately). */
export async function ensureHubSyncBeforeMcpSse(): Promise<void> {
  if (hubSyncForSseSessionDone) return;
  hubSyncForSseSessionDone = true;
  await syncHubOnMcpBoot();
}

function hubInputSchema(serviceIds: string[]): Record<string, unknown> {
  const serviceProp =
    serviceIds.length > 0
      ? {
          type: "string",
          enum: serviceIds,
          description:
            "Registered Aegis service id from the local catalog (`services.json`).",
        }
      : {
          type: "string",
          description:
            "No services registered yet. Register providers (e.g. start aegis-proxy) so ids appear here, then reconnect MCP.",
        };

  return {
    type: "object",
    properties: {
      service: serviceProp,
      params: {
        type: "object",
        description:
          "Request body for that service. Shape must match the tool's `expected_schema` in the catalog / router. For hub-synced capabilities with multiple endpoints, include `endpoint_id` when required.",
      },
    },
    required: ["service", "params"],
  };
}

function normalizeExpectedSchemaForMcp(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const o = schema as Record<string, unknown>;
    if (o.type === "object") return o;
  }
  return {
    type: "object",
    additionalProperties: true,
    description: "Parameters for this capability endpoint.",
  };
}

const MCP_LIST_SCHEMA_MAX_DEPTH = 2;
const MCP_LIST_DESC_MAX = 200;

/**
 * Shallow JSON Schema projection for `list_tools`: property names, basic types,
 * short descriptions — avoids shipping large nested schemas to the model.
 */
function simplifyInputSchemaForMcpList(
  schema: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth >= MCP_LIST_SCHEMA_MAX_DEPTH) {
    return {
      type: "object",
      additionalProperties: true,
      description: "Nested fields omitted in tool list — call the tool using endpoint docs.",
    };
  }

  const baseObj = normalizeExpectedSchemaForMcp(schema);

  const o = baseObj;
  if (o.type !== "object" || !o.properties || typeof o.properties !== "object" || Array.isArray(o.properties)) {
    const outFlat: Record<string, unknown> = {};
    if (typeof o.type === "string") outFlat.type = o.type;
    if (typeof o.description === "string") {
      outFlat.description = o.description.slice(0, MCP_LIST_DESC_MAX);
    }
    if (Object.keys(outFlat).length > 0) return outFlat;
    return {
      type: "object",
      additionalProperties: true,
    };
  }

  const propsIn = o.properties as Record<string, unknown>;
  const propsOut: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(propsIn)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      propsOut[key] = {
        type: "object",
        additionalProperties: true,
      };
      continue;
    }
    const sub = val as Record<string, unknown>;
    const simplified: Record<string, unknown> = {};
    if (typeof sub.type === "string") simplified.type = sub.type;
    else if (
      sub.properties &&
      typeof sub.properties === "object" &&
      !Array.isArray(sub.properties)
    ) {
      simplified.type = "object";
    } else if (sub.items !== undefined || sub.prefixItems !== undefined) {
      simplified.type = "array";
    }

    if (typeof sub.description === "string") {
      simplified.description = sub.description.slice(0, MCP_LIST_DESC_MAX);
    }

    const subHasNested =
      (typeof sub.properties === "object" &&
        sub.properties !== null &&
        !Array.isArray(sub.properties) &&
        Object.keys(sub.properties).length > 0) ||
      sub.additionalProperties !== undefined ||
      sub.items !== undefined ||
      sub.anyOf !== undefined ||
      sub.oneOf !== undefined;

    if (subHasNested && simplified.type !== undefined) {
      propsOut[key] = simplifyInputSchemaForMcpList(val, depth + 1);
    } else if (Object.keys(simplified).length > 0) {
      propsOut[key] = simplified;
    } else {
      propsOut[key] = { type: "object", additionalProperties: true };
    }
  }

  const trimmed: Record<string, unknown> = {
    type: "object",
    properties: propsOut,
  };

  const req = o.required;
  if (Array.isArray(req)) {
    const names = req.filter((x): x is string => typeof x === "string");
    if (names.length > 0) trimmed.required = [...new Set(names)].slice(0, 48);
  }
  if (o.additionalProperties === true) trimmed.additionalProperties = true;
  return trimmed;
}

function stubHubCapabilityToolName(serviceId: string): string {
  return `cap_${mcpSafeSegment(serviceId)}_lazyhub`;
}

function hubStubToolInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      endpoint_id: {
        type: "string",
        description:
          "Manifest endpoint id. Required when the capability defines more than one endpoint.",
      },
      user_intent: {
        type: "string",
        description:
          "What you are trying to do. Required for on-demand Micro-Bridge when the hub has no manifest (with doc_url or search_query).",
      },
      doc_url: {
        type: "string",
        description:
          "Single official documentation URL to scrape (no crawling). Used with user_intent to JIT-sync a Micro-Manifest into this provider.",
      },
      single_url: {
        type: "string",
        description: "Alias of doc_url for aegis-bridge compatibility.",
      },
      search_query: {
        type: "string",
        description:
          "If doc_url is unknown: web search query; the CLI runs aegis-search and picks a doc-like result, then aegis-bridge Micro-Bridge.",
      },
      jit_search_query: {
        type: "string",
        description: "Alias of search_query.",
      },
    },
    additionalProperties: true,
    description:
      "Hub stub: hydrated tools use manifest expected_schema. For unknown providers, pass user_intent plus doc_url or search_query to run search → Micro-Bridge → merge into the Virtual SDK.",
  };
}

function mcpSafeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
}

function capabilityToolName(serviceId: string, endpointId: string): string {
  return `cap_${mcpSafeSegment(serviceId)}_${mcpSafeSegment(endpointId)}`;
}

export interface ManifestMcpToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serviceId: string;
  /** Set for per-endpoint capability tools once the manifest is hydrated. */
  endpointId?: string;
  /** One aggregate tool until the merged Virtual SDK is fetched from the hub. */
  stub?: boolean;
}

/** MCP tools derived from hub capabilities (stub or hydrated per-endpoint). */
export function listManifestMcpTools(): ManifestMcpToolMeta[] {
  const catalog = loadServices();
  const out: ManifestMcpToolMeta[] = [];
  for (const serviceId of listDispatchableServiceIds()) {
    const meta = catalog[serviceId] as Record<string, unknown> | undefined;
    if (!meta) continue;

    if (catalogEntryNeedsHubHydration(meta)) {
      const provider =
        typeof meta.hub_provider_name === "string"
          ? meta.hub_provider_name
          : serviceId;
      const summary =
        typeof meta.hub_stub_description === "string"
          ? meta.hub_stub_description
          : provider;
      const base = `${provider} — ${summary}`;
      const desc = `${base} [First call fetches the merged Virtual SDK from the Router hub.]`.slice(
        0,
        4000,
      );
      out.push({
        name: stubHubCapabilityToolName(serviceId),
        description: desc,
        inputSchema: hubStubToolInputSchema(),
        serviceId,
        stub: true,
      });
      continue;
    }

    if (!catalogEntryHasExecutableManifest(meta)) continue;
    const manifest = meta.manifest as Record<string, unknown>;
    const provider =
      typeof manifest.provider === "string" ? manifest.provider : serviceId;
    const endpoints = manifest.endpoints as unknown[];
    if (!Array.isArray(endpoints)) continue;
    for (const ep of endpoints) {
      if (!ep || typeof ep !== "object" || Array.isArray(ep)) continue;
      const e = ep as Record<string, unknown>;
      if (typeof e.id !== "string") continue;
      const name = capabilityToolName(serviceId, e.id);
      const desc =
        typeof e.description === "string"
          ? `${provider} — ${e.description}`
          : `${provider} — endpoint ${e.id}`;
      out.push({
        name,
        description: desc,
        inputSchema: simplifyInputSchemaForMcpList(
          normalizeExpectedSchemaForMcp(e.expected_schema),
        ),
        serviceId,
        endpointId: e.id,
      });
    }
  }
  return out;
}

export function createSessionMcpServer(): Server {
  const server = new Server(
    { name: "Aegis Hub", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const serviceIds = listDispatchableServiceIds();
    const count = serviceIds.length;
    const manifestTools = listManifestMcpTools();

    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [
      {
        name: "aegis_hub",
        description:
          count === 0
            ? "Gateway to Aegis billable tools (Virtual SDK). No services are registered in the local catalog yet."
            : `Gateway to Aegis billable tools: each hub-backed provider exposes a merged Virtual SDK (atomic doc pages on the Router). ${count} service(s) in the local catalog: ${serviceIds.join(", ")}. Stubs appear as \`cap_…_lazyhub\` until hydration; pass \`user_intent\` + \`doc_url\` or \`search_query\` on that stub to run JIT Micro-Bridge (search → one-page synthesis). Then one \`cap_<service>_<endpoint>\` tool per operation. After bridging, use \`aegis_refresh_catalog\`.`,
        inputSchema: hubInputSchema(serviceIds),
      },
      {
        name: "aegis_refresh_catalog",
        description:
          "Syncs the local tool index with the Router Capability Hub (shallow merge: ids, descriptions, stubs). Run after aegis-bridge or new hub registrations so `aegis_hub` and `cap_*` tools reflect new services. Re-list tools in the client if the enum did not update.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ];

    for (const t of manifestTools) {
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    try {
      if (name === "aegis_refresh_catalog") {
        const stats = await syncWithHub();
        return {
          content: [
            {
              type: "text",
              text: `Catalog refreshed. Merged ${stats.merged} hub stub(s) into the local catalog (${stats.skipped} skipped). You can use new services via aegis_hub and cap_* tools; re-list tools in the host if enums look stale.`,
            },
          ],
        };
      }

      const manifestTools = listManifestMcpTools();
      const manifestHit = manifestTools.find((t) => t.name === name);
      if (manifestHit) {
        if (manifestHit.stub || manifestHit.endpointId == null) {
          const rawArgs = (args ?? {}) as Record<string, unknown>;
          return runCatalogToolCall(manifestHit.serviceId, rawArgs);
        }
        const rawArgs = (args ?? {}) as Record<string, unknown>;
        return runCatalogToolCall(manifestHit.serviceId, {
          endpoint_id: manifestHit.endpointId,
          ...rawArgs,
        });
      }

      if (name !== "aegis_hub") {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}. This server exposes "aegis_hub", "aegis_refresh_catalog", \`cap_*_lazyhub\` (hub stubs), and per-endpoint \`cap_*\` tools once hydrated.`,
            },
          ],
          isError: true,
        };
      }

      const { service, params } = (args ?? {}) as {
        service?: string;
        params?: Record<string, unknown>;
      };
      const catalog = loadServices();
      if (!service || !catalog[service]) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown Aegis service: ${service ?? "(missing)"}`,
            },
          ],
          isError: true,
        };
      }
      return runCatalogToolCall(
        service,
        (params ?? {}) as Record<string, unknown>,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/** MCP over stdio (e.g. Cursor) — blocks until transport closes. */
export async function runMcpStdio(): Promise<void> {
  await syncHubOnMcpBoot();
  const server = createSessionMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { SSEServerTransport, StdioServerTransport };
