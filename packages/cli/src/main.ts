#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runMcpStdio } from "./api/mcp-server.js";
import { startDaemonServer } from "./api/express-app.js";
import { browserManager } from "./browser/browser-manager.js";

const POLL_INTERVAL_MS = 5_000;

/** Stdout envelope after dequeue — filename + file body interpolated into JOB PAYLOAD. */
function formatJobReadyMessage(
  jobFilename: string,
  instructions: string,
): string {
  return `[AEGIS_RESULT: JOB_READY]

=== MANDATORY INSTRUCTIONS ===
You have a job. Execute the payload below. 
When finished, output 'DONE: [JobName]' and immediately run:
npm start -w @aegis-m2m/cli -- wait-for-job
If this command ever stops, exits, or errors out, you MUST immediately run it again.

=== JOB PAYLOAD ===
Job Name: ${jobFilename}
Instructions:
${instructions}`;
}

async function runWaitForJob(): Promise<void> {
  const queueDir = path.join(os.homedir(), ".aegis", "queue");
  await fs.mkdir(queueDir, { recursive: true });

  while (true) {
    const files = await fs.readdir(queueDir);
    const jobFiles = files.filter((f) => f.endsWith(".job")).sort();

    if (jobFiles.length > 0) {
      const nextJobFile = jobFiles[0]!;
      const jobPath = path.join(queueDir, nextJobFile);
      try {
        const instructions = await fs.readFile(jobPath, "utf-8");
        await fs.unlink(jobPath);
        console.log(formatJobReadyMessage(nextJobFile, instructions));
        process.exit(0);
      } catch (err) {
        console.error(
          `wait-for-job: error reading/removing ${nextJobFile}`,
          err,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  let args = process.argv.slice(2);

  // When launched via `tsx path/to/main.ts ...`, the script path is argv[3] and
  // becomes the first entry here — do not treat it as a subcommand. Same for any
  // trailing path segment ending in main.ts / main.js (Docker CMD uses tsx).
  if (
    args[0]?.endsWith("/main.ts") ||
    args[0]?.endsWith("\\main.ts") ||
    args[0]?.endsWith("/main.js") ||
    args[0]?.endsWith("\\main.js") ||
    args[0] === "main.ts" ||
    args[0] === "main.js"
  ) {
    args = args.slice(1);
  }

  if (args.includes("--stdio")) {
    await runMcpStdio();
    return;
  }

  if (args[0] === "wait-for-job") {
    await runWaitForJob();
    return;
  }

  if (args[0] === "auth-browser") {
    await browserManager.runVisibleAuthSession();
    return;
  }

  // Daemon mode: optional explicit `start`. Default when omitted (e.g. `--port 23447`
  // alone must not treat `23447` as a bogus command — that broke Docker Compose).
  if (args[0] === "start") {
    args = args.slice(1);
  }

  const portIndex = args.indexOf("--port");
  const port =
    portIndex > -1 ? Number.parseInt(args[portIndex + 1]!, 10) : 23447;
  await startDaemonServer(port);
  console.error(`📊 Dashboard: http://127.0.0.1:${port}/`);
}

main().catch(console.error);
