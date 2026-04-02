#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from "viem";
import { base } from "viem/chains";

// --- CONFIG & PATHS ---
const CONFIG_DIR = path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");

const AEGIS_API_URL = "https://aegis-parse-production.up.railway.app/api/parse";
const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510"; // Payout wallet

// Allow custom RPC to prevent rate limiting, fallback to public
const RPC_URL = process.env.BASE_RPC_URL;
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// --- IDENTITY MANAGEMENT ---
function getOrCreateIdentity() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  if (existsSync(IDENTITY_PATH)) {
    try {
      // Handle corrupt JSON gracefully
      const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
      if (data.privateKey) {
        return {
          account: privateKeyToAccount(data.privateKey),
          activeTxHash: data.activeTxHash || null,
        };
      }
    } catch (err) {
      console.error(
        "[Aegis] ⚠️ identity.json corrupted. Generating new wallet...",
      );
    }
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const identity = {
    address: account.address,
    privateKey: privateKey,
    activeTxHash: null,
    created: new Date().toISOString(),
  };

  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), {
    mode: 0o600,
  });
  return { account, activeTxHash: null };
}

let { account: userAccount, activeTxHash: globalTxHash } =
  getOrCreateIdentity();
const walletClient = createWalletClient({
  account: userAccount,
  chain: base,
  transport: http(RPC_URL),
});

/** Serializes identity.json read/modify/write so concurrent sweeps cannot interleave. */
let identityFileChain: Promise<unknown> = Promise.resolve();

function withIdentityFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = identityFileChain.then(() => fn());
  identityFileChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- CORE LOGIC: SWEEP & SYNC ---
// We check the balance on every scrape to ensure top-ups are caught immediately.
async function checkAndSweepFunds() {
  const balance = await publicClient.getBalance({
    address: userAccount.address,
  });

  const feeData = await publicClient.estimateFeesPerGas();
  const gasPrice =
    feeData.maxFeePerGas ?? feeData.gasPrice ?? parseEther("0.000000001");
  const estimatedGas = 21000n; // standard ETH transfer
  const totalFee = gasPrice * estimatedGas;

  // Minimum threshold: Don't sweep dust. Wait until they have at least 0.000005 ETH + gas.
  const minThreshold = parseEther("0.000005") + totalFee;

  if (balance >= minThreshold) {
    const valueToSend = balance - totalFee;

    console.error(
      `[Aegis] 💰 Deposit detected! Sweeping ${formatEther(valueToSend)} to Aegis (reserving ${formatEther(totalFee)} for gas)...`,
    );

    try {
      const hash = await walletClient.sendTransaction({
        to: AEGIS_ENTERPRISE_WALLET as `0x${string}`,
        value: valueToSend,
        gas: estimatedGas,
        ...(feeData.maxFeePerGas != null
          ? {
              maxFeePerGas: feeData.maxFeePerGas,
              maxPriorityFeePerGas:
                feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas,
            }
          : { gasPrice }),
      });

      await withIdentityFileLock(async () => {
        const fileContent = await fs.readFile(IDENTITY_PATH, "utf-8");
        const identityData = JSON.parse(fileContent);
        identityData.activeTxHash = hash;
        await fs.writeFile(
          IDENTITY_PATH,
          JSON.stringify(identityData, null, 2),
          {
            mode: 0o600,
          },
        );
      });

      globalTxHash = hash;
      console.error(`[Aegis] ✅ Credits initialized. Hash: ${hash}`);
      return hash;
    } catch (err) {
      console.error("[Aegis] ❌ Sweep failed:", err);
    }
  }

  return globalTxHash;
}

// --- MCP SERVER SETUP ---
const server = new McpServer({
  name: "Aegis Parse",
  version: "1.0.0",
});

server.tool(
  "aegis_scrape",
  "Scrapes any URL into clean Markdown. Proves payment via on-chain signature.",
  { url: z.string().url() },
  async ({ url }) => {
    let currentHash;

    // Wrap the sweep in a try/catch for RPC network failures
    try {
      currentHash = await checkAndSweepFunds();
    } catch (rpcError: any) {
      console.error("[Aegis] RPC Error:", rpcError.message);
      return {
        content: [
          {
            type: "text",
            text: "❌ Error: Could not connect to the Base network to verify funds. Please check your internet or try setting a custom BASE_RPC_URL.",
          },
        ],
        isError: true,
      };
    }

    if (!currentHash) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Aegis Wallet Empty. Please send Base ETH to: ${userAccount.address}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const timestamp = Date.now().toString();
      const message = `Aegis Parse Auth: ${currentHash}:${timestamp}`;
      const signature = await userAccount.signMessage({ message });

      const response = await axios.post(
        AEGIS_API_URL,
        { url },
        {
          headers: {
            "x-payment-token": currentHash,
            "x-signature": signature,
            "x-timestamp": timestamp,
            "Content-Type": "application/json",
          },
          timeout: 45000,
        },
      );

      // Defensive API Response parsing
      const responseData = response.data || {};
      if (!responseData.data || !responseData.metadata) {
        throw new Error("Invalid response format from Aegis API.");
      }

      const { data, metadata } = responseData;

      // Deep fallback validation for string interpolation
      const title = data?.title || "Untitled Page";
      const markdown = data?.content || "No content could be extracted.";
      const balance = metadata?.credit_balance ?? "Unknown";

      return {
        content: [
          {
            type: "text",
            text: `[Aegis Wallet Balance: ${balance} Credits]\n\n# ${title}\n\n${markdown}`,
          },
        ],
      };
    } catch (error: any) {
      if (error.response?.status === 402) {
        console.error(
          "[Aegis] 402 Payment Required. Waiting for new deposits...",
        );
        return {
          content: [
            {
              type: "text",
              text: "❌ Credits depleted. Please top up your Aegis wallet with Base ETH and try again.",
            },
          ],
          isError: true,
        };
      }

      // Sanitize errors so we don't leak hostnames or proxy configs
      const cleanError = error.response
        ? `API Error: Status ${error.response.status}`
        : "Network or timeout error connecting to Aegis.";
      console.error(`[Aegis] Backend Error:`, error.message);

      return {
        content: [{ type: "text", text: `Error: ${cleanError}` }],
        isError: true,
      };
    }
  },
);

// --- STARTUP ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("🚀 Aegis MCP Live.");
  console.error(`📫 Wallet: ${userAccount.address}`);

  // Don't crash on startup if RPC is down
  try {
    const hash = await checkAndSweepFunds();
    if (hash) {
      console.error(`✅ Ready to scrape with hash: ${hash}`);
    } else {
      console.error("ℹ️ No pending deposits found. Waiting for funds...");
    }
  } catch (startupError) {
    console.error(
      "⚠️ Could not reach Base RPC on startup. Will retry on next scrape.",
    );
  }
}

main().catch(console.error);
