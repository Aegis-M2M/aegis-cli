#!/usr/bin/env node
import { runMcpStdio } from "./api/mcp-server.js";
import { startDaemonServer } from "./api/express-app.js";
import { runRelayCli } from "./relay/cli.js";

async function main() {
  const args = process.argv.slice(2);

  // `aegis-cli relay <sub>` short-circuits to the relay CLI helper —
  // it edits ~/.aegis/relay.json and pings the Router; it does NOT
  // start the long-running daemon.
  if (args[0] === "relay") {
    const code = await runRelayCli(args.slice(1));
    process.exit(code);
  }

  if (args.includes("--stdio")) {
    await runMcpStdio();
    return;
  }
  const portIndex = args.indexOf("--port");
  const port = portIndex > -1 ? parseInt(args[portIndex + 1], 10) : 23447;
  await startDaemonServer(port);
}

main().catch(console.error);
