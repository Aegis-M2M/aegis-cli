#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { randomUUID } from "crypto";
import { DASHBOARD_HTML } from "./dashboard.js";

// --- USDC on Base ---
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "nonces",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// --- CONFIG & PATHS ---
const CONFIG_DIR = path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");

const AEGIS_ROUTER_URL =
  process.env.AEGIS_ROUTER_URL ||
  "https://aegis-router-production.up.railway.app";
const AEGIS_ROUTER_BASE = AEGIS_ROUTER_URL.replace(/\/$/, "");
const AEGIS_EXECUTE_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/execute`;
const AEGIS_FUND_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/fund`;
const AEGIS_BALANCE_ENDPOINT = (wallet: string) =>
  `${AEGIS_ROUTER_BASE}/v1/balance/${wallet}`;

const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510";

const RPC_URL = process.env.BASE_RPC_URL;
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// --- IDENTITY MANAGEMENT ---
function getOrCreateIdentity() {
  if (process.env.AEGIS_PRIVATE_KEY) {
    try {
      let pk = process.env.AEGIS_PRIVATE_KEY;
      if (!pk.startsWith("0x")) pk = `0x${pk}`;

      const account = privateKeyToAccount(pk as `0x${string}`);
      return { account };
    } catch (err) {
      console.error(
        "[Aegis] ❌ Invalid AEGIS_PRIVATE_KEY provided in environment variables.",
      );
      process.exit(1);
    }
  }

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  if (existsSync(IDENTITY_PATH)) {
    try {
      const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
      if (data.privateKey) {
        return { account: privateKeyToAccount(data.privateKey) };
      }
    } catch (err) {
      console.error("[Aegis] ⚠️ identity.json corrupted. Generating new...");
    }
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const identity = {
    address: account.address,
    privateKey: privateKey,
    created: new Date().toISOString(),
  };

  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), {
    mode: 0o600,
  });
  return { account };
}

const { account: userAccount } = getOrCreateIdentity();
const walletClient = createWalletClient({
  account: userAccount,
  chain: base,
  transport: http(RPC_URL),
});

// --- USDC PERMIT (EIP-2612 Gasless Deposit) ---

let sweepLockChain: Promise<unknown> = Promise.resolve();

function withSweepLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sweepLockChain.then(() => fn());
  sweepLockChain = run.catch(() => undefined);
  return run;
}

async function checkAndSweepFunds(): Promise<boolean> {
  return withSweepLock(async () => {
    const balance = await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [userAccount.address],
    });

    if (balance <= 0n) return false;

    console.error(
      `[Aegis] 💰 USDC detected: ${Number(balance) / 1e6} USDC. Signing permit...`,
    );

    const nonce = await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "nonces",
      args: [userAccount.address],
    });

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const signature = await walletClient.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: base.id,
        verifyingContract: BASE_USDC,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: userAccount.address,
        spender: AEGIS_ENTERPRISE_WALLET as `0x${string}`,
        value: balance,
        nonce,
        deadline,
      },
    });

    try {
      const res = await fetch(AEGIS_FUND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: userAccount.address,
          amount: balance.toString(),
          deadline: deadline.toString(),
          signature,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error(
          `[Aegis] ❌ Fund request failed (${res.status}):`,
          body.error ?? body,
        );
        return false;
      }

      const result = await res.json();
      console.error(
        `[Aegis] ✅ Deposit credited. Balance: ${result.credit_balance} credits`,
      );
      return true;
    } catch (err) {
      console.error("[Aegis] ❌ Fund request error:", err);
      return false;
    }
  });
}

// --- CALL FEED (in-memory ring buffer powering the dashboard) ---
type CallStatus = "pending" | "ok" | "err";
interface CallRecord {
  id: string;
  service: string;
  detail: string;
  status: CallStatus;
  credits_charged: number | null;
  credits_refunded: number | null;
  balance_after: number | null;
  started_at: number;
  duration_ms: number | null;
  error?: string | null;
}

const MAX_CALLS = 50;
const callFeed: CallRecord[] = [];

function summarizeRequest(service: string, req: any): string {
  if (!req || typeof req !== "object") return "";
  if (service === "aegis-parse" && typeof req.url === "string") return req.url;
  if (typeof req.url === "string") return req.url;
  if (typeof req.prompt === "string") return req.prompt;
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    const last = req.messages[req.messages.length - 1];
    if (last && typeof last.content === "string") return last.content;
  }
  if (typeof req.model === "string") return `model: ${req.model}`;
  try {
    return JSON.stringify(req).slice(0, 120);
  } catch {
    return "";
  }
}

