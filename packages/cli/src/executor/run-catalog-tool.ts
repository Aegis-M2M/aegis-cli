// ════════════════════════════════════════════════════════════════════
//  Core Three MCP dispatch
// ════════════════════════════════════════════════════════════════════
//
// The MCP layer (`mcp-server.ts`) only ever forwards calls for these
// three tools to this module:
//
//   - `aegis-omni-tool`  — universal triage; the Proxy chooses
//                          platform / local-delegated / relay execution
//                          and may hand back a `delegate_request` that
//                          we run here against the user's vault keys.
//   - `aegis-search`     — direct router call (Tavily/Perplexity).
//   - `aegis-parse`      — direct router call (Hydra parse worker).
//
// All other discovery (JIT, manifest hydration, micro-bridge,
// services.json) was deleted: third-party tools no longer register
// themselves through the daemon and Cursor doesn't see anything
// outside the Core Three.

import {
  formatUserInstructionsForSecrets,
  listProviderHintsFromVault,
  resolveVaultSecret,
} from "../crypto/vault.js";
import {
  injectSecretsIntoCompiled,
  cleanupCompiledRequestPlaceholders,
} from "./preflight.js";
import {
  executeAegisRequest,
  parseRouterExecuteError,
} from "./router-client.js";
import { pushAuthRequired } from "../api/auth-events.js";

