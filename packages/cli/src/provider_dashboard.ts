// Served verbatim at GET / on the local daemon.
// Keep this self-contained — no external scripts, no build step.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Aegis · Provider Dashboard</title>
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
      max-width: 860px;
      margin: 0 auto;
      padding: 32px 28px 80px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
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

    .card {
      background: linear-gradient(180deg, var(--bg-elev) 0%, #0a0d12 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 22px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
      margin-bottom: 24px;
    }
    .card h2 {
      margin: 0 0 14px;
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--text-dim);
      font-weight: 600;
    }

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
          <div class="brand-sub">Provider Control Panel</div>
        </div>
      </div>
      <div class="status-pill" id="status">
        <span class="dot"></span>
        <span id="status-text">connecting…</span>
      </div>
    </header>

    <div class="card">
      <h2>Web3 Identity</h2>
      <div class="wallet-addr">
        <span class="addr" id="wallet-addr">—</span>
        <button class="btn" id="copy-btn" type="button">Copy</button>
      </div>
      <div class="hint">
        <span class="chain-badge">● Master Key</span>
        Your local Aegis Wallet (<code>~/.aegis/identity.json</code>) securely signs registry updates and claims payouts. Back it up to retain ownership of your services.
      </div>
    </div>

    <div class="card">
      <h2>Register a Service</h2>
      <form id="provider-form" autocomplete="off">
        <div class="form-grid">
          <div class="field">
            <label for="f-id">Service ID</label>
            <input id="f-id" name="id" type="text" placeholder="my-api" spellcheck="false" required />
            <span class="help">Unique, 2-64 chars. Letters, digits, dashes, underscores.</span>
          </div>
          <div class="field">
            <label for="f-endpoint">Endpoint URL</label>
            <input id="f-endpoint" name="endpoint_url" type="text" placeholder="https://api.example.com/run" spellcheck="false" required />
            <span class="help">We POST the sample request here with your secret.</span>
          </div>
          <div class="field full">
            <label for="f-owner">Owner &amp; Payout Wallet</label>
            <input id="f-owner" type="text" readonly tabindex="-1" placeholder="—" spellcheck="false" />
            <span class="help">Auto-filled from <code>identity.json</code>.</span>
          </div>
          <div class="field">
            <label for="f-pricing">Pricing</label>
            <select id="f-pricing" name="pricing_type" required>
              <option value="FIXED">FIXED</option>
              <option value="DYNAMIC">DYNAMIC</option>
            </select>
            <span class="help">FIXED charges a flat credit cost per call.</span>
          </div>
          <div class="field" id="field-cost">
            <label for="f-cost">Fixed Cost (credits)</label>
            <input id="f-cost" name="fixed_cost" type="number" min="1" step="1" placeholder="e.g. 250" />
            <span class="help">100 credits = $0.01 USD.</span>
          </div>
          <div class="field full">
            <label for="f-secret">Provider Secret (Bearer token)</label>
            <input id="f-secret" name="secret" type="password" placeholder="Bearer token your endpoint expects" spellcheck="false" required />
            <span class="help">Sent as <code>Authorization: Bearer</code> to your endpoint. Stored encrypted on the router.</span>
          </div>
          <div class="field full">
            <label for="f-sample">Sample Request (JSON)</label>
            <textarea id="f-sample" name="sample_request" spellcheck="false" required>{ "hello": "world" }</textarea>
            <span class="help">We fire this against your endpoint to verify connectivity before registering.</span>
          </div>
          <div class="field full">
            <label for="f-description">Description</label>
            <textarea id="f-description" name="description" spellcheck="true" placeholder="One sentence an LLM can read to decide if this tool fits the task.">Scrapes a website URL and extracts the core article text as clean Markdown. Use this when you need to read the contents of a webpage.</textarea>
            <span class="help">Shown verbatim in the public agent catalog. Keep it short and capability-focused.</span>
          </div>
          <div class="field full">
            <label for="f-schema">Expected Schema (JSON)</label>
            <textarea id="f-schema" name="expected_schema" spellcheck="false" placeholder='{ "type": "object", "properties": { ... }, "required": [ ... ] }'>{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The URL of the webpage to scrape"
    }
  },
  "required": ["url"],
  "additionalProperties": false
}</textarea>
            <span class="help">JSON-Schema-style object describing your request body.</span>
          </div>
        </div>
        <div class="form-actions">
          <button id="register-btn" class="btn primary" type="submit">Test &amp; Register</button>
          <span id="register-status" class="form-status">Fill out the form, then press Register. We test your endpoint locally first.</span>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Earnings · <span id="earnings-id" style="color: var(--text); text-transform: none; letter-spacing: 0;">—</span></h2>
      <div class="earnings-grid">
        <div class="earnings-block">
          <div class="earnings-label">Pending</div>
          <div class="earnings-value"><span id="earn-pending">—</span><span class="unit" id="earn-pending-usd"></span></div>
        </div>
        <div class="earnings-block">
          <div class="earnings-label">Total Earned</div>
          <div class="earnings-value"><span id="earn-total">—</span><span class="unit" id="earn-total-usd"></span></div>
        </div>
      </div>
      <div class="form-actions">
        <button id="claim-btn" class="btn primary" type="button" disabled>Claim</button>
        <span id="claim-status" class="form-status">Claim requires a pending balance of at least 100,000 credits ($10).</span>
      </div>
    </div>

    <footer>
      aegis-cli · refresh to update · <a href="https://github.com/" target="_blank" rel="noreferrer">docs</a>
    </footer>
  </div>

  <script>
    const keystoreCache = Object.create(null);
    const busyState = { register: false, claim: false };
    let lastStatsId = "";

    const MIN_CLAIM_CREDITS = 100000;
    const CREDITS_PER_USD = 10000;

    const $ = (id) => document.getElementById(id);

    function safeStringify(obj) {
      try {
        return JSON.stringify(obj);
      } catch (err) {
        try {
          return "[unstringifiable: " + (err && err.message) + "]";
        } catch (_) {
          return "[unstringifiable]";
        }
      }
    }

    function safeSetValue(el, val) {
      if (!el) return;
      if (document.activeElement === el) return;
      if (typeof val !== "string") val = val == null ? "" : String(val);
      if (el.value !== val) el.value = val;
    }

    const fmtNum = (n) =>
      (n == null || Number.isNaN(n)) ? "—" : Number(n).toLocaleString("en-US");
    const fmtUsd = (n) =>
      (n == null || Number.isNaN(n)) ? "—" : "$" + Number(n).toFixed(4);
    const creditsToUsd = (c) =>
      typeof c === "number" && Number.isFinite(c) ? c / CREDITS_PER_USD : null;

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
      } catch (_) {}
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

    const pricingEl = $("f-pricing");
    const costFieldEl = $("field-cost");
    const costInputEl = $("f-cost");

    function syncCostVisibility() {
      const isFixed = pricingEl.value === "FIXED";
      costFieldEl.style.display = isFixed ? "" : "none";
      if (!isFixed) costInputEl.value = "";
    }
    pricingEl.addEventListener("change", syncCostVisibility);
    syncCostVisibility();

    function setStatus(el, cls, msg) {
      el.className = "form-status" + (cls ? " " + cls : "");
      el.textContent = msg;
    }

    const form = $("provider-form");
    const registerBtn = $("register-btn");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (busyState.register) return;

      const id = $("f-id").value.trim();
      const endpoint_url = $("f-endpoint").value.trim();
      const pricing_type = pricingEl.value;
      const secret = $("f-secret").value;
      const rawSample = $("f-sample").value;
      const rawDescription = $("f-description") ? $("f-description").value : "";
      const rawSchema = $("f-schema") ? $("f-schema").value : "";

      if (!id || !endpoint_url || !secret) {
        setStatus($("register-status"), "err", "Fill in every field.");
        return;
      }

      let fixed_cost = null;
      if (pricing_type === "FIXED") {
        const n = Number(costInputEl.value);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          setStatus($("register-status"), "err", "Fixed Cost must be a positive integer.");
          return;
        }
        fixed_cost = n;
      }

      let sample_request;
      try {
        sample_request = JSON.parse(rawSample);
      } catch (err) {
        setStatus($("register-status"), "err", "Sample Request is not valid JSON.");
        return;
      }
      if (!sample_request || typeof sample_request !== "object" || Array.isArray(sample_request)) {
        setStatus($("register-status"), "err", "Sample Request must be a JSON object.");
        return;
      }

      const description = rawDescription.trim() ? rawDescription.trim() : undefined;

      let expected_schema;
      if (rawSchema && rawSchema.trim()) {
        try {
          expected_schema = JSON.parse(rawSchema);
        } catch (err) {
          setStatus($("register-status"), "err", "Expected Schema is not valid JSON.");
          return;
        }
        if (
          !expected_schema ||
          typeof expected_schema !== "object" ||
          Array.isArray(expected_schema)
        ) {
          setStatus($("register-status"), "err", "Expected Schema must be a JSON object.");
          return;
        }
      }

      busyState.register = true;
      registerBtn.disabled = true;
      setStatus($("register-status"), "busy", "Testing your endpoint…");

      try {
        const r = await fetch("/api/provider/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: safeStringify({
            id,
            endpoint_url,
            pricing_type,
            fixed_cost,
            secret,
            sample_request,
            ...(description !== undefined ? { description } : {}),
            ...(expected_schema !== undefined ? { expected_schema } : {}),
          }),
        });
        const body = await r.json().catch(() => ({}));

        if (!r.ok) {
          const detail = body && (body.message || body.error) || ("HTTP " + r.status);
          const stage = body && body.stage ? " (" + body.stage + ")" : "";
          setStatus($("register-status"), "err", "✗ " + detail + stage);
          return;
        }

        const verb = body.method === "PUT" || body.updated ? "Updated" : "Registered";
        setStatus(
          $("register-status"),
          "ok",
          "✓ " + verb + " " + id + " as owner. Earnings card is now live."
        );
        lastStatsId = id;
        pollProviderStats();
      } catch (err) {
        setStatus($("register-status"), "err", "Network error: " + (err && err.message || err));
      } finally {
        busyState.register = false;
        registerBtn.disabled = false;
      }
    });

    const claimBtn = $("claim-btn");
    const idInput = $("f-id");

    idInput.addEventListener("input", () => {
      const v = idInput.value.trim();
      $("earnings-id").textContent = v || "—";
      if (v) pollProviderStats();
      else resetEarnings();
    });

    function resetEarnings() {
      $("earn-pending").textContent = "—";
      $("earn-pending-usd").textContent = "";
      $("earn-total").textContent = "—";
      $("earn-total-usd").textContent = "";
      claimBtn.disabled = true;
    }
    resetEarnings();

    async function pollProviderStats() {
      const id = idInput.value.trim();
      if (!id) return;

      try {
        const r = await fetch("/api/provider/stats/" + encodeURIComponent(id), {
          cache: "no-store",
        });
        if (r.status === 404) {
          keystoreCache[id] = null;
          if (idInput.value.trim() === id) {
            $("earnings-id").textContent = id;
            $("earn-pending").textContent = "0";
            $("earn-pending-usd").textContent = "$0.00";
            $("earn-total").textContent = "0";
            $("earn-total-usd").textContent = "$0.00";
            claimBtn.disabled = true;
            setStatus($("claim-status"), "", "Service not registered yet.");
          }
          return;
        }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (idInput.value.trim() === id) {
            setStatus($("claim-status"), "err", "Stats unavailable: " + (body && (body.message || body.error) || r.status));
          }
          return;
        }

        keystoreCache[id] = body;
        if (idInput.value.trim() !== id) return;

        const earnings = (body && body.earnings) || {};
        const pending = typeof earnings.pending_balance === "number" ? earnings.pending_balance : 0;
        const total = typeof earnings.total_earned === "number" ? earnings.total_earned : 0;

        $("earnings-id").textContent = id;
        $("earn-pending").textContent = fmtNum(pending);
        $("earn-pending-usd").textContent = fmtUsd(creditsToUsd(pending));
        $("earn-total").textContent = fmtNum(total);
        $("earn-total-usd").textContent = fmtUsd(creditsToUsd(total));

        const isOwner = !!body.is_owner;
        const canClaim = isOwner && pending > MIN_CLAIM_CREDITS;
        claimBtn.disabled = busyState.claim || !canClaim;

        if (!isOwner) {
          const actual = (body && body.service && body.service.provider_wallet) || "another wallet";
          setStatus(
            $("claim-status"),
            "",
            "This service is owned by " + actual + ". Run the daemon with that identity.json to claim."
          );
        } else if (pending <= MIN_CLAIM_CREDITS) {
          const need = MIN_CLAIM_CREDITS - pending;
          setStatus($("claim-status"), "", "Need " + fmtNum(need + 1) + " more credits to claim (" + fmtUsd(creditsToUsd(need + 1)) + ").");
        } else if (!busyState.claim) {
          setStatus($("claim-status"), "ok", "Ready to claim " + fmtNum(pending) + " credits (" + fmtUsd(creditsToUsd(pending)) + ").");
        }
      } catch (err) {
        /* swallow — tick will retry */
      }
    }

    claimBtn.addEventListener("click", async () => {
      if (busyState.claim) return;
      const id = idInput.value.trim();
      if (!id) return;
      busyState.claim = true;
      claimBtn.disabled = true;
      setStatus($("claim-status"), "busy", "Sweeping on-chain…");
      try {
        const r = await fetch("/api/provider/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: safeStringify({ id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus(
            $("claim-status"),
            "err",
            "✗ " + (body && (body.message || body.error) || ("HTTP " + r.status))
          );
          return;
        }
        const credits = body && body.credits_claimed;
        const tx = body && body.tx_hash;
        setStatus(
          $("claim-status"),
          "ok",
          "✓ Claimed " + fmtNum(credits) + " credits" + (tx ? " (tx " + String(tx).slice(0, 10) + "…)" : "")
        );
        pollProviderStats();
      } catch (err) {
        setStatus($("claim-status"), "err", "Network error: " + (err && err.message || err));
      } finally {
        busyState.claim = false;
        pollProviderStats();
      }
    });

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
        safeSetValue($("f-owner"), s.wallet || "");

      } catch (err) {
        setOnline(false, "daemon unreachable");
      }

      try {
        await pollProviderStats();
      } catch (err) {}
    }

    function loop() {
      tick().finally(() => setTimeout(loop, 2000));
    }
    loop();
  </script>
</body>
</html>
`;
