#!/usr/bin/env node
import { runMcpStdio } from "./api/mcp-server.js";
import { startDaemonServer } from "./api/express-app.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--stdio")) {
    await runMcpStdio();
    return;
  }
  const portIndex = args.indexOf("--port");
  const port = portIndex > -1 ? parseInt(args[portIndex + 1], 10) : 23447;
  await startDaemonServer(port);
}

main().catch(console.error);