export function extractToolResult(serviceId: string, data: unknown): string {
  if (typeof data === "string") return data;
  if (data == null) return "";
  if (serviceId === "aegis-parse") {
    const parsed = data as Record<string, unknown>;
    const inner = (parsed.data ?? {}) as Record<string, unknown>;
    const markdown =
      inner.content ?? parsed.markdown ?? parsed.content;
    if (typeof markdown === "string" && markdown.length > 0) {
      const title = inner.title;
      return typeof title === "string" && title.length > 0
        ? `# ${title}\n\n${markdown}`
        : markdown;
    }
  }
  if (serviceId === "aegis-search") {
    const parsed = data as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
    const lines: string[] = [];
    if (parsed.answer) lines.push(`ANSWER: ${parsed.answer}`);
    if (parsed.results?.length) {
      lines.push("RESULTS:");
      for (const [i, r] of parsed.results.entries()) {
        lines.push(
          `${i + 1}. ${r.title ?? "(untitled)"} — ${r.url ?? ""}\n   ${r.snippet ?? ""}`,
        );
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }
  if (serviceId === "aegis-omni-tool") {
    const parsed =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    if (!parsed) {
      try {
        return JSON.stringify(data, null, 2);
      } catch {
        return String(data);
      }
    }
    const branch = parsed.type;
    const lines: string[] = [];
    lines.push(`[aegis-omni-tool] type=${String(branch)}`);
    const disc = parsed.discovery;
    if (disc && typeof disc === "object" && !Array.isArray(disc)) {
      const d = disc as Record<string, unknown>;
      lines.push(
        `discovery: tier=${String(d.tier)} candidates=${Array.isArray(d.candidates) ? d.candidates.join(",") : ""}`,
      );
    }
    if (parsed.provider_id || parsed.endpoint_id) {
      lines.push(
        `provider_id=${String(parsed.provider_id ?? "")} endpoint_id=${String(parsed.endpoint_id ?? "")}`,
      );
    }
    if (branch === "relay") {
      const relayer = parsed.relayed_by;
      const fee = parsed.fee_charged;
      const exec = parsed.exec_ms;
      lines.push(
        `relay: by=${String(relayer ?? "?")} fee=${String(fee ?? "?")} exec_ms=${String(exec ?? "?")}`,
      );
    }
    const upstream = parsed.upstream_data;
    if (upstream !== undefined) {
      lines.push("");
      lines.push(
        typeof upstream === "string"
          ? upstream
          : JSON.stringify(upstream, null, 2),
      );
      if (branch === "local") {
        lines.push("\n[Context: This data was fetched locally via your Aegis Hub]");
      } else if (branch === "relay") {
        lines.push(
          "\n[Context: This data was relayed by another Aegis user's daemon. The relayer was paid out of your credit balance.]",
        );
      }
    } else if (branch === "local") {
      lines.push(
        "\n(local branch: CLI executed delegate_request but no data was returned)",
      );
    } else if (branch === "blocked") {
      lines.push("");
      lines.push(
        typeof parsed.message === "string"
          ? parsed.message
          : JSON.stringify(parsed, null, 2),
      );
    }
    return lines.join("\n");
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function guidanceForMissingPlatformKey(
  serviceId: string,
  upstreamMessage: string,
): string {
  const lines = [
    `MISSING_PLATFORM_KEY (${serviceId})`,
    upstreamMessage ? `Detail: ${upstreamMessage}` : "",
    "",
    "The user asked to query this service, but the required credential is missing on the Aegis platform.",
    "",
    "Surface this to the user before falling back to substitute tools.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

function toolSuccessContent(
  serviceId: string,
  rawResponse: unknown,
): { content: { type: "text"; text: string }[] } {
  const payload = (rawResponse as { data?: unknown })?.data ?? rawResponse;
  const text = extractToolResult(serviceId, payload);
  return { content: [{ type: "text", text }] };
}

// ─── aegis-omni-tool ─────────────────────────────────────────────────
//
// The proxy returns one of three branches:
//   - "platform"  → upstream call already executed on the proxy.
//   - "local"     → proxy chose user-key delegation; it returned a
//                   `delegate_request` we now run with vault secrets.
//   - "blocked"   → no key available anywhere; bubble the message up.
async function runAegisOmniCatalogInvocation(
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const ui = args.user_intent;
  if (typeof ui !== "string" || !ui.trim()) {
    return {
      content: [
        {
          type: "text",
          text: "aegis-omni-tool requires `user_intent` (non-empty string).",
        },
      ],
      isError: true,
    };
  }

  // Standardize hints: strip *_API_KEY / *_SECRET / *_TOKEN / *_KEY suffixes
  // so the proxy can do a plain prefix match against manifest required_secrets.
  const vaultHints = listProviderHintsFromVault();
  const rawExtra = args.key_hints;
  const extra = Array.isArray(rawExtra)
    ? rawExtra.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      )
    : [];
  const key_hints = [
    ...new Set([
      ...vaultHints,
      ...extra.map((h) =>
        h
          .trim()
          .toUpperCase()
          .replace(/_API_KEY$/, "")
          .replace(/_SECRET$/, "")
          .replace(/_TOKEN$/, "")
          .replace(/_KEY$/, ""),
      ),
    ]),
  ].filter((h) => h.length > 0);

  const requestBody: Record<string, unknown> = { ...args, key_hints };

  try {
    const raw = await executeAegisRequest(
      "aegis-omni-tool",
      requestBody,
      undefined,
      undefined,
    );
    const top = raw as Record<string, unknown>;
    const payload = (top.data !== undefined ? top.data : top) as Record<
      string,
      unknown
    >;

    const branch = payload.type;

    if (branch === "local") {
      const required = Array.isArray(payload.required_secrets)
        ? (payload.required_secrets.filter(
            (x: unknown): x is string => typeof x === "string",
          ) as string[])
        : [];
      console.error(
        "[Hub] 🏃 Local Delegation received for provider:",
        payload.provider_id,
      );
      console.error("[Hub] 🔑 Secrets required by Proxy:", required.join(", "));
      const dr = payload.delegate_request as
        | {
            method?: unknown;
            url?: unknown;
            headers?: unknown;
            body?: unknown;
          }
        | undefined;
      if (
        !dr ||
        typeof dr.url !== "string" ||
        typeof dr.method !== "string" ||
        typeof dr.headers !== "object" ||
        dr.headers === null ||
        Array.isArray(dr.headers)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Omni-tool local branch returned invalid delegate_request.",
            },
          ],
          isError: true,
        };
      }

      console.error(
        `[Hub-Debug] Available Local Env Keys: ${Object.keys(process.env)
          .filter((k) => k.includes("KEY"))
          .join(", ")}`,
      );
      console.error(`[Hub-Debug] Pre-Injection URL: ${dr.url}`);

      const missing = required.filter((s) => resolveVaultSecret(s) == null);
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                "OMNI_LOCAL_VAULT_MISS",
                "",
                `The proxy chose Local execution because your hints matched ${missing.join(", ")}, but the vault does not actually contain those values.`,
                "",
                formatUserInstructionsForSecrets(missing),
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }

      const injected = injectSecretsIntoCompiled(
        {
          url: dr.url,
          method: String(dr.method).toUpperCase(),
          headers: dr.headers as Record<string, string>,
          body: dr.body,
        },
        required,
      );
      cleanupCompiledRequestPlaceholders(injected);

      const methodUpper = injected.method.toUpperCase();
      const init: RequestInit = {
        method: injected.method,
        headers: injected.headers,
        signal: AbortSignal.timeout(60_000),
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
      const finalUrl = injected.url;
      const finalHeaders = injected.headers as Record<string, string>;
      console.error("[Hub] 📡 Executing final fetch to:", finalUrl);
      console.error("[Hub] 🛡️ Headers:", JSON.stringify(finalHeaders));
      let fetchResponse: Response;
      try {
        fetchResponse = await fetch(injected.url, init);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Hub] Fetch failed (network):", e);
        return {
          content: [
            {
              type: "text",
              text: `Local omni fetch network error: ${msg}`,
            },
          ],
          isError: true,
        };
      }
      console.error(
        `[Hub] ✅ Response Received: ${fetchResponse.status} ${fetchResponse.statusText}`,
      );
      const text = await fetchResponse.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw */
      }
      if (!fetchResponse.ok) {
        const snippet = typeof data === "string" ? data : JSON.stringify(data);
        return {
          content: [
            {
              type: "text",
              text: `Local omni fetch failed (${fetchResponse.status}): ${snippet.slice(0, 1200)}`,
            },
          ],
          isError: true,
        };
      }
      const enriched: Record<string, unknown> = {
        ...payload,
        upstream_data: data,
      };
      return toolSuccessContent("aegis-omni-tool", enriched);
    }

    if (branch === "blocked") {
      const required = Array.isArray(payload.required_secrets)
        ? (payload.required_secrets.filter(
            (x: unknown): x is string => typeof x === "string",
          ) as string[])
        : [];
      const message =
        typeof payload.message === "string"
          ? payload.message
          : "OMNI_KEY_REQUIRED";
      return {
        content: [
          {
            type: "text",
            text: [
              message,
              "",
              required.length > 0
                ? formatUserInstructionsForSecrets(required)
                : "",
            ]
              .filter((l) => l !== "")
              .join("\n"),
          },
        ],
        isError: true,
      };
    }

    // type === "platform" or any unrecognized shape
    return toolSuccessContent("aegis-omni-tool", raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const routed = parseRouterExecuteError(msg);
    if (routed?.httpStatus === 410) {
      return {
        content: [
          {
            type: "text",
            text: `OMNI_DEPRECATED: ${typeof routed.body.message === "string" ? routed.body.message : msg}`,
          },
        ],
        isError: true,
      };
    }
    if (routed?.httpStatus === 401 && routed.body.error === "AUTH_REQUIRED") {
      return formatAuthRequiredResult(routed.body);
    }
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
}

/**
 * Translate an AUTH_REQUIRED 401 body into both:
 *   1. A human-readable text block for the LLM (so it can explain
 *      what the user needs to do, instead of looping on the failed
 *      tool call).
 *   2. A structured event on the in-process ring so the dashboard
 *      can render the Golden Path modal.
 */
function formatAuthRequiredResult(body: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const provider =
    typeof body.provider === "string" ? body.provider : "unknown";
  const requiredSecrets = Array.isArray(body.required_secrets)
    ? body.required_secrets.filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const authType =
    body.auth_type === "PAT" ||
    body.auth_type === "OAUTH_PKCE" ||
    body.auth_type === "API_KEY"
      ? body.auth_type
      : "API_KEY";
  const goldenPath =
    typeof body.golden_path_url === "string" && body.golden_path_url.length > 0
      ? body.golden_path_url
      : null;
  const instructions = Array.isArray(body.instructions)
    ? body.instructions.filter((s): s is string => typeof s === "string")
    : [];
  const message =
    typeof body.message === "string"
      ? body.message
      : `AUTH_REQUIRED: provider "${provider}" needs a credential.`;

  pushAuthRequired({
    provider,
    required_secrets: requiredSecrets,
    auth_type: authType,
    golden_path_url: goldenPath,
    instructions,
    message,
  });

  const lines: string[] = [
    "AUTH_REQUIRED",
    "",
    message,
    "",
    `Provider: ${provider}`,
    `Auth type: ${authType}`,
  ];
  if (goldenPath) {
    lines.push(`Golden Path URL: ${goldenPath}`);
  }
  if (instructions.length > 0) {
    lines.push("");
    lines.push("Steps:");
    instructions.forEach((step, idx) => {
      lines.push(`  ${idx + 1}. ${step}`);
    });
  }
  if (requiredSecrets.length > 0) {
    lines.push("");
    lines.push(formatUserInstructionsForSecrets(requiredSecrets));
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
}

// ─── aegis-search / aegis-parse ─────────────────────────────────────
//
// Dumb proxies for `/v1/execute`. The router debits, signs, forwards;
// we just unwrap the response into MCP's text-only content shape.
async function runDirectProxyTool(
  name: "aegis-search" | "aegis-parse",
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const raw = await executeAegisRequest(name, args, undefined, undefined);
    return toolSuccessContent(name, raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const routed = parseRouterExecuteError(msg);
    if (
      routed?.httpStatus === 401 &&
      routed.body.error === "MISSING_PLATFORM_KEY"
    ) {
      const upstream =
        typeof routed.body.message === "string" ? routed.body.message : "";
      return {
        content: [
          {
            type: "text",
            text: guidanceForMissingPlatformKey(name, upstream),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
}

export async function runCatalogToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (name === "aegis-omni-tool") {
    return runAegisOmniCatalogInvocation(args);
  }
  if (name === "aegis-search" || name === "aegis-parse") {
    return runDirectProxyTool(name, args);
  }
  // Defensive: mcp-server.ts already short-circuits non-Core names, but
  // keep an explicit guard so this function has no implicit fallthrough.
  return {
    content: [
      {
        type: "text",
        text: `Unknown Aegis service: ${name}. The CLI only dispatches aegis-omni-tool, aegis-search, aegis-parse.`,
      },
    ],
    isError: true,
  };
}
