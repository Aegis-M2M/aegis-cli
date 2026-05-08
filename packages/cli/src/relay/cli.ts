import { AEGIS_ROUTER_BASE, SERVICE_ID_RE } from "../config.js";
import { userAccount } from "../crypto/identity.js";
import { signAegisRequestHeaders } from "../crypto/signer.js";
import { getSecret } from "../crypto/vault.js";
import {
  loadRelayConfig,
  removeRelayNodeConfig,
  upsertRelayNodeConfig,
} from "./config.js";

// ════════════════════════════════════════════════════════════════════
//  `aegis-cli relay <sub>` — one-shot helper for editing relay.json
// ════════════════════════════════════════════════════════════════════
//
// Sub-commands:
//   register   --provider <slug> --vault-key <NAME> --fee <credits>
//              --rate-limit <n>
//   deregister <slug>
//   status     [--router]
//
// These edit `~/.aegis/relay.json` directly. The persistent daemon
// reloads the file on next call to `reloadRelayListener`. For users
// running the daemon under docker, restart the cli service to pick up
// the new config (or POST /api/relay/register to the running daemon).

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (typeof next === "string" && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  console.log(
    [
      "aegis-cli relay <sub>",
      "",
      "Sub-commands:",
      "  register   --provider <slug> --vault-key <NAME> --fee <credits> --rate-limit <n>",
      "             Add or update an entry in ~/.aegis/relay.json so the daemon",
      "             starts relaying calls for <slug> using vault.<NAME>.",
      "",
      "  deregister <slug>",
      "             Remove the entry from relay.json and tell the Router to",
      "             retire the (wallet, slug) directory row.",
      "",
      "  status     [--router]",
      "             Print local relay.json + (with --router) the row(s) the",
      "             Router has on file for this wallet.",
    ].join("\n"),
  );
}

async function callRouter(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    ...(await signAegisRequestHeaders(userAccount)),
    "Content-Type": "application/json",
  };
  const r = await fetch(`${AEGIS_ROUTER_BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, json };
}

async function runRegister(args: ParsedArgs): Promise<number> {
  const provider = args.flags.provider;
  const vault = args.flags["vault-key"] ?? args.flags.vaultKey;
  const fee = args.flags.fee;
  const rate = args.flags["rate-limit"] ?? args.flags.rateLimit;

  if (
    typeof provider !== "string" ||
    !SERVICE_ID_RE.test(provider) ||
    typeof vault !== "string" ||
    vault.length === 0 ||
    typeof fee !== "string" ||
    typeof rate !== "string"
  ) {
    console.error(
      "Usage: aegis-cli relay register --provider <slug> --vault-key <NAME> --fee <credits> --rate-limit <n>",
    );
    return 2;
  }

  const feeNum = Number(fee);
  const rateNum = Number(rate);
  if (
    !Number.isInteger(feeNum) ||
    feeNum < 0 ||
    !Number.isInteger(rateNum) ||
    rateNum <= 0
  ) {
    console.error(
      "--fee must be a non-negative integer; --rate-limit must be a positive integer.",
    );
    return 2;
  }

  if (!getSecret(vault)) {
    console.error(
      `Vault has no value for "${vault}". Edit ~/.aegis/vault.json before registering.`,
    );
    return 1;
  }

  const cfg = upsertRelayNodeConfig({
    provider_slug: provider.toLowerCase(),
    vault_key_name: vault,
    fee_per_call: feeNum,
    rate_limit_max: rateNum,
  });
  console.log("Updated ~/.aegis/relay.json:");
  console.log(JSON.stringify(cfg, null, 2));

  // Best-effort upsert on the Router so the directory row exists even
  // if the daemon hasn't been restarted yet. Failures are non-fatal —
  // the daemon's startup pass will retry.
  try {
    const r = await callRouter("/v1/relay/nodes", {
      method: "POST",
      body: {
        provider_slug: provider.toLowerCase(),
        fee_per_call: feeNum,
        rate_limit_max: rateNum,
      },
    });
    if (r.status >= 200 && r.status < 300) {
      console.log("Router /v1/relay/nodes upsert: ok");
    } else {
      console.warn(
        `Router /v1/relay/nodes upsert: status=${r.status} body=${JSON.stringify(r.json)}`,
      );
    }
  } catch (e) {
    console.warn(
      "Could not reach Router (daemon will retry on next boot):",
      e instanceof Error ? e.message : e,
    );
  }

  console.log(
    "Restart the daemon (or POST /api/relay/register on the running daemon) to start the listener.",
  );
  return 0;
}

async function runDeregister(args: ParsedArgs): Promise<number> {
  const slug = args.positional[0];
  if (typeof slug !== "string" || !SERVICE_ID_RE.test(slug)) {
    console.error("Usage: aegis-cli relay deregister <slug>");
    return 2;
  }
  const cfg = removeRelayNodeConfig(slug);
  console.log("Updated ~/.aegis/relay.json:");
  console.log(JSON.stringify(cfg, null, 2));

  try {
    const r = await callRouter(
      `/v1/relay/nodes/${encodeURIComponent(slug.toLowerCase())}`,
      { method: "DELETE" },
    );
    if (r.status >= 200 && r.status < 300) {
      console.log("Router DELETE: ok");
    } else {
      console.warn(
        `Router DELETE: status=${r.status} body=${JSON.stringify(r.json)}`,
      );
    }
  } catch (e) {
    console.warn(
      "Could not reach Router:",
      e instanceof Error ? e.message : e,
    );
  }

  return 0;
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const cfg = loadRelayConfig();
  console.log("Local ~/.aegis/relay.json:");
  console.log(JSON.stringify(cfg, null, 2));
  if (args.flags.router !== undefined) {
    try {
      const r = await callRouter("/v1/relay/nodes", { method: "GET" });
      console.log(`\nRouter view (status=${r.status}):`);
      console.log(JSON.stringify(r.json, null, 2));
    } catch (e) {
      console.warn(
        "Could not reach Router:",
        e instanceof Error ? e.message : e,
      );
    }
  }
  return 0;
}

export async function runRelayCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "register":
      return runRegister(parseArgs(rest));
    case "deregister":
      return runDeregister(parseArgs(rest));
    case "status":
      return runStatus(parseArgs(rest));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      console.error(`Unknown relay sub-command: ${sub}`);
      printHelp();
      return 2;
  }
}
