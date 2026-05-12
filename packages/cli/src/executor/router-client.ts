import type { Response } from "express";
import {
  AEGIS_EXECUTE_ENDPOINT,
  AEGIS_ROUTER_BASE,
} from "../config.js";
import { checkAndSweepFunds } from "../crypto/economy.js";
import { userAccount } from "../crypto/identity.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";

/**
 * Parses errors thrown as `Router returned <status>: <json>` from {@link executeAegisRequest}.
 */
export function parseRouterExecuteError(
  message: string,
): { httpStatus: number; body: Record<string, unknown> } | null {
  const match = /^Router returned (\d+):\s*([\s\S]+)$/.exec(message);
  if (!match) return null;
  const httpStatus = Number(match[1]);
  try {
    const body = JSON.parse(match[2]!) as Record<string, unknown>;
    return { httpStatus, body };
  } catch {
    return null;
  }
}

/**
 * Per-service fetch timeouts (ms).
 *
 * `aegis-omni-tool`: Keep in sync with the Router proxy hop (`AEGIS_OMNI_PROXY_TIMEOUT_MS`, 120s).
 * Cold runs run AuthResearcher after discovery; if the CLI timeout is shorter than the Router’s,
 * the MCP client aborts with no reply while the proxy can still upsert `authorize_instructions`.
 */
const SERVICE_FETCH_TIMEOUT_MS: Record<string, number> = {
  "aegis-omni-tool": 120_000,
  "aegis-bridge": 600_000,
};
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function executeAegisRequest(
  service: string,
  request: unknown,
  maxCredits?: number,
  injectedSecrets?: Record<string, string>,
): Promise<unknown> {
  await checkAndSweepFunds().catch(() => {});
  const headers: Record<string, string> = {
    ...(await signAegisRequestHeaders(userAccount)),
    "Content-Type": "application/json",
  };
  if (maxCredits) headers["x-max-credits"] = String(maxCredits);

  if (
    request !== undefined &&
    request !== null &&
    typeof request === "object" &&
    !Array.isArray(request)
  ) {
    (request as Record<string, unknown>)._wallet_id = userAccount.address;
  }

  const timeoutMs =
    SERVICE_FETCH_TIMEOUT_MS[service] ?? DEFAULT_FETCH_TIMEOUT_MS;

  const response = await fetch(AEGIS_EXECUTE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      service,
      request,
      _injected_secrets: injectedSecrets,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 402) {
    const errorText = await response.text();
    throw new Error(`Router returned 402: ${errorText}`);
  }
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`🚨 Router Error [${response.status}]:`, errorText);
    throw new Error(`Router returned ${response.status}: ${errorText}`);
  }

  const data: unknown = await response.json();
  return data;
}

export async function executeAegisStream(
  service: string,
  request: unknown,
  res: Response,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const headers: Record<string, string> = {
    ...(await signAegisRequestHeaders(userAccount)),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  try {
    const response = await fetch(`${AEGIS_ROUTER_BASE}/v1/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ service, request }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.write(
        `data: ${JSON.stringify({ type: "error", error: { message: errorText } })}\n\n`,
      );
      res.end();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is null");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Stream pipe failed:", message);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: { message } })}\n\n`,
    );
  } finally {
    res.end();
  }
}