function pushCall(rec: CallRecord) {
  callFeed.unshift(rec);
  if (callFeed.length > MAX_CALLS) callFeed.length = MAX_CALLS;
}

function updateCall(id: string, patch: Partial<CallRecord>) {
  const idx = callFeed.findIndex((c) => c.id === id);
  if (idx === -1) return;
  callFeed[idx] = { ...callFeed[idx], ...patch };
}

// --- SHARED CORE ENGINE (Execution Envelope) ---
async function executeAegisRequest(service: string, requestPayload: any) {
  const callId = randomUUID();
  const started = Date.now();

  pushCall({
    id: callId,
    service,
    detail: summarizeRequest(service, requestPayload),
    status: "pending",
    credits_charged: null,
    credits_refunded: null,
    balance_after: null,
    started_at: started,
    duration_ms: null,
  });

  try {
    await checkAndSweepFunds();
  } catch (rpcError: any) {
    console.error("[Aegis] ⚠️ RPC sweep check failed:", rpcError.message);
  }

  const timestamp = Date.now().toString();
  const message = `Aegis Auth: ${userAccount.address}:${timestamp}`;
  const signature = await userAccount.signMessage({ message });

  try {
    const response = await fetch(AEGIS_EXECUTE_ENDPOINT, {
      method: "POST",
      headers: {
        "x-wallet-address": userAccount.address,
        "x-signature": signature,
        "x-timestamp": timestamp,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ service, request: requestPayload }),
      signal: AbortSignal.timeout(120_000),
    });

    if (response.status === 402) {
      updateCall(callId, {
        status: "err",
        duration_ms: Date.now() - started,
        error: "CREDITS_DEPLETED",
      });
      throw new Error(
        `CREDITS_DEPLETED: Please deposit USDC (Base) to ${userAccount.address}`,
      );
    }

    if (!response.ok) {
      updateCall(callId, {
        status: "err",
        duration_ms: Date.now() - started,
        error: `HTTP ${response.status}`,
      });
      throw new Error(
        `API_ERROR: Upstream request failed (Status ${response.status})`,
      );
    }

    const responseData: any = await response.json();
    const billing = responseData?.aegis_billing ?? {};
    updateCall(callId, {
      status: "ok",
      duration_ms: Date.now() - started,
      credits_charged: typeof billing.credits_charged === "number" ? billing.credits_charged : null,
      credits_refunded: typeof billing.credits_refunded === "number" ? billing.credits_refunded : null,
      balance_after: typeof billing.credit_balance === "number" ? billing.credit_balance : null,
    });

    return responseData;
  } catch (err: any) {
    const existing = callFeed.find((c) => c.id === callId);
    if (existing && existing.status === "pending") {
      updateCall(callId, {
        status: "err",
        duration_ms: Date.now() - started,
        error: err?.message ?? "unknown",
      });
    }
    throw err;
  }
}

