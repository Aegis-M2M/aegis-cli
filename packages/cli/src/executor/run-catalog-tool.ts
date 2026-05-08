import {
  formatUserInstructionsForSecrets,
  getSecret,
  listApiKeyProviderHintsFromVault,
  resolveVaultSecret,
} from "../crypto/vault.js";
import { SERVICE_ID_RE } from "../config.js";
import {
  catalogEntryNeedsHubHydration,
  hydrateHubCapabilityManifest,
  loadServices,
  tryApplyBridgeResponseFromRouterResult,
} from "../services/catalog.js";
import {
  catalogEntryHasExecutableManifest,
  executeCapabilityManifestLocal,
  executeLocalPreflight,
  sendLocalExecutorTelemetry,
  buildInjectedSecretsMap,
  injectSecretsIntoCompiled,
  cleanupCompiledRequestPlaceholders,
} from "./preflight.js";
import {
  canAttemptJitMicroBridge,
  runJitMicroBridgeAndMergeCatalog,
  stripJitKeysFromArgs,
} from "./jit-micro-bridge.js";
import {
  executeAegisRequest,
  parseRouterExecuteError,
} from "./router-client.js";

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
  if (serviceId === "aegis-composio") {
    const parsed = data as { redirectUrl?: string };
    if (
      typeof parsed?.redirectUrl === "string" &&
      parsed.redirectUrl.length > 0
    )
      return `Please login here: ${parsed.redirectUrl}`;
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

type AuthStrategy = "platform" | "user" | "hybrid";

function catalogOptionalSecretKeys(
  meta: Record<string, unknown> | undefined,
): string[] {
  if (!meta) return [];
  const opt = meta.optional_secrets;
  const legacy = meta.required_secrets;
  const a = Array.isArray(opt) ? opt : [];
  const b = Array.isArray(legacy) ? legacy : [];
  return [
    ...new Set(
      [...a, ...b].filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      ),
    ),
  ];
}

function hasAllOptionalSecrets(secretKeys: string[]): boolean {
  return secretKeys.every((k) => getSecret(k) != null);
}

