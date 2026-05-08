import {
  connect,
  JSONCodec,
  type NatsConnection,
  type Subscription,
  type Msg,
} from "nats";
import { AEGIS_ROUTER_BASE } from "../config.js";
import { userAccount } from "../crypto/identity.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";
import { resolveVaultSecret } from "../crypto/vault.js";
import {
  cleanupCompiledRequestPlaceholders,
  injectSecretsIntoCompiled,
} from "../executor/preflight.js";
import {
  loadRelayConfig,
  type RelayNodeConfig,
} from "./config.js";

// ════════════════════════════════════════════════════════════════════
//  Relay Listener — daemon-side NATS subscriber + executor
// ════════════════════════════════════════════════════════════════════
//
// Subscribes to `aegis.relay.v1.req.<provider_slug>.<wallet>` for each
// node configured in `~/.aegis/relay.json`. Handles two ops:
//
//   ack     — quick liveness reply so the Router can race candidates.
//   execute — substitute vault secrets into the supplied template,
//             fetch upstream, and reply with the response.
//
// Heartbeats are published every 15s on `aegis.relay.v1.health.<wallet>`
// with the Router-issued connect token so the Router can verify the
// publisher actually owns this wallet.

const HEARTBEAT_INTERVAL_MS = 15_000;
const TOKEN_REFRESH_LEAD_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 5_000;

const jc = JSONCodec();

interface ConnectResponse {
  ok: boolean;
  nats_url: string;
  bus_connected: boolean;
  wallet: string;
  token: string;
  expires_at_ms: number;
  subjects?: Record<string, string>;
}

interface ListenerState {
  nc: NatsConnection | null;
  subs: Map<string, Subscription>;
  heartbeatTimer: NodeJS.Timeout | null;
  refreshTimer: NodeJS.Timeout | null;
  token: string | null;
  expiresAtMs: number;
  shuttingDown: boolean;
  configRev: number;
}

const state: ListenerState = {
  nc: null,
  subs: new Map(),
  heartbeatTimer: null,
  refreshTimer: null,
  token: null,
  expiresAtMs: 0,
  shuttingDown: false,
  configRev: 0,
};

function relaySubject(slug: string, wallet: string): string {
  return `aegis.relay.v1.req.${slug}.${wallet}`;
}

function healthSubject(wallet: string): string {
  return `aegis.relay.v1.health.${wallet}`;
}

