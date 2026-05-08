import cors from "cors";
import express from "express";
import { randomUUID } from "crypto";
import { DASHBOARD_HTML } from "../dashboard.js";
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
import {
  loadRelayConfig,
  removeRelayNodeConfig,
  upsertRelayNodeConfig,
} from "../relay/config.js";
import { getSecret } from "../crypto/vault.js";

export function createExpressApp(): express.Express {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  app.get("/", (_req, res) => res.send(DASHBOARD_HTML));

  app.get("/api/status", async (_req, res) => {
    try {
      const r = await fetch(AEGIS_BALANCE_ENDPOINT(userAccount.address));
      const b = (await r.json()) as {
        credits?: unknown;
        usd_value?: unknown;
      };
      res.json({
        wallet: userAccount.address,
        credits: b.credits,
        usd_value: b.usd_value,
        router_online: true,
      });
    } catch {
      res.json({
        wallet: userAccount.address,
        credits: 0,
        router_online: false,
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
      const data = await executeAegisRequest(
        service,
        requestBody,
        maxCredits,
      );
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
        systemPrompt = systemPrompt.map((b: { text?: string }) => b.text || "").join("\n");
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
  // Lightweight HTTP surface mirroring the `aegis-cli relay ...` CLI.
  // Lets the dashboard / MCP host inspect or mutate the relay.json
  // opt-ins without spawning a subprocess.

  app.get("/api/relay/status", (_req, res) => {
    const cfg = loadRelayConfig();
    res.json({
      ...getRelayListenerStatus(),
      configured: cfg.nodes,
    });
  });

  app.post("/api/relay/register", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slug = body.provider_slug;
    const vault = body.vault_key_name;
    const fee = body.fee_per_call;
    const rate = body.rate_limit_max;

    if (
      typeof slug !== "string" ||
      !SERVICE_ID_RE.test(slug) ||
      typeof vault !== "string" ||
      vault.length === 0 ||
      typeof fee !== "number" ||
      !Number.isInteger(fee) ||
      fee < 0 ||
      typeof rate !== "number" ||
      !Number.isInteger(rate) ||
      rate <= 0
    ) {
      return res
        .status(400)
        .json({ error: "INVALID_RELAY_REGISTRATION" });
    }

    if (!getSecret(vault)) {
      return res.status(400).json({
        error: "VAULT_MISS",
        message: `Vault has no value for key "${vault}". Add it to vault.json before registering as a relay.`,
      });
    }

    const next = upsertRelayNodeConfig({
      provider_slug: slug.toLowerCase(),
      vault_key_name: vault,
      fee_per_call: fee,
      rate_limit_max: rate,
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
const SWEEP_INTERVAL_MS = 5_000;

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
}