function guidanceForMissingPlatformKey(
  serviceId: string,
  optionalSecretKeys: string[],
  upstreamMessage: string,
): string {
  const keys =
    optionalSecretKeys.length > 0
      ? optionalSecretKeys.join(", ")
      : "the upstream API credential(s) for this tool";
  const lines = [
    `MISSING_PLATFORM_KEY (${serviceId})`,
    upstreamMessage ? `Detail: ${upstreamMessage}` : "",
    "",
    "The user asked to query this service, but the required credential is missing: there is no platform-level key configured, and nothing was supplied from your local Aegis vault for this workspace.",
    "",
    "REQUIRED — follow in order:",
    "",
    `1. Ask the user directly whether they will add this credential (${keys}) to their Aegis vault (see “How the user adds the key” below). Wait for their answer before doing anything else.`,
    "",
    "2. Do not substitute `aegis-search`, web search, or any other tool to mimic this integration until the user has replied. Silent fallback is wrong: you must ask first.",
    "",
    "3. If and only if the user declines to add a key, or explicitly tells you to skip this API and use alternatives, you may then use tools that need no private credential (e.g. `aegis-search`) or summarize what is blocked.",
    "",
    "4. If they add the key, retry this tool call.",
    "",
    "---",
    "",
    formatUserInstructionsForSecrets(optionalSecretKeys),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

function toolSuccessContent(
  serviceId: string,
  rawResponse: unknown,
): { content: { type: "text"; text: string }[] } {
  tryApplyBridgeResponseFromRouterResult(serviceId, rawResponse);
  const payload = (rawResponse as { data?: unknown })?.data ?? rawResponse;
  const text = extractToolResult(serviceId, payload);
  return { content: [{ type: "text", text }] };
}

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
  const vaultHints = listApiKeyProviderHintsFromVault();
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
  const catalog = loadServices();
  let metaRaw = catalog[name] as Record<string, unknown> | undefined;
  let callArgs = args;

  if (!metaRaw && SERVICE_ID_RE.test(name)) {
    console.error(`[JIT] Unknown ID "${name}". Attempting Hub discovery...`);
    try {
      await hydrateHubCapabilityManifest(name);
      const refreshed = loadServices();
      metaRaw = refreshed[name] as Record<string, unknown> | undefined;
      if (metaRaw) {
        console.error(
          `[JIT] Successfully discovered and hydrated "${name}" from Hub.`,
        );
      }
    } catch (e: unknown) {
      console.warn(`[JIT] Hub discovery failed for "${name}":`, e);
    }

    if (!metaRaw && canAttemptJitMicroBridge(args)) {
      try {
        const r = await runJitMicroBridgeAndMergeCatalog({
          capabilityId: name,
          args,
        });
        console.error(
          `[JIT] Micro-Bridge materialized "${name}" from ${r.docUrl}`,
        );
        metaRaw = loadServices()[name] as Record<string, unknown> | undefined;
        callArgs = stripJitKeysFromArgs(args);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[JIT] Micro-Bridge failed for "${name}":`, e);
        return {
          content: [
            {
              type: "text",
              text: [
                `Unknown Aegis service: ${name} (hub miss).`,
                "",
                "On-demand Micro-Bridge also failed:",
                msg,
                "",
                "Pass tool args: `user_intent` plus `doc_url` (or `single_url`), or `search_query` so the CLI can run aegis-search then aegis-bridge.",
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }
    }
  }

  if (!metaRaw) {
    return {
      content: [
        {
          type: "text",
          text:
            SERVICE_ID_RE.test(name) && !canAttemptJitMicroBridge(args)
              ? `Unknown Aegis service: ${name}. For JIT onboarding, include in tool args: user_intent and (doc_url | single_url | search_query).`
              : `Unknown Aegis service: ${name}`,
        },
      ],
      isError: true,
    };
  }

  if (catalogEntryNeedsHubHydration(metaRaw)) {
    try {
      await hydrateHubCapabilityManifest(name);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (canAttemptJitMicroBridge(args)) {
        try {
          const r = await runJitMicroBridgeAndMergeCatalog({
            capabilityId: name,
            args,
          });
          console.error(
            `[JIT] Micro-Bridge hydrated stub "${name}" from ${r.docUrl}`,
          );
          callArgs = stripJitKeysFromArgs(args);
        } catch (e2: unknown) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          return {
            content: [
              {
                type: "text",
                text: [
                  `Could not load hub manifest for "${name}": ${msg}`,
                  `On-demand Micro-Bridge failed: ${msg2}`,
                ].join("\n\n"),
              },
            ],
            isError: true,
          };
        }
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Could not load hub manifest for "${name}": ${msg}`,
            },
          ],
          isError: true,
        };
      }
    }
    const refreshed = loadServices();
    metaRaw = refreshed[name] as Record<string, unknown> | undefined;
    if (!metaRaw) {
      return {
        content: [{ type: "text", text: `Unknown Aegis service: ${name}` }],
        isError: true,
      };
    }
  }

  const rawStrat = metaRaw.auth_strategy;
  const strategy: AuthStrategy =
    rawStrat === "user" || rawStrat === "hybrid" ? rawStrat : "platform";
  const hubAuthNone = metaRaw.auth_strategy === "none";

  const optionalKeys = catalogOptionalSecretKeys(metaRaw);

  if (
    strategy === "user" &&
    optionalKeys.length > 0 &&
    !hasAllOptionalSecrets(optionalKeys)
  ) {
    const missing = optionalKeys.filter((k) => getSecret(k) == null);
    return {
      content: [
        {
          type: "text",
          text: [
            "AUTH_REQUIRED — missing local secret(s)",
            "",
            "**Exact key names to add**: " + missing.join(", "),
            "(These match `optional_secrets` for this tool in your services catalog.)",
            "",
            "REQUIRED agent behavior:",
            "1. Relay the vault instructions below to the user before using substitutes.",
            "2. Do not substitute `aegis-search` until the user declines.",
            "---",
            "",
            formatUserInstructionsForSecrets(missing),
          ].join("\n"),
        },
      ],
      isError: true,
    };
  }

  const usePreflight =
    strategy === "user" ||
    (strategy === "hybrid" &&
      optionalKeys.length > 0 &&
      hasAllOptionalSecrets(optionalKeys));

  const useManifestLocal =
    catalogEntryHasExecutableManifest(metaRaw) &&
    (strategy === "user" ||
      strategy === "hybrid" ||
      hubAuthNone);

  if (useManifestLocal) {
    const manifestArgs = stripJitKeysFromArgs(callArgs);
    if (
      strategy === "user" &&
      optionalKeys.length > 0 &&
      !hasAllOptionalSecrets(optionalKeys)
    ) {
      const missing = optionalKeys.filter((k) => getSecret(k) == null);
      return {
        content: [
          {
            type: "text",
            text: [
              "AUTH_REQUIRED — missing local secret(s)",
              "",
              "**Exact key names to add**: " + missing.join(", "),
              "(These match `optional_secrets` for this tool in your services catalog.)",
              "",
              "REQUIRED agent behavior:",
              "1. Relay the vault instructions below to the user before using substitutes.",
              "2. Do not substitute `aegis-search` until the user declines.",
              "---",
              "",
              formatUserInstructionsForSecrets(missing),
            ].join("\n"),
          },
        ],
        isError: true,
      };
    }
    if (
      strategy === "hybrid" &&
      optionalKeys.length > 0 &&
      !hasAllOptionalSecrets(optionalKeys)
    ) {
      const missing = optionalKeys.filter((k) => getSecret(k) == null);
      return {
        content: [
          {
            type: "text",
            text: [
              "AUTH_REQUIRED — missing local secret(s) for hybrid manifest execution",
              "",
              "**Exact key names to add**: " + missing.join(", "),
              "---",
              "",
              formatUserInstructionsForSecrets(missing),
            ].join("\n"),
          },
        ],
        isError: true,
      };
    }

    try {
      const data = await executeCapabilityManifestLocal(
        name,
        manifestArgs,
        optionalKeys,
        metaRaw,
      );
      void sendLocalExecutorTelemetry(name);
      return toolSuccessContent(name, data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }

  if (usePreflight) {
    try {
      const data = await executeLocalPreflight(
        name,
        stripJitKeysFromArgs(callArgs) ?? {},
        optionalKeys,
      );
      void sendLocalExecutorTelemetry(name);
      return toolSuccessContent(name, data);
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
              text: guidanceForMissingPlatformKey(name, optionalKeys, upstream),
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

  const shouldLegacyInject =
    strategy === "platform" &&
    optionalKeys.length > 0 &&
    hasAllOptionalSecrets(optionalKeys);

  const injectedRecord = shouldLegacyInject
    ? buildInjectedSecretsMap(optionalKeys)
    : undefined;

  try {
    const raw = await executeAegisRequest(
      name,
      stripJitKeysFromArgs(callArgs) ?? {},
      undefined,
      injectedRecord && Object.keys(injectedRecord).length > 0
        ? injectedRecord
        : undefined,
    );
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
            text: guidanceForMissingPlatformKey(name, optionalKeys, upstream),
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
