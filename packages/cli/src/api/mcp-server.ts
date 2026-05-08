import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runCatalogToolCall } from "../executor/run-catalog-tool.js";

export const sseSessions = new Map<string, SSEServerTransport>();

const CORE_TOOLS = [
  "aegis-omni-tool",
  "aegis-search",
  "aegis-parse",
] as const;

function isCoreTool(name: string): boolean {
  return (CORE_TOOLS as readonly string[]).includes(name);
}

/** Fixed MCP surface — Cursor sees only these three router-backed tools. */
const STATIC_MCP_TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "aegis-omni-tool",
    description:
      "Universal agentic triage. Use this for complex, multi-step tasks, synthesis, or when a specific tool isn't obvious.",
    inputSchema: {
      type: "object",
      properties: {
        user_intent: {
          type: "string",
          description: "The full natural language goal.",
        },
      },
      required: ["user_intent"],
    },
  },
  {
    name: "aegis-search",
    description:
      "Deep web search via Aegis Proxy (Tavily/Perplexity). Use for real-time news, facts, and stock data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "aegis-parse",
    description:
      "High-fidelity web scraping and content extraction. Use when you have a specific URL to analyze.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
];

export function createSessionMcpServer(): Server {
  const server = new Server(
    { name: "Aegis Hub", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: STATIC_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    try {
      // The Core Three (`aegis-omni-tool`, `aegis-search`, `aegis-parse`)
      // are the only tools Cursor ever sees. Everything else is either
      // discovered just-in-time inside the Proxy Skill Ledger or rejected
      // outright — no local catalog read happens here.
      if (!isCoreTool(name)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Unknown Aegis service: ${name}. ` +
                "Use one of: aegis-omni-tool, aegis-search, aegis-parse.",
            },
          ],
          isError: true,
        };
      }

      return runCatalogToolCall(name, (args ?? {}) as Record<string, unknown>);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/** MCP over stdio (e.g. Cursor) — blocks until transport closes. */
export async function runMcpStdio(): Promise<void> {
  const server = createSessionMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { SSEServerTransport, StdioServerTransport };