// --- MODE 1: MCP SERVER LOGIC ---
async function startMcpServer() {
  const server = new McpServer({ name: "Aegis Network", version: "1.0.0" });

  server.tool(
    "aegis_scrape",
    "Scrapes any URL into clean Markdown. Proves payment via on-chain signature.",
    { url: z.string().url() },
    async ({ url }) => {
      try {
        const responseData = await executeAegisRequest("aegis-parse", { url });
        const { data, aegis_billing } = responseData;
        const title = data?.title || "Untitled Page";
        const markdown = data?.content || "No content extracted.";
        const balance = aegis_billing?.credit_balance ?? "Unknown";

        return {
          content: [
            {
              type: "text",
              text: `[Aegis Wallet Balance: ${balance} Credits]\n\n# ${title}\n\n${markdown}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            { type: "text", text: `❌ Scrape failed: ${error.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Aegis MCP Live.");
  console.error(`📫 Wallet: ${userAccount.address}`);
}

// --- Router balance proxy (fed into the dashboard) ---
interface BalanceSnapshot {
  credits: number | null;
  usd_value: number | null;
  scrapes_remaining: number | null;
  fetched_at: number;
  error: string | null;
}

let lastBalance: BalanceSnapshot = {
  credits: null,
  usd_value: null,
  scrapes_remaining: null,
  fetched_at: 0,
  error: null,
};

const BALANCE_STALE_MS = 3_000;
let inflightBalance: Promise<BalanceSnapshot> | null = null;

async function fetchBalance(force = false): Promise<BalanceSnapshot> {
  const fresh = Date.now() - lastBalance.fetched_at < BALANCE_STALE_MS;
  if (!force && fresh && lastBalance.error === null) return lastBalance;
  if (inflightBalance) return inflightBalance;

  inflightBalance = (async () => {
    try {
      const res = await fetch(AEGIS_BALANCE_ENDPOINT(userAccount.address), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        lastBalance = {
          credits: null,
          usd_value: null,
          scrapes_remaining: null,
          fetched_at: Date.now(),
          error: `router ${res.status}`,
        };
      } else {
        const data: any = await res.json();
        lastBalance = {
          credits: typeof data.credits === "number" ? data.credits : null,
          usd_value: typeof data.usd_value === "number" ? data.usd_value : null,
          scrapes_remaining:
            typeof data.scrapes_remaining === "number"
              ? data.scrapes_remaining
              : null,
          fetched_at: Date.now(),
          error: null,
        };
      }
    } catch (err: any) {
      lastBalance = {
        credits: null,
        usd_value: null,
        scrapes_remaining: null,
        fetched_at: Date.now(),
        error: err?.message ?? "unreachable",
      };
    } finally {
      inflightBalance = null;
    }
    return lastBalance;
  })();

  return inflightBalance;
}

// --- MODE 2: LOCAL DAEMON LOGIC ---
async function startDaemonServer(port: number) {
  const app = express();

  // SECURITY: The daemon controls a live Web3 wallet and can spend USDC.
  // A permissive CORS policy would let any website the user visits issue
  // fetch('http://localhost:<port>/v1/execute', ...) in the background and
  // drain credits. We restrict origins to the local dashboard only.
  // Extra allowed origins can be injected via AEGIS_ALLOWED_ORIGINS (comma-separated).
  const extraOrigins = (process.env.AEGIS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const allowedOrigins = new Set<string>([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...extraOrigins,
  ]);

  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / non-browser clients (curl, local scripts) which
        // send no Origin header. Reject any cross-origin browser request that
        // isn't explicitly whitelisted.
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed: ${origin}`));
      },
    }),
  );
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(DASHBOARD_HTML);
  });

  app.get("/api/status", async (_req, res) => {
    const bal = await fetchBalance();
    res.json({
      wallet: userAccount.address,
      credits: bal.credits,
      usd_value: bal.usd_value,
      scrapes_remaining: bal.scrapes_remaining,
      router_online: bal.error === null,
      balance_error: bal.error,
      balance_fetched_at: bal.fetched_at,
      calls: callFeed,
    });
  });

  app.post("/v1/execute", async (req, res) => {
    const { service, request } = req.body;

    if (!service || !request) {
      return res
        .status(400)
        .json({ error: "Missing 'service' or 'request' in body envelope." });
    }

    try {
      const responseData = await executeAegisRequest(service, request);
      res.status(200).json(responseData);
    } catch (error: any) {
      console.error(`[Daemon] Error executing ${service}:`, error.message);

      let status = 500;
      if (
        error.message.includes("INSUFFICIENT_FUNDS") ||
        error.message.includes("CREDITS_DEPLETED")
      ) {
        status = 402;
      }

      res.status(status).json({ error: error.message });
    }
  });

  app.listen(port, () => {
    console.error(`🚀 Aegis Local Daemon Live on http://localhost:${port}`);
    console.error(`📊 Dashboard: http://localhost:${port}`);
    console.error(`📫 Deposit USDC (Base) to: ${userAccount.address}`);
    console.error(
      `💡 Bot Usage: POST http://localhost:${port}/v1/execute { "service": "...", "request": {...} }`,
    );
  });

  // Warm the balance cache so the first dashboard load is instant.
  fetchBalance(true).catch(() => undefined);
}

// --- THE ROUTER ---
async function main() {
  try {
    await checkAndSweepFunds();
  } catch (e) {
    console.error("⚠️ Base RPC unavailable on startup.");
  }

  const args = process.argv.slice(2);
  const mode = args[0] || "mcp";

  if (mode === "daemon" || mode === "start") {
    const portIndex = args.indexOf("--port");
    const port = portIndex > -1 ? parseInt(args[portIndex + 1]) : 23447;
    await startDaemonServer(port);
  } else {
    await startMcpServer();
  }
}

main().catch(console.error);
