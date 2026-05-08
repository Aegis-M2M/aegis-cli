// Served verbatim at GET / on the local daemon.
// Keep this self-contained — no external scripts, no build step.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Aegis · Local Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E⚡%3C/text%3E%3C/svg%3E" />
  <style>
    :root {
      --bg: #07080b;
      --bg-elev: #0e1116;
      --bg-elev-2: #141821;
      --border: #1f242e;
      --border-strong: #2a3140;
      --text: #e6e8ee;
      --text-dim: #8b93a7;
      --text-faint: #5a6275;
      --accent: #7cf9d0;
      --accent-dim: #2b7a63;
      --danger: #ff6b6b;
      --warn: #ffb86b;
      --ok: #7cf9d0;
      --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    body {
      min-height: 100vh;
      background:
        radial-gradient(1200px 600px at 15% -10%, rgba(124,249,208,0.06), transparent 60%),
        radial-gradient(900px 500px at 90% 10%, rgba(124,180,249,0.05), transparent 60%),
        var(--bg);
    }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 28px 80px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      width: 34px; height: 34px;
      border-radius: 9px;
      background: linear-gradient(135deg, #7cf9d0, #4a9eff);
      display: grid; place-items: center;
      color: #061014;
      font-weight: 800;
      font-size: 17px;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(124,249,208,0.15);
    }
    .brand-name { font-weight: 700; letter-spacing: 0.2px; }
    .brand-sub { color: var(--text-dim); font-size: 12px; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(124,249,208,0.08);
      color: var(--accent);
      border: 1px solid rgba(124,249,208,0.18);
      font-size: 12px;
      font-family: var(--mono);
    }
    .status-pill .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 4px rgba(124,249,208,0.15);
      animation: pulse 1.8s ease-in-out infinite;
    }
    .status-pill.offline {
      background: rgba(255,107,107,0.08);
      color: var(--danger);
      border-color: rgba(255,107,107,0.2);
    }
    .status-pill.offline .dot {
      background: var(--danger);
      box-shadow: 0 0 0 4px rgba(255,107,107,0.15);
      animation: none;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }

    /* Tabs */
    .tabs {
      display: inline-flex;
      gap: 4px;
      padding: 4px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 22px;
    }
    .tab {
      appearance: none;
      background: transparent;
      color: var(--text-dim);
      border: 0;
      padding: 8px 18px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab:hover { color: var(--text); }
    .tab.active {
      background: var(--bg-elev-2);
      color: var(--text);
      box-shadow: inset 0 0 0 1px var(--border-strong);
    }
    .panel[hidden] { display: none !important; }

    .grid {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: 18px;
    }
    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
    }

    .card {
      background: linear-gradient(180deg, var(--bg-elev) 0%, #0a0d12 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 22px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
    }
    .card h2 {
      margin: 0 0 14px;
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--text-dim);
      font-weight: 600;
    }
    .row { display: flex; align-items: center; gap: 10px; }
    .row + .row { margin-top: 10px; }

    .wallet-addr {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      font-family: var(--mono);
      font-size: 13px;
      word-break: break-all;
    }
    .wallet-addr .addr { flex: 1; color: var(--text); }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: transparent;
      color: var(--text-dim);
      border: 1px solid var(--border-strong);
      border-radius: 7px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:hover:not(:disabled) {
      color: var(--text);
      border-color: var(--accent-dim);
      background: rgba(124,249,208,0.04);
    }
    .btn.copied { color: var(--accent); border-color: var(--accent-dim); }
    .btn.primary {
      background: linear-gradient(135deg, #7cf9d0, #4a9eff);
      color: #061014;
      border-color: transparent;
      font-weight: 600;
      padding: 10px 16px;
      font-size: 13px;
    }
    .btn.primary:hover:not(:disabled) {
      color: #061014;
      filter: brightness(1.08);
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .hint {
      margin-top: 12px;
      color: var(--text-faint);
      font-size: 12px;
      line-height: 1.6;
    }
    .hint code {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-dim);
      background: var(--bg-elev-2);
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    .chain-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 5px;
      background: rgba(74,158,255,0.1);
      color: #7fb4ff;
      border: 1px solid rgba(74,158,255,0.2);
      font-size: 11px;
      font-family: var(--mono);
      margin-right: 6px;
    }

    .balance-main {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 4px 0 2px;
    }
    .balance-num {
      font-family: var(--mono);
      font-size: 40px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.01em;
      font-variant-numeric: tabular-nums;
    }
    .balance-unit { color: var(--text-dim); font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; }
    .balance-sub {
      color: var(--text-dim);
      font-size: 12.5px;
      font-family: var(--mono);
    }
    .balance-sub .sep { color: var(--text-faint); margin: 0 8px; }
    .empty-balance { color: var(--warn); }

    /* Provider form */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    @media (max-width: 700px) {
      .form-grid { grid-template-columns: 1fr; }
    }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label {
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-faint);
      font-weight: 600;
    }
    .field input,
    .field select,
    .field textarea {
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      font-family: var(--mono);
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .field input:focus,
    .field select:focus,
    .field textarea:focus {
      border-color: var(--accent-dim);
      box-shadow: 0 0 0 3px rgba(124,249,208,0.08);
    }
    .field textarea {
      min-height: 120px;
      resize: vertical;
    }
    .field .help {
      color: var(--text-faint);
      font-size: 11.5px;
    }
    .form-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 16px;
    }
    .form-status {
      flex: 1;
      min-height: 20px;
      font-size: 12.5px;
      font-family: var(--mono);
      color: var(--text-dim);
      word-break: break-word;
    }
    .form-status.ok { color: var(--accent); }
    .form-status.err { color: var(--danger); }
    .form-status.busy { color: var(--warn); }

    .earnings-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 16px;
    }
    @media (max-width: 700px) {
      .earnings-grid { grid-template-columns: 1fr; }
    }
    .earnings-block {
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .earnings-label {
      color: var(--text-faint);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .earnings-value {
      font-family: var(--mono);
      font-size: 22px;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .earnings-value .unit {
      color: var(--text-dim);
      font-size: 12px;
      margin-left: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    footer {
      margin-top: 32px;
      color: var(--text-faint);
      font-size: 11.5px;
      font-family: var(--mono);
      text-align: center;
    }
    footer a { color: var(--text-dim); text-decoration: none; }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">
        <div class="brand-mark">⚡</div>
        <div>
          <div class="brand-name">Aegis Network</div>
          <div class="brand-sub">Local Daemon Dashboard</div>
        </div>
      </div>
      <div class="status-pill" id="status">
        <span class="dot"></span>
        <span id="status-text">connecting…</span>
      </div>
    </header>

    <!-- ════════════════════════════════════════════════════════════ -->
    <!--  CONSUMER PANEL                                              -->
    <!-- ════════════════════════════════════════════════════════════ -->
    <!--                                                              -->
    <!-- The Provider tab (service registration, earnings, claim) is  -->
    <!-- gone: third-party providers can no longer register their own -->
    <!-- tools, and first-party (Hydra) services self-register with   -->
    <!-- the cloud Router on boot via POST /v1/hub/register. The      -->
    <!-- daemon's only job here is to mirror the user's Transit       -->
    <!-- Wallet + credit balance for funding.                         -->
    <section class="panel" id="panel-consumer" role="tabpanel">
      <div class="grid">
        <div class="card">
          <h2>Web3 Transit Wallet</h2>
          <div class="wallet-addr">
            <span class="addr" id="wallet-addr">—</span>
            <button class="btn" id="copy-btn" type="button">Copy</button>
          </div>
          <div class="hint">
            <span class="chain-badge">● Base</span>
            Send USDC to this address to auto-deposit. A 1% gas fee is applied before credits are issued.
          </div>
        </div>

        <div class="card">
          <h2>Credit Balance</h2>
          <div class="balance-main">
            <span class="balance-num" id="balance-num">—</span>
            <span class="balance-unit">credits</span>
          </div>
          <div class="balance-sub" id="balance-sub">
            fetching balance…
          </div>
        </div>
      </div>
    </section>

    <footer>
      aegis-cli · refresh to update · <a href="https://github.com/" target="_blank" rel="noreferrer">docs</a>
    </footer>
  </div>

  <script>
    // ════════════════════════════════════════════════════════════════
    //  Module-level state (initialized up-top, never re-created)
    // ════════════════════════════════════════════════════════════════
    const CREDITS_PER_USD = 10000;

    // ── helpers ────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const fmtNum = (n) =>
      (n == null || Number.isNaN(n)) ? "—" : Number(n).toLocaleString("en-US");
    const fmtUsd = (n) =>
      (n == null || Number.isNaN(n)) ? "—" : "$" + Number(n).toFixed(4);

    // ── copy wallet ────────────────────────────────────────────────
    const copyBtn = $("copy-btn");
    copyBtn.addEventListener("click", async () => {
      const addr = $("wallet-addr").textContent && $("wallet-addr").textContent.trim();
      if (!addr || addr === "—") return;
      try {
        await navigator.clipboard.writeText(addr);
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 1400);
      } catch (_) {
        /* noop */
      }
    });

    function setOnline(online, msg) {
      const pill = $("status");
      const txt = $("status-text");
      if (online) {
        pill.classList.remove("offline");
        txt.textContent = msg || "connected";
      } else {
        pill.classList.add("offline");
        txt.textContent = msg || "offline";
      }
    }

    // ════════════════════════════════════════════════════════════════
    //  Main polling loop
    // ════════════════════════════════════════════════════════════════
    //
    // Wrapped in a single try/catch so network blips and transient
    // errors never crash the script — the next tick will retry.
    async function tick() {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (!r.ok) throw new Error("status " + r.status);
        const s = await r.json();

        setOnline(
          true,
          s.router_online ? "connected · router live" : "connected · router offline"
        );

        $("wallet-addr").textContent = s.wallet || "—";

        if (s.credits == null) {
          $("balance-num").textContent = "—";
          $("balance-sub").textContent = s.balance_error || "router unreachable";
        } else {
          $("balance-num").textContent = fmtNum(s.credits);
          const sub = $("balance-sub");
          sub.classList.toggle("empty-balance", s.credits === 0);
          const pieces = [];
          if (s.usd_value != null) pieces.push(fmtUsd(s.usd_value));
          if (s.scrapes_remaining != null)
            pieces.push(fmtNum(s.scrapes_remaining) + " scrapes left");
          sub.textContent = pieces.join(" · ") || "—";
        }
      } catch (err) {
        setOnline(false, "daemon unreachable");
      }
    }

    function loop() {
      tick().finally(() => setTimeout(loop, 2000));
    }
    loop();
  </script>
</body>
</html>
`;
