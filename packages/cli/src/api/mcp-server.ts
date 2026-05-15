import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { browserManager } from "../browser/browser-manager.js";
import { runCatalogToolCall } from "../executor/run-catalog-tool.js";

export const sseSessions = new Map<string, SSEServerTransport>();

const CORE_TOOLS = [
  "aegis-omni-tool",
  "aegis-search",
  "aegis-parse",
] as const;

const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_get_a11y_tree",
  "browser_act",
  "browser_extract_data",
  "browser_screenshot",
] as const;

function isCoreTool(name: string): boolean {
  return (CORE_TOOLS as readonly string[]).includes(name);
}

function isBrowserTool(name: string): name is (typeof BROWSER_TOOLS)[number] {
  return (BROWSER_TOOLS as readonly string[]).includes(name);
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
      "Primary Integration Gateway. High Priority for all SaaS and REST API interactions (e.g., Todoist, Google, Banking). Use this to fetch, create, or modify structured data. Handles authentication and headers automatically. Prefer this over browser tools for any service with an API.",
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
      "High-fidelity web scraping and content extraction. Supports direct URL analysis and raw HTML injection.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Optional absolute URL to fetch and analyze.",
        },
        html: {
          type: "string",
          description: "Optional raw rendered HTML to analyze instead of fetching a URL.",
        },
        instructions: {
          type: "string",
          description: "Optional extraction focus for the parse engine.",
        },
      },
      anyOf: [{ required: ["url"] }, { required: ["html"] }],
    },
  },
  {
    name: "browser_navigate",
    description:
      "Opens a human-facing webpage in a visible browser window. Constraint: Never use this to access JSON/REST API endpoints (e.g., api.todoist.com). Use only for DOM-based scraping, visual verification, or interacting with sites that lack an API. Requires a human-like session.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_get_a11y_tree",
    description:
      "Return the current page accessibility tree. Use this as the primary browser sense tool before screenshots to minimize token cost.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_act",
    description:
      "Act on the current page using a Playwright selector. Supports click, type, and select.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "select"],
          description: "The browser action to perform.",
        },
        selector: {
          type: "string",
          description: "A Playwright selector for the target element.",
        },
        text: {
          type: "string",
          description: "Required for type and select actions.",
        },
      },
      required: ["action", "selector"],
    },
  },
  {
    name: "browser_extract_data",
    description:
      "Extract high-fidelity Markdown from the current page. Uses the Aegis Parse engine to strip noise and preserve semantic structure (tables, headers). Ideal for complex data reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description:
            "Guidance for the Parse engine about what information or structures to focus on.",
        },
      },
      required: ["instructions"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Return a base64 PNG screenshot of the current page. ONLY use this if browser_get_a11y_tree is insufficient.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function jsonText(data: unknown) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function requiredString(
  args: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

async function runBrowserToolCall(
  name: (typeof BROWSER_TOOLS)[number],
  args: Record<string, unknown> | undefined,
) {
  if (name === "browser_navigate") {
    const url = requiredString(args, "url");
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("browser_navigate only supports http(s) URLs.");
    }
    return jsonText(await browserManager.navigate(parsed.toString()));
  }

  if (name === "browser_get_a11y_tree") {
    return jsonText(await browserManager.getA11yTree());
  }

  if (name === "browser_act") {
    const action = requiredString(args, "action");
    if (action !== "click" && action !== "type" && action !== "select") {
      throw new Error('browser_act action must be "click", "type", or "select".');
    }
    return jsonText(
      await browserManager.act(
        action,
        requiredString(args, "selector"),
        optionalString(args, "text"),
      ),
    );
  }

  if (name === "browser_extract_data") {
    return jsonText(
      await browserManager.extractData(requiredString(args, "instructions")),
    );
  }

  const screenshot = await browserManager.screenshot();
  return {
    content: [
      {
        type: "image",
        data: screenshot.base64,
        mimeType: screenshot.mimeType,
      },
    ],
  };
}

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
      if (isBrowserTool(name)) {
        return runBrowserToolCall(name, args);
      }

      // The Core Three are router-backed. Browser tools are handled locally
      // against the daemon-owned persistent Chrome profile.
      if (!isCoreTool(name)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Unknown Aegis service: ${name}. ` +
                `Use one of: ${[...CORE_TOOLS, ...BROWSER_TOOLS].join(", ")}.`,
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
