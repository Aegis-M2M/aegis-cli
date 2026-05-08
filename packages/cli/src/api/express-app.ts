import cors from "cors";
import express from "express";
import { randomUUID } from "crypto";
import { DASHBOARD_HTML } from "../dashboard.js";
import {
  AEGIS_BALANCE_ENDPOINT,
  AEGIS_REGISTER_ENDPOINT,
  AEGIS_REGISTRY_STATS_ENDPOINT,
  SERVICE_ID_RE,
} from "../config.js";
import { checkAndSweepFunds } from "../crypto/economy.js";
import { userAccount } from "../crypto/identity.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";
import {
  createSessionMcpServer,
  ensureHubSyncBeforeMcpSse,
  sseSessions,
  SSEServerTransport,
} from "./mcp-server.js";
import {
  executeAegisRequest,
  executeAegisStream,
  parseRouterExecuteError,
} from "../executor/router-client.js";
import {
  ensureBuiltinServices,
  loadServices,
  saveServices,
} from "../services/catalog.js";

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

  app.get("/api/catalog", (_req, res) => {
    const services = loadServices();
    res.json({
      services: Object.entries(services).map(([id, meta]) => ({
        id,
        ...(meta as Record<string, unknown>),
      })),
    });
  });

  app.post("/api/provider/register", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const { id, endpoint_url, secret } = body;
    if (typeof id !== "string" || !SERVICE_ID_RE.test(id))
      return res.status(400).json({ error: "INVALID_ID" });

    let method: "POST" | "PUT" = "POST";
    try {
      const probe = await fetch(AEGIS_REGISTRY_STATS_ENDPOINT(id));
      if (probe.ok) {
        const stats = (await probe.json()) as {
          service?: { provider_wallet?: string };
        };
        if (
          stats?.service?.provider_wallet?.toLowerCase() !==
          userAccount.address.toLowerCase()
        ) {
          return res.status(403).json({
            error: "NOT_OWNER",
            message: "This ID belongs to another wallet.",
          });
        }
        method = "PUT";
      }
    } catch {
      /* use POST */
    }

    if (method === "POST") {
      try {
        let origin: string;
        try {
          origin = new URL(endpoint_url as string).origin;
        } catch {
          return res.status(400).json({ error: "INVALID_ENDPOINT_URL" });
        }
        const healthUrl = `${origin}/health`;
        let test = await fetch(healthUrl, {
          method: "GET",
          signal: AbortSignal.timeout(15_000),
        });
        // Prefer `/health` (Hydra, parse worker). Fall back to origin GET for
        // simple public fixtures (e.g. httpbin) that expose no health route.
        if (test.status === 404) {
          test = await fetch(origin, {
            method: "GET",
            signal: AbortSignal.timeout(15_000),
          });
        }
        if (!test.ok) {
          return res.status(400).json({
            error: "LOCAL_UNREACHABLE",
            message: `Liveness check returned ${test.status}`,
          });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return res
          .status(400)
          .json({ error: "LOCAL_UNREACHABLE", message });
      }
    }

    try {
      const payload =
        method === "POST"
          ? {
              ...body,
              provider_wallet: userAccount.address,
              provider_secret: secret,
            }
          : { ...body, new_secret: secret };
      const sync = await fetch(AEGIS_REGISTER_ENDPOINT, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(await signAegisRequestHeaders(userAccount)),
        },
        body: JSON.stringify(payload),
      });
      const syncBodyText = await sync.text();
      let data: unknown;
      try {
        data = syncBodyText ? JSON.parse(syncBodyText) : {};
      } catch {
        data = { error: "INVALID_ROUTER_JSON", raw: syncBodyText };
      }
      if (sync.ok) {
        const services = loadServices();
        services[id] = {
          ...body,
          registered_at: new Date().toISOString(),
        };
        saveServices(services);
      }
      res.status(sync.status).json(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "ROUTER_ERROR", message });
    }
  });

  app.get("/mcp/sse", async (_req, res) => {
    let transport: SSEServerTransport | undefined;
    let sessionServer: ReturnType<typeof createSessionMcpServer> | undefined;
    try {
      await ensureHubSyncBeforeMcpSse();

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
  ensureBuiltinServices();
  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.error(
        `🚀 Aegis Hub Engine Live on port ${port} (MCP SSE at /mcp/sse)`,
      );
      resolve();
    });
  });
  void checkAndSweepFunds().catch(() => {});
  setInterval(() => {
    void checkAndSweepFunds().catch(() => {});
  }, SWEEP_INTERVAL_MS);
}