async function fetchConnectToken(): Promise<ConnectResponse> {
  const headers = await signAegisRequestHeaders(userAccount);
  const r = await fetch(`${AEGIS_ROUTER_BASE}/v1/relay/connect`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Router /v1/relay/connect ${r.status}: ${text.slice(0, 400)}`);
  }
  return (await r.json()) as ConnectResponse;
}

async function publishRelayNodeToRouter(
  node: RelayNodeConfig,
): Promise<void> {
  const headers = await signAegisRequestHeaders(userAccount);
  const r = await fetch(`${AEGIS_ROUTER_BASE}/v1/relay/nodes`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider_slug: node.provider_slug,
      fee_per_call: node.fee_per_call,
      rate_limit_max: node.rate_limit_max,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `Router /v1/relay/nodes ${r.status}: ${text.slice(0, 400)}`,
    );
  }
}

// ─── Phase A / Phase B handlers ──────────────────────────────────────

interface DelegateRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface ExecuteEnvelope {
  op: string;
  request_id?: string;
  delegate_request?: DelegateRequest;
  required_secrets?: string[];
}

async function handleAck(msg: Msg, _node: RelayNodeConfig): Promise<void> {
  // Optimistic; we report available even if the vault is missing the
  // key — the Router will figure it out at execute time. This keeps
  // ack latency tiny (which is the whole point of Phase A).
  msg.respond(
    jc.encode({
      available: true,
      wallet: userAccount.address,
      // No EMA on the daemon side; the Router maintains its own.
      est_latency_ms: 100,
    }),
  );
}

async function handleExecute(
  msg: Msg,
  node: RelayNodeConfig,
  envelope: ExecuteEnvelope,
): Promise<void> {
  const dr = envelope.delegate_request;
  const required = Array.isArray(envelope.required_secrets)
    ? envelope.required_secrets.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : [];

  if (
    !dr ||
    typeof dr.method !== "string" ||
    typeof dr.url !== "string" ||
    typeof dr.headers !== "object" ||
    dr.headers === null
  ) {
    msg.respond(
      jc.encode({
        ok: false,
        reason: "INVALID_DELEGATE_REQUEST",
        message: "Delegate request missing method/url/headers.",
      }),
    );
    return;
  }

  // Sanity: the caller's required_secrets must include something we
  // recognise locally. Resolution will throw if any is missing.
  for (const name of required) {
    if (resolveVaultSecret(name) === null) {
      msg.respond(
        jc.encode({
          ok: false,
          reason: "VAULT_MISS",
          message: `Vault has no value for required secret "${name}".`,
        }),
      );
      return;
    }
  }
  // Always include the user's declared vault key for this slug — it's
  // valid for the proxy to pass an empty `required_secrets` if the
  // template encodes the secret name in a placeholder we already know
  // about.
  const merged = Array.from(new Set([...required, node.vault_key_name]));

  let injected;
  try {
    injected = injectSecretsIntoCompiled(
      {
        url: dr.url,
        method: dr.method.toUpperCase(),
        headers: { ...dr.headers },
        body: dr.body,
      },
      merged,
    );
  } catch (err) {
    msg.respond(
      jc.encode({
        ok: false,
        reason: "VAULT_MISS",
        message: err instanceof Error ? err.message : "vault resolution failed",
      }),
    );
    return;
  }
  cleanupCompiledRequestPlaceholders(injected);

  const methodUpper = injected.method.toUpperCase();
  const init: RequestInit = {
    method: injected.method,
    headers: injected.headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  const mayHaveBody = methodUpper !== "GET" && methodUpper !== "HEAD";
  if (mayHaveBody && injected.body !== undefined && injected.body !== null) {
    init.body =
      typeof injected.body === "string"
        ? injected.body
        : JSON.stringify(injected.body);
  }

  const startMs = Date.now();
  console.error(
    `[Relay] Executing op:execute slug=${node.provider_slug} url=${injected.url}`,
  );
  let resp: Response;
  try {
    resp = await fetch(injected.url, init);
  } catch (err) {
    msg.respond(
      jc.encode({
        ok: false,
        reason: "FETCH_FAILED",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text body
  }
  const exec_ms = Date.now() - startMs;

  const safeHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") return;
    safeHeaders[k] = v;
  });

  msg.respond(
    jc.encode({
      ok: true,
      status: resp.status,
      headers: safeHeaders,
      body,
      exec_ms,
    }),
  );
}

async function dispatchSubscriptionMessage(
  m: Msg,
  node: RelayNodeConfig,
): Promise<void> {
  let envelope: ExecuteEnvelope;
  try {
    envelope = jc.decode(m.data) as ExecuteEnvelope;
  } catch {
    if (m.reply) {
      m.respond(
        jc.encode({ ok: false, reason: "BAD_PAYLOAD", message: "non-JSON" }),
      );
    }
    return;
  }

  switch (envelope.op) {
    case "ack":
      await handleAck(m, node);
      break;
    case "execute":
      await handleExecute(m, node, envelope);
      break;
    default:
      if (m.reply) {
        m.respond(
          jc.encode({
            ok: false,
            reason: "UNKNOWN_OP",
            message: `Unsupported op: ${String(envelope.op)}`,
          }),
        );
      }
  }
}

async function subscribeNode(
  nc: NatsConnection,
  node: RelayNodeConfig,
): Promise<void> {
  const subj = relaySubject(node.provider_slug, userAccount.address);
  if (state.subs.has(subj)) return;
  const sub = nc.subscribe(subj);
  state.subs.set(subj, sub);
  console.error(`[Relay] Subscribed: ${subj}`);
  (async () => {
    for await (const m of sub) {
      try {
        await dispatchSubscriptionMessage(m, node);
      } catch (err) {
        console.error(`[Relay] Handler error on ${subj}:`, err);
        if (m.reply) {
          try {
            m.respond(
              jc.encode({
                ok: false,
                reason: "HANDLER_ERROR",
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          } catch {
            // best-effort
          }
        }
      }
    }
  })().catch((err) => {
    console.warn(`[Relay] Subscription loop ended on ${subj}:`, err);
    state.subs.delete(subj);
  });
}

function startHeartbeat(): void {
  if (state.heartbeatTimer) return;
  state.heartbeatTimer = setInterval(() => {
    if (!state.nc || !state.token) return;
    try {
      state.nc.publish(
        healthSubject(userAccount.address),
        jc.encode({
          token: state.token,
          ts: Date.now(),
        }),
      );
    } catch (err) {
      console.warn("[Relay] heartbeat publish failed:", err);
    }
  }, HEARTBEAT_INTERVAL_MS);
  state.heartbeatTimer.unref?.();
}

function startTokenRefresh(): void {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  const lead = Math.max(state.expiresAtMs - Date.now() - TOKEN_REFRESH_LEAD_MS, 60_000);
  state.refreshTimer = setTimeout(() => {
    refreshConnectToken().catch((err) => {
      console.warn("[Relay] token refresh failed:", err);
    });
  }, lead);
  state.refreshTimer.unref?.();
}

async function refreshConnectToken(): Promise<void> {
  if (state.shuttingDown) return;
  try {
    const cr = await fetchConnectToken();
    state.token = cr.token;
    state.expiresAtMs = cr.expires_at_ms;
    console.error(
      `[Relay] Refreshed connect token (expires ${new Date(cr.expires_at_ms).toISOString()})`,
    );
    startTokenRefresh();
  } catch (err) {
    console.warn("[Relay] refresh failed; retrying in 60s:", err);
    state.refreshTimer = setTimeout(() => {
      void refreshConnectToken();
    }, 60_000);
    state.refreshTimer.unref?.();
  }
}

function stopBackgroundTimers(): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Boot the relay listener. No-op when:
 *   - relay.json has no nodes
 *   - the Router rejects the wallet handshake (e.g. NATS not configured)
 *   - the NATS server is unreachable
 *
 * Returns true when at least one subscription is live.
 */
export async function startRelayListener(): Promise<boolean> {
  if (state.nc) {
    return state.subs.size > 0;
  }

  const cfg = loadRelayConfig();
  if (cfg.nodes.length === 0) {
    return false;
  }

  console.error(
    `[Relay] Booting listener for ${cfg.nodes.length} node(s) under wallet ${userAccount.address}`,
  );

  let cr: ConnectResponse;
  try {
    cr = await fetchConnectToken();
  } catch (err) {
    console.warn(
      "[Relay] /v1/relay/connect failed; relay listener disabled:",
      err,
    );
    scheduleReconnect();
    return false;
  }

  state.token = cr.token;
  state.expiresAtMs = cr.expires_at_ms;

  let nc: NatsConnection;
  try {
    nc = await connect({
      servers: cr.nats_url,
      name: `aegis-daemon-${userAccount.address}`,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2_000,
    });
  } catch (err) {
    console.warn(
      `[Relay] NATS connect failed at ${cr.nats_url}; relay listener disabled:`,
      err,
    );
    scheduleReconnect();
    return false;
  }
  state.nc = nc;
  console.error(`[Relay] Connected to NATS at ${cr.nats_url}`);

  // Register every configured node with the Router (idempotent upsert).
  for (const node of cfg.nodes) {
    try {
      await publishRelayNodeToRouter(node);
    } catch (err) {
      console.warn(
        `[Relay] /v1/relay/nodes upsert for ${node.provider_slug} failed:`,
        err,
      );
    }
  }

  for (const node of cfg.nodes) {
    await subscribeNode(nc, node);
  }

  startHeartbeat();
  startTokenRefresh();

  // Send an immediate heartbeat so the Router flips us to status=online
  // straight away rather than waiting up to HEARTBEAT_INTERVAL_MS.
  try {
    nc.publish(
      healthSubject(userAccount.address),
      jc.encode({ token: state.token, ts: Date.now() }),
    );
  } catch (err) {
    console.warn("[Relay] initial heartbeat failed:", err);
  }

  nc.closed().then(async (err) => {
    console.warn("[Relay] NATS connection closed:", err ?? "(graceful)");
    stopBackgroundTimers();
    state.nc = null;
    state.subs.clear();
    if (!state.shuttingDown) scheduleReconnect();
  });

  return true;
}

let reconnectTimer: NodeJS.Timeout | null = null;
function scheduleReconnect(): void {
  if (reconnectTimer || state.shuttingDown) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await startRelayListener();
    } catch (err) {
      console.warn("[Relay] reconnect attempt failed:", err);
      scheduleReconnect();
    }
  }, RECONNECT_BACKOFF_MS);
  reconnectTimer.unref?.();
}

/** Re-read relay.json and reconcile subscriptions / Router rows. */
export async function reloadRelayListener(): Promise<void> {
  state.configRev++;
  if (!state.nc) {
    await startRelayListener();
    return;
  }
  const cfg = loadRelayConfig();
  const desired = new Set(
    cfg.nodes.map((n) => relaySubject(n.provider_slug, userAccount.address)),
  );
  // Drop subs that are no longer desired.
  for (const [subj, sub] of state.subs) {
    if (!desired.has(subj)) {
      try {
        await sub.drain();
      } catch {
        sub.unsubscribe();
      }
      state.subs.delete(subj);
      console.error(`[Relay] Unsubscribed: ${subj}`);
    }
  }
  // Add new ones.
  for (const node of cfg.nodes) {
    try {
      await publishRelayNodeToRouter(node);
    } catch (err) {
      console.warn(
        `[Relay] reload upsert for ${node.provider_slug} failed:`,
        err,
      );
    }
    await subscribeNode(state.nc, node);
  }
}

export async function stopRelayListener(): Promise<void> {
  state.shuttingDown = true;
  stopBackgroundTimers();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (state.nc) {
    try {
      await state.nc.drain();
    } catch (err) {
      console.warn("[Relay] drain failed:", err);
    }
    state.nc = null;
    state.subs.clear();
  }
}

export function getRelayListenerStatus(): {
  connected: boolean;
  subscriptions: string[];
  token_expires_at_ms: number | null;
  wallet: string;
} {
  return {
    connected: state.nc !== null,
    subscriptions: [...state.subs.keys()],
    token_expires_at_ms: state.expiresAtMs > 0 ? state.expiresAtMs : null,
    wallet: userAccount.address,
  };
}
