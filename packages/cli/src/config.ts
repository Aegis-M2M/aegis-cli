import path from "path";
import os from "os";

export const CONFIG_DIR = process.env.AEGIS_HOME
  ? path.resolve(process.env.AEGIS_HOME)
  : path.join(os.homedir(), ".aegis");

export const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");
export const VAULT_PATH = path.join(CONFIG_DIR, "vault.json");

export const BASE_USDC =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const AEGIS_ENTERPRISE_WALLET =
  "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510";

export const AEGIS_ROUTER_URL =
  process.env.AEGIS_ROUTER_URL ||
  "https://aegis-router-production.up.railway.app";
export const AEGIS_ROUTER_BASE = AEGIS_ROUTER_URL.replace(/\/$/, "");
export const AEGIS_EXECUTE_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/execute`;
export const AEGIS_FUND_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/fund`;
export const AEGIS_BALANCE_ENDPOINT = (wallet: string) =>
  `${AEGIS_ROUTER_BASE}/v1/balance/${wallet}`;

export const SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

export const ERC20_ABI = [
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
