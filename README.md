# Aegis Parse - MCP Client

Aegis Parse is a Model Context Protocol (MCP) server that enables AI assistants (like Claude Desktop) to scrape web pages into LLM-optimized Markdown.

It uses a **Transit Wallet** system on the Base network to handle per-scrape micro-transactions without requiring monthly subscriptions or manual API keys.

## 🚀 Quickstart

Add Aegis Parse to your Claude Desktop configuration:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aegis-parse": {
      "command": "npx",
      "args": ["-y", "github:Aegis-M2M/mcp-client"]
    }
  }
}
```

Restart Claude Desktop, and you can now ask: *"Use aegis_scrape to summarize [URL]"*.

## 💳 How the Transit Wallet Works

Aegis Parse is designed for Machine-to-Machine (M2M) payments. Instead of managing a balance on a website, your local client handles the transaction directly.

- **Automatic Generation:** On boot, the client creates a unique wallet address located at `~/.aegis/identity.json`.

- **Pass-Through Funding:** When your balance is low, Claude will provide your address. Send a small amount of Base ETH to it.

- **Instant Sweep:** The client detects the deposit and immediately sweeps the funds to the Aegis Enterprise Wallet to purchase scraping credits.

- **Zero Maintenance:** Once the sweep is complete, your local wallet returns to a near-zero balance.

## ⚠️ Security Warning

The Aegis CLI generates a **Transit Wallet** and stores its private key **in plaintext** at `~/.aegis/identity.json` (protected with `0600` file permissions). This is designed for micro-transactions only.

> **Do not send your life savings or large amounts of ETH/USDC to this address. Treat it like a metro card, not a bank vault.**

If your machine is compromised, anyone with read access to your home directory can exfiltrate this key. Only keep enough balance on the transit wallet to cover short-term scraping usage.

## ⚠️ Safety & Best Practices

- **Transit Only:** This wallet is a temporary staging area for funds. Only send the amount of Base ETH/USDC you intend to use for immediate scraping.

- **Local Identity:** Your private key is stored locally in your home directory (`~/.aegis/`). If you delete this folder or the file is corrupted while it contains unswept funds, those funds cannot be recovered.

- **Verify Payout Address:** To ensure you are sending funds to the correct service, verify the hardcoded enterprise payout address: `0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510`.

- **Daemon CORS:** When running `aegis daemon`, the local HTTP server only accepts browser requests from the bundled dashboard origin (`http://localhost:<port>`). This prevents arbitrary websites from silently calling `/v1/execute` and draining your credits. To allow additional origins (e.g., a local dev app), set `AEGIS_ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173"`.

## ⚙️ Advanced Configuration

**Custom RPC:** Set the `BASE_RPC_URL` environment variable to use a private Alchemy or Infura endpoint if you encounter rate limits on public nodes.
