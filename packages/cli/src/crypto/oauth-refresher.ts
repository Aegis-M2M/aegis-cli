// ════════════════════════════════════════════════════════════════════
//  OAuth Refresher — proactive access token rotation
// ════════════════════════════════════════════════════════════════════
//
// OAuth access tokens typically expire after 1 hour. Without a
// background refresher, an Aegis agent that successfully authorised
// (e.g.) Google Drive at 09:00 will fail at 10:00 mid-task with a
// confusing 401 from the upstream provider.
//
// This daemon-side loop runs every REFRESH_TICK_MS, scans every
// oauth-typed vault entry that has a refresh block, and rotates the
// access token while it still has at least REFRESH_LEAD_MS of life
// left. On invalid_grant (refresh token revoked / expired), we
// surface an AUTH_REQUIRED prompt to the dashboard so the user can
// re-authorise — and we DO NOT delete the entry, in case the user
// wants to manually paste a fresh token.
//
// Bare access tokens never traverse NATS, so this whole subsystem
// stays inside the user's host. The egress firewall already blocks
// oauth entries from being shared, so even a misbehaving relay
// candidate cannot exfiltrate them.

import { pushAuthRequired } from "../api/auth-events.js";
import {
  listOAuthEntries,
  recordOAuthRefreshError,
  rotateOAuthAccessToken,
  type OAuthRefreshBlock,
  type VaultEntry,
} from "./vault.js";

const REFRESH_TICK_MS = 60_000;
/** Refresh anything within this window of expiry (5 min). */
const REFRESH_LEAD_MS = 5 * 60_000;
const REFRESH_FETCH_TIMEOUT_MS = 15_000;

interface RefreshSuccess {
  ok: true;
  access_token: string;
  expires_at_ms: number | null;
  refresh_token?: string;
}

interface RefreshFailure {
  ok: false;
  reason: string;
  message: string;
  /** Set when the IdP says the refresh token itself is dead. */
  terminal: boolean;
}

type RefreshResult = RefreshSuccess | RefreshFailure;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const TERMINAL_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
]);

/**
 * Perform the OAuth 2.0 refresh_token grant against the entry's
 * configured `token_url`. Returns either the new access/refresh
 * tokens or a structured failure with `terminal=true` when the user
 * must re-auth.
 */
async function exchangeRefreshToken(
  refresh: OAuthRefreshBlock,
): Promise<RefreshResult> {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refresh.refresh_token);
  params.set("client_id", refresh.client_id);
  if (refresh.client_secret) params.set("client_secret", refresh.client_secret);

  let resp: Response;
  try {
    resp = await fetch(refresh.token_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      message: err instanceof Error ? err.message : String(err),
      terminal: false,
    };
  }

  let body: TokenResponse = {};
  const text = await resp.text();
  try {
    body = text ? (JSON.parse(text) as TokenResponse) : {};
  } catch {
    // Non-JSON body — treat as opaque server error.
    return {
      ok: false,
      reason: "non_json_response",
      message: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
      terminal: resp.status === 400 || resp.status === 401,
    };
  }

  if (!resp.ok || body.error) {
    const code = typeof body.error === "string" ? body.error : `http_${resp.status}`;
    return {
      ok: false,
      reason: code,
      message:
        body.error_description ??
        body.error ??
        `Token endpoint returned HTTP ${resp.status}.`,
      terminal: TERMINAL_ERROR_CODES.has(code) || resp.status === 401,
    };
  }

  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    return {
      ok: false,
      reason: "no_access_token",
      message: "Token endpoint did not return an access_token.",
      terminal: true,
    };
  }

  const expiresAtMs =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? Date.now() + body.expires_in * 1000
      : null;

  return {
    ok: true,
    access_token: body.access_token,
    refresh_token:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : undefined,
    expires_at_ms: expiresAtMs,
  };
}

function shouldRefreshNow(entry: VaultEntry): boolean {
  if (!entry.refresh) return false;
  const expiresAt = entry.refresh.expires_at_ms;
  // No expiry recorded → refresh once so we capture one.
  if (typeof expiresAt !== "number") return true;
  return expiresAt - Date.now() < REFRESH_LEAD_MS;
}

async function refreshOne(key: string, entry: VaultEntry): Promise<void> {
  if (!entry.refresh) return;
  const result = await exchangeRefreshToken(entry.refresh);
  if (result.ok) {
    rotateOAuthAccessToken(key, result.access_token, {
      refresh_token: result.refresh_token ?? entry.refresh.refresh_token,
      expires_at_ms: result.expires_at_ms ?? undefined,
      last_refreshed_ms: Date.now(),
      last_error: undefined,
    });
    console.error(
      `[OAuthRefresher] Rotated "${key}" (expires_at=${
        result.expires_at_ms ? new Date(result.expires_at_ms).toISOString() : "unknown"
      })`,
    );
    return;
  }

  recordOAuthRefreshError(key, `${result.reason}: ${result.message}`);
  console.warn(
    `[OAuthRefresher] Refresh failed for "${key}": ${result.reason} — ${result.message}`,
  );

  if (result.terminal) {
    pushAuthRequired({
      provider: providerFromKey(key),
      required_secrets: [key],
      auth_type: "OAUTH_PKCE",
      golden_path_url: null,
      instructions: [
        `The OAuth refresh token for "${key}" is no longer accepted (${result.reason}).`,
        "Open the provider's authorization page and re-authorise the Aegis app.",
        "Paste the new access token (and refresh token, if issued) into the vault.",
      ],
      message: `OAuth refresh failed for "${key}": ${result.message}`,
    });
  }
}

function providerFromKey(key: string): string {
  return key
    .toUpperCase()
    .replace(/_(API_KEY|API|KEY|SECRET|TOKEN|PAT|OAUTH)$/i, "")
    .toLowerCase();
}

let refresherTimer: NodeJS.Timeout | null = null;
let inflight = false;

async function tick(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const candidates = listOAuthEntries().filter(({ entry }) =>
      shouldRefreshNow(entry),
    );
    if (candidates.length === 0) return;
    await Promise.all(
      candidates.map(({ key, entry }) =>
        refreshOne(key, entry).catch((err) => {
          console.warn(`[OAuthRefresher] tick error for "${key}":`, err);
        }),
      ),
    );
  } finally {
    inflight = false;
  }
}

/** Start the background refresher. Idempotent. */
export function startOAuthRefresher(): void {
  if (refresherTimer) return;
  // Run once on boot in case the process restarted past an expiry.
  void tick().catch((err) => {
    console.warn("[OAuthRefresher] initial tick failed:", err);
  });
  refresherTimer = setInterval(() => {
    void tick().catch((err) => {
      console.warn("[OAuthRefresher] tick failed:", err);
    });
  }, REFRESH_TICK_MS);
  refresherTimer.unref?.();
  console.error(
    `[OAuthRefresher] Started (tick=${REFRESH_TICK_MS}ms, lead=${REFRESH_LEAD_MS}ms)`,
  );
}

/** Stop the background refresher (test / shutdown only). */
export function stopOAuthRefresher(): void {
  if (refresherTimer) {
    clearInterval(refresherTimer);
    refresherTimer = null;
  }
}
