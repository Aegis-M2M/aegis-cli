import cors from "cors";
import express from "express";
import { randomUUID } from "crypto";
import { getDomain } from "tldts";
import {
  DASHBOARD_HTML,
  DASHBOARD_TRANSIT_WALLET_MARKER,
} from "../dashboard.js";
import {
  AEGIS_BALANCE_ENDPOINT,
  AEGIS_ROUTER_BASE,
  SERVICE_ID_RE,
} from "../config.js";
import { checkAndSweepFunds } from "../crypto/economy.js";
import { userAccount } from "../crypto/identity.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";
import {
  createSessionMcpServer,
  sseSessions,
  SSEServerTransport,
} from "./mcp-server.js";
import {
  executeAegisRequest,
  executeAegisStream,
  parseRouterExecuteError,
} from "../executor/router-client.js";
import {
  getRelayListenerStatus,
  reloadRelayListener,
  startRelayListener,
} from "../relay/listener.js";
import { startOAuthRefresher } from "../crypto/oauth-refresher.js";
import {
  loadRelayConfig,
  removeRelayNodeConfig,
  upsertRelayNodeConfig,
} from "../relay/config.js";
import {
  deleteVaultKey,
  getSecret,
  getVaultMetadata,
  listVaultSummary,
  setVaultEntry,
  VAULT_KEY_NAME_RE,
  type OAuthRefreshBlock,
  type SecretType,
  type VaultEntry,
} from "../crypto/vault.js";
import { nameLooksSensitive } from "../relay/firewall.js";
import { listAuthRequired } from "./auth-events.js";
import {
  applyOverride,
  deleteAuthOverride,
  mergeListWithOverrides,
  setAuthOverride,
  type AuthInstructionsView,
  type AuthOverridePatch,
} from "./auth-overrides.js";
import { browserManager } from "../browser/browser-manager.js";

const ROUTER_FETCH_TIMEOUT_MS = 12_000;
const AUTH_METADATA_FETCH_TIMEOUT_MS = 6_000;
const AUTH_METADATA_CACHE_TTL_MS = 60_000;

function normalizeRelayDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const parsed = getDomain(raw, { allowPrivateDomains: true });
  if (parsed) return parsed.toLowerCase();
  try {
    return getDomain(new URL(raw).href, { allowPrivateDomains: true })?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function slugFromRelayDomain(domain: string): string {
  return `${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 56)}-domain`;
}

// ─── Auth metadata passthrough cache ────────────────────────────────
//
// The proxy owns the authorize_instructions table; the router fronts
// it at /v1/auth. Both endpoints are read-only and tolerate the proxy
// being offline (we degrade to a 503 + cached fallback).

interface AuthInstructionsBody {
  provider: string;
  auth_type: "PAT" | "OAUTH_PKCE" | "API_KEY";
  authorize_url_template: string;
  instructions: string[];
  manifest?: Record<string, unknown>;
  last_verified?: string;
}

interface SupportedProvidersBody {
  providers: AuthInstructionsBody[];
}

const supportedProvidersCache: { at: number; body: SupportedProvidersBody | null } =
  { at: 0, body: null };

const instructionsCache = new Map<
  string,
  { at: number; body: AuthInstructionsBody | null }
>();

async function fetchSupportedProviders(): Promise<SupportedProvidersBody | null> {
  const now = Date.now();
  if (supportedProvidersCache.body && now - supportedProvidersCache.at < AUTH_METADATA_CACHE_TTL_MS) {
    return supportedProvidersCache.body;
  }
  try {
    const r = await fetch(`${AEGIS_ROUTER_BASE}/v1/auth/supported-providers`, {
      signal: AbortSignal.timeout(AUTH_METADATA_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return supportedProvidersCache.body;
    const body = (await r.json()) as SupportedProvidersBody;
    supportedProvidersCache.at = now;
    supportedProvidersCache.body = body;
    return body;
  } catch {
    return supportedProvidersCache.body;
  }
}

async function fetchInstructions(
  provider: string,
): Promise<AuthInstructionsBody | null> {
  const now = Date.now();
  const cached = instructionsCache.get(provider);
  if (cached && now - cached.at < AUTH_METADATA_CACHE_TTL_MS) {
    return cached.body;
  }
  try {
    const r = await fetch(
      `${AEGIS_ROUTER_BASE}/v1/auth/instructions/${encodeURIComponent(provider)}`,
      { signal: AbortSignal.timeout(AUTH_METADATA_FETCH_TIMEOUT_MS) },
    );
    if (!r.ok) {
      instructionsCache.set(provider, { at: now, body: null });
      return null;
    }
    const body = (await r.json()) as AuthInstructionsBody;
    instructionsCache.set(provider, { at: now, body });
    return body;
  } catch {
    return cached?.body ?? null;
  }
}

/** Strip credential-style suffixes off a vault key to derive a provider hint. */
function vaultKeyToProviderId(key: string): string {
  return key
    .toUpperCase()
    .replace(/_(API_KEY|API|KEY|SECRET|TOKEN|PAT|OAUTH)$/i, "")
    .toLowerCase();
}

function inferLocalSecretType(name: string): SecretType {
  const upper = name.toUpperCase();
  if (upper.includes("OAUTH")) return "oauth";
  if (upper.endsWith("_TOKEN") || upper.endsWith("_PAT")) return "pat";
  return "api_key";
}

/**
 * Decide the persisted Vault 2.0 entry for a PUT /api/vault/:key
 * request. The CRITICAL_SECURITY_DIRECTIVE in the spec is that PAT
 * and OAUTH types are hardcoded `shareable: false`, with no UI toggle
 * able to override.
 *
 * Source-of-truth precedence (most authoritative first):
 *   1. Proxy `authorize_instructions.auth_type` for the inferred
 *      provider. This is the AuthResearcher's verdict.
 *   2. Substring match against the egress blocklist (GITHUB / GOOGLE
 *      / PAT / OAUTH) — even unrecognised providers must be quarantined.
 *   3. Local heuristics on the key name (`_TOKEN` → pat, etc).
 *
 * For OAuth entries, an optional `refresh` block in the request body
 * is validated and persisted alongside the access token. The
 * background refresher then keeps `value` alive past the IdP's
 * 1-hour expiry.
 */
async function decideVaultEntry(
  key: string,
  value: string,
  bodyShareable: unknown,
  bodyRefresh: unknown,
): Promise<VaultEntry> {
  const providerId = vaultKeyToProviderId(key);
  const remote = providerId
    ? await fetchInstructions(providerId).catch(() => null)
    : null;

  let type: SecretType;
  if (remote?.auth_type === "PAT") type = "pat";
  else if (remote?.auth_type === "OAUTH_PKCE") type = "oauth";
  else type = inferLocalSecretType(key);

  const sensitiveType = type === "pat" || type === "oauth";
  const sensitiveName = nameLooksSensitive(key);

  // Hard-code: PAT/OAUTH or blocklisted names are NEVER shareable.
  const shareable =
    sensitiveType || sensitiveName ? false : bodyShareable === true;

  const refresh =
    type === "oauth" ? coerceRefreshBlock(bodyRefresh) : undefined;

  return { value, type, shareable, refresh };
}

/**
 * Validate and shape an inbound OAuth refresh block. Reject silently
 * (return undefined) when required fields are missing — the user can
 * still save the access token, but the background refresher won't
 * touch it.
 */
function coerceRefreshBlock(input: unknown): OAuthRefreshBlock | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const o = input as Record<string, unknown>;
  const refresh_token =
    typeof o.refresh_token === "string" ? o.refresh_token.trim() : "";
  const token_url =
    typeof o.token_url === "string" ? o.token_url.trim() : "";
  const client_id =
    typeof o.client_id === "string" ? o.client_id.trim() : "";
  if (!refresh_token || !token_url || !client_id) return undefined;
  // Basic URL sanity — reject obviously invalid token endpoints so a
  // typo doesn't quietly disable the refresher.
  try {
    const u = new URL(token_url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  const block: OAuthRefreshBlock = {
    refresh_token,
    token_url,
    client_id,
  };
  if (typeof o.client_secret === "string" && o.client_secret.length > 0) {
    block.client_secret = o.client_secret;
  }
  if (typeof o.expires_at_ms === "number" && Number.isFinite(o.expires_at_ms)) {
    block.expires_at_ms = o.expires_at_ms;
  } else if (typeof o.expires_in === "number" && Number.isFinite(o.expires_in)) {
    block.expires_at_ms = Date.now() + o.expires_in * 1000;
  }
  return block;
}

function finiteNumberFromUnknown(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Same scale as router `CREDITS_PER_USDC` / dashboard `CREDITS_PER_USD`. */
const CREDITS_PER_USD_API = 10_000;

export function createExpressApp(): express.Express {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  app.get("/", (_req, res) => {
    res
      .type("html")
      .send(
        DASHBOARD_HTML.replaceAll(
          DASHBOARD_TRANSIT_WALLET_MARKER,
          userAccount.address,
        ),
      );
  });

  // ─── Vault (secrets never listed in GET — dashboard edits via PUT/DELETE)
  app.get("/api/vault", (_req, res) => {
    try {
      res.json({ entries: listVaultSummary() });
    } catch (e) {
      console.error("[Vault API] GET /api/vault:", e);
      res.status(500).json({ error: "VAULT_READ_FAILED" });
    }
  });

  app.put("/api/vault/:key", async (req, res) => {
    const rawKey =
      typeof req.params.key === "string"
        ? decodeURIComponent(req.params.key)
        : "";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const value = body.value;

    if (!VAULT_KEY_NAME_RE.test(rawKey)) {
      return res.status(400).json({
        error: "INVALID_KEY_NAME",
        message:
          "Key must match /^[A-Za-z_][A-Za-z0-9_]{0,127}$/ (e.g. NEWSAPI_API_KEY).",
      });
    }
    if (typeof value !== "string") {
      return res.status(400).json({
        error: "INVALID_BODY",
        message: 'JSON body must include string "value".',
      });
    }
    const trimmed = value.trim();
    if (!trimmed.length) {
      return res.status(400).json({
        error: "EMPTY_VALUE",
        message: "Secret value cannot be empty. Use DELETE to remove a key.",
      });
    }

    try {
      const entry = await decideVaultEntry(
        rawKey,
        trimmed,
        body.shareable,
        body.refresh,
      );
      setVaultEntry(rawKey, entry);
      res.json({
        ok: true,
        key: rawKey,
        has_value: true,
        type: entry.type,
        shareable: entry.shareable,
        has_refresh: !!entry.refresh,
        expires_at_ms: entry.refresh?.expires_at_ms ?? null,
      });
    } catch (e) {
      console.error("[Vault API] PUT /api/vault/:key:", e);
      res.status(500).json({ error: "VAULT_WRITE_FAILED" });
    }
  });

  app.delete("/api/vault/:key", (req, res) => {
    const rawKey =
      typeof req.params.key === "string"
        ? decodeURIComponent(req.params.key)
        : "";
    if (
      typeof rawKey !== "string" ||
      rawKey.length === 0 ||
      rawKey.length > 128
    ) {
      return res.status(400).json({ error: "INVALID_KEY_NAME" });
    }
    try {
      const existed = deleteVaultKey(rawKey);
      res.json({ ok: true, removed: existed });
    } catch (e) {
      console.error("[Vault API] DELETE /api/vault/:key:", e);
      res.status(500).json({ error: "VAULT_WRITE_FAILED" });
    }
  });

  // ─── Golden Path metadata (cached passthrough to router → proxy,
  //     overlaid with the user's local overrides).
  app.get("/api/auth/supported-providers", async (_req, res) => {
    const body = await fetchSupportedProviders();
    const upstream = body && Array.isArray(body.providers) ? body.providers : [];
    const merged = mergeListWithOverrides(upstream as AuthInstructionsView[]);
    if (!body && merged.length === 0) {
      return res.status(503).json({
        error: "AUTH_METADATA_UNAVAILABLE",
        message:
          "Could not reach the Aegis router for auth metadata. Try again in a moment.",
      });
    }
    res.json({ providers: merged });
  });

  app.get("/api/auth/instructions/:provider", async (req, res) => {
    const provider =
      typeof req.params.provider === "string"
        ? req.params.provider
        : "";
    if (!provider) {
      return res.status(400).json({ error: "INVALID_PROVIDER" });
    }
    const upstream = (await fetchInstructions(provider)) as
      | AuthInstructionsView
      | null;
    const merged = applyOverride(upstream, provider);
    if (!merged) {
      return res.status(404).json({ error: "NOT_FOUND", provider });
    }
    res.json(merged);
  });

  // Local overrides write surface — these never round-trip to the
  // proxy, so a misbehaving (or deprecated) global Golden Path can
  // be patched immediately on the user's own machine.
  app.put("/api/auth/instructions/:provider", (req, res) => {
    const provider =
      typeof req.params.provider === "string"
        ? req.params.provider
        : "";
    if (!provider) {
      return res.status(400).json({ error: "INVALID_PROVIDER" });
    }
    const patch = (req.body ?? {}) as AuthOverridePatch;
    try {
      const persisted = setAuthOverride(provider, patch);
      // Bust the in-memory cache so the next GET reflects the change.
      supportedProvidersCache.body = null;
      instructionsCache.delete(provider);
      res.json({ ok: true, provider, patch: persisted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: "INVALID_OVERRIDE", message });
    }
  });

  app.delete("/api/auth/instructions/:provider", (req, res) => {
    const provider =
      typeof req.params.provider === "string"
        ? req.params.provider
        : "";
    if (!provider) {
      return res.status(400).json({ error: "INVALID_PROVIDER" });
    }
    const removed = deleteAuthOverride(provider);
    supportedProvidersCache.body = null;
    instructionsCache.delete(provider);
    res.json({ ok: true, removed });
  });

  // In-process AUTH_REQUIRED event ring. The LLM tool dispatcher
  // pushes here whenever a 401 AUTH_REQUIRED comes back from the
  // router; the dashboard polls this endpoint to render the modal.
  app.get("/api/auth/recent-prompts", (req, res) => {
    const since =
      typeof req.query.since === "string" ? req.query.since : undefined;
    res.json({ events: listAuthRequired(since) });
  });

  /**
   * Wallet address + where balance is fetched — never depends on Router
   * reachability so the dashboard can always show the Transit wallet.
   */
  app.get("/api/identity", (_req, res) => {
    res.json({
      wallet: userAccount.address,
      router_url: AEGIS_ROUTER_BASE,
      balance_path_template: "/v1/balance/{wallet}",
    });
  });

  /**
   * Aggregates local wallet + Router ledger balance.
   * Upstream: GET `{AEGIS_ROUTER_URL}/v1/balance/{wallet}` (public).
   */
  app.get("/api/status", async (_req, res) => {
    const wallet = userAccount.address;
    const balanceUrl = AEGIS_BALANCE_ENDPOINT(wallet);

    try {
      const r = await fetch(balanceUrl, {
        signal: AbortSignal.timeout(ROUTER_FETCH_TIMEOUT_MS),
      });

      let body: Record<string, unknown> = {};
      try {
        body = (await r.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      if (!r.ok) {
        const msg =
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : `Router returned HTTP ${r.status}`;
        return res.json({
          wallet,
          credits: null,
          usd_value: null,
          scrapes_remaining: null,
          router_online: false,
          balance_error: msg,
          balance_url: balanceUrl,
        });
      }

      const credits = finiteNumberFromUnknown(
        body.credit_balance ?? body.credits,
      );
      let usd_value = finiteNumberFromUnknown(body.usd_value);
      if (usd_value === null && credits !== null) {
        usd_value = Number((credits / CREDITS_PER_USD_API).toFixed(4));
      }
      const scrapes_remaining = finiteNumberFromUnknown(body.scrapes_remaining);

      return res.json({
        wallet,
        credits,
        usd_value,
        scrapes_remaining,
        router_online: true,
        balance_url: balanceUrl,
        ...(credits === null
          ? {
              balance_error:
                "Router balance response did not include a usable credits field (expected numeric credits or credit_balance).",
            }
          : {}),
      });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not reach Router balance API.";
      return res.json({
        wallet,
        credits: null,
        usd_value: null,
        scrapes_remaining: null,
        router_online: false,
        balance_error: message,
        balance_url: balanceUrl,
      });
    }
  });

  app.get("/mcp/sse", async (_req, res) => {
    let transport: SSEServerTransport | undefined;
    let sessionServer: ReturnType<typeof createSessionMcpServer> | undefined;
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      sessionServer = createSessionMcpServer();
      transport = new SSEServerTransport("/mcp/messages", res);
      sseSessions.set(transport.sessionId, transport);

      res.on("close", () => {
        sseSessions.delete(transport!.sessionId);
        void sessionServer!.close().catch(() => {});
        console.error(`🔌 MCP Session ${transport!.sessionId} closed cleanly`);
      });

      await sessionServer.connect(transport);
      res.flushHeaders?.();
      console.error(`🔌 Aegis MCP Handshake: Session ${transport.sessionId}`);
    } catch (err: unknown) {
      if (transport) sseSessions.delete(transport.sessionId);
      void sessionServer?.close().catch(() => {});
      console.error("MCP SSE connect failed:", err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  /** Local SDK / tests: forward to the hub router using this daemon's Transit wallet. */
  app.post("/v1/execute", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const service = body?.service;
    const requestBody = body?.request;
    const maxCredits =
      typeof body?.maxCredits === "number" ? body.maxCredits : undefined;
    if (typeof service !== "string" || !service.trim()) {
      return res.status(400).json({
        error: "MISSING_SERVICE",
        message: "`service` (string id) is required in the request body.",
      });
    }
    if (
      requestBody === undefined ||
      requestBody === null ||
      typeof requestBody !== "object" ||
      Array.isArray(requestBody)
    ) {
      return res.status(400).json({
        error: "MISSING_REQUEST",
        message: "`request` (object) is required in the request body.",
      });
    }
    try {
      const data = await executeAegisRequest(service, requestBody, maxCredits);
      res.json(data);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const parsed = parseRouterExecuteError(e.message);
      if (parsed) {
        return res.status(parsed.httpStatus).json(parsed.body);
      }
      console.error("/v1/execute failed:", e);
      return res.status(500).json({
        error: "EXECUTOR_ERROR",
        message: e.message,
      });
    }
  });

  app.post("/v1/messages", async (req, res) => {
    const serviceId = "aegis-claude";
    try {
      const legacyModel = "claude-3-5-sonnet-20241022";
      let systemPrompt = req.body.system;
      if (Array.isArray(systemPrompt)) {
        systemPrompt = systemPrompt
          .map((b: { text?: string }) => b.text || "")
          .join("\n");
      }

      const cleanPayload: Record<string, unknown> = {
        messages: req.body.messages,
        system: systemPrompt,
        model: req.body.model,
        max_tokens: req.body.max_tokens
          ? Math.min(req.body.max_tokens, 8192)
          : 8192,
        temperature: req.body.temperature ?? 0.7,
        tools: req.body.tools,
        tool_choice: req.body.tool_choice,
        stream: req.body.stream ?? false,
      };

      res.setHeader("anthropic-version", "2023-06-01");
      if (cleanPayload.stream) {
        await executeAegisStream(serviceId, cleanPayload, res);
      } else {
        const rawResponse = await executeAegisRequest(serviceId, cleanPayload);
        const data = (rawResponse as { data?: unknown })?.data ?? rawResponse;
        const d = data as {
          id?: string;
          content?: unknown;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const anthropicFinal = {
          id: d.id || `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model: legacyModel,
          content: d.content || [],
          stop_reason: d.stop_reason || "end_turn",
          usage: {
            input_tokens: d.usage?.input_tokens || 0,
            output_tokens: d.usage?.output_tokens || 0,
          },
        };
        res.json(anthropicFinal);
      }
    } catch (err: unknown) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: { message } });
      }
    }
  });

  // ─── Relay (Branch D) ──────────────────────────────────────────────
  // HTTP surface for the dashboard to inspect or mutate relay.json opt-ins.

  app.get("/api/relay/status", (_req, res) => {
    const cfg = loadRelayConfig();
    res.json({
      ...getRelayListenerStatus(),
      configured: cfg.nodes,
    });
  });

  app.post("/api/relay/register", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vault = body.vault_key_name;
    const fee = body.fee_per_call;
    const rate = body.rate_limit_max;
    const relayType = body.relay_type === "domain" ? "domain" : "api";
    const relayDomain =
      relayType === "domain" && typeof body.relay_domain === "string"
        ? normalizeRelayDomain(body.relay_domain)
        : null;
    const slug =
      relayType === "domain" && relayDomain
        ? slugFromRelayDomain(relayDomain)
        : body.provider_slug;

    if (
      typeof slug !== "string" ||
      !SERVICE_ID_RE.test(slug) ||
      typeof vault !== "string" ||
      (relayType === "api" && vault.length === 0) ||
      (relayType === "domain" && !relayDomain) ||
      typeof fee !== "number" ||
      !Number.isInteger(fee) ||
      fee < 0 ||
      typeof rate !== "number" ||
      !Number.isInteger(rate) ||
      rate <= 0
    ) {
      return res.status(400).json({ error: "INVALID_RELAY_REGISTRATION" });
    }

    if (vault.length > 0 && !getSecret(vault)) {
      return res.status(400).json({
        error: "VAULT_MISS",
        message: `Vault has no value for key "${vault}". Add it to vault.json before registering as a relay.`,
      });
    }

    // Egress firewall: refuse to relay PAT/OAUTH entries or anything
    // whose name matches the blocklist, regardless of the user's
    // shareable toggle. Defense-in-depth — the daemon's op:execute
    // handler also enforces this in case a relay row was registered
    // before the entry was tagged.
    const meta = vault.length > 0 ? getVaultMetadata(vault) : null;
    if (!meta) {
      if (relayType === "api") {
        return res.status(400).json({
          error: "VAULT_MISS",
          message: `Vault entry "${vault}" is missing metadata; re-add it via the dashboard.`,
        });
      }
    } else {
      if (meta.type === "pat" || meta.type === "oauth") {
        return res.status(403).json({
          error: "RESTRICTED_KEY_TYPE",
          message: `Vault entry "${vault}" is type "${meta.type}" and cannot be used as a relay key.`,
        });
      }
      if (nameLooksSensitive(vault)) {
        return res.status(403).json({
          error: "RESTRICTED_KEY_NAME",
          message: `Vault key name "${vault}" matches the egress blocklist (GITHUB/GOOGLE/PAT/OAUTH) and cannot be used as a relay key.`,
        });
      }
      if (!meta.shareable) {
        return res.status(403).json({
          error: "NOT_SHAREABLE",
          message: `Vault entry "${vault}" is not marked shareable. Toggle it on in the dashboard before registering a relay.`,
        });
      }
    }

    const next = upsertRelayNodeConfig({
      provider_slug: slug.toLowerCase(),
      vault_key_name: vault,
      fee_per_call: fee,
      rate_limit_max: rate,
      relay_type: relayType,
      relay_domain: relayType === "domain" ? relayDomain ?? "" : "",
    });

    try {
      await reloadRelayListener();
    } catch (e) {
      console.warn("[Relay] reload after register failed:", e);
    }
    res.json({ ok: true, config: next });
  });

  app.delete("/api/relay/:slug", async (req, res) => {
    const slug = req.params.slug;
    if (typeof slug !== "string" || !SERVICE_ID_RE.test(slug)) {
      return res.status(400).json({ error: "INVALID_PROVIDER_SLUG" });
    }
    const next = removeRelayNodeConfig(slug);
    try {
      await reloadRelayListener();
    } catch (e) {
      console.warn("[Relay] reload after deregister failed:", e);
    }
    // Best-effort: also tell the Router so the row flips to retired.
    try {
      const headers = await signAegisRequestHeaders(userAccount);
      await fetch(
        `${AEGIS_ROUTER_BASE}/v1/relay/nodes/${encodeURIComponent(slug.toLowerCase())}`,
        { method: "DELETE", headers },
      );
    } catch (e) {
      console.warn("[Relay] router DELETE failed:", e);
    }
    res.json({ ok: true, config: next });
  });

  app.post("/mcp/messages", async (req, res) => {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "INVALID_SESSION" });
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });

  return app;
}

/** Idle USDC on the Transit Wallet becomes router credits via /v1/fund (not only on execute). */
const SWEEP_INTERVAL_MS = 10_000;

export async function startDaemonServer(port: number): Promise<void> {
  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.error(
        `🚀 Aegis Hub Engine Live on port ${port} (MCP SSE at /mcp/sse)`,
      );
      console.error(
        `💳 Transit wallet (fund on Base, USDC or ETH): ${userAccount.address}`,
      );
      resolve();
    });
  });
  void checkAndSweepFunds().catch(() => {});
  setInterval(() => {
    void checkAndSweepFunds().catch(() => {});
  }, SWEEP_INTERVAL_MS);

  // Best-effort relay listener boot. No-op when relay.json is empty
  // or NATS is unreachable; the listener internally schedules its own
  // reconnect so a temporarily-unavailable Router doesn't block daemon
  // startup.
  void startRelayListener().catch((err) => {
    console.warn("[Relay] startRelayListener crashed:", err);
  });

  // OAuth access tokens expire on the order of 1h. Start the
  // background refresher so agents don't lose access mid-task.
  startOAuthRefresher();

  // Warm the Universal Browser MCP profile on daemon boot. Failures are
  // retried once on the first browser tool call via BrowserManager auto-heal.
  void browserManager.start().catch((err) => {
    console.warn("[Browser] warm start failed:", err);
  });
}
